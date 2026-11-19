// TO Graphics: everything that touches the open Premiere project.
//  - add a template to the timeline at the playhead
//  - make preview thumbnails (Premiere renders a real frame of each template)
//  - find where a template is used in the project, and swap in its new version
//    (same place, same length, same track, with the text and settings copied across)

(function () {
  const ppro = require("premierepro");
  const { storage } = require("uxp");
  const L = window.TOLib;
  const log = [];
  const note = (s) => { log.push(new Date().toISOString().slice(11, 19) + " " + s); if (log.length > 400) log.shift(); };

  async function activeProject() {
    const p = await ppro.Project.getActiveProject();
    if (!p) throw new Error("Open a project first.");
    return p;
  }

  function runTransaction(project, undoName, build) {
    let ok = false;
    project.lockedAccess(() => {
      ok = project.executeTransaction((compound) => {
        for (const action of build()) if (action) compound.addAction(action);
      }, undoName);
    });
    if (!ok) throw new Error(`Premiere rejected: ${undoName}`);
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const T = (s) => ppro.TickTime.createWithSeconds(Math.max(0, s));

  // insertMogrtFromPath, inside lockedAccess as Adobe's sample does it.
  function insertMogrt(project, seq, path, atSeconds, vTrack) {
    let items = [];
    const editor = ppro.SequenceEditor.getEditor(seq);
    project.lockedAccess(() => {
      items = editor.insertMogrtFromPath(path, typeof atSeconds === "number" ? T(atSeconds) : atSeconds, vTrack, 0) || [];
    });
    return items;
  }

  async function videoClips(seq) {
    const out = [];
    const n = await seq.getVideoTrackCount();
    for (let i = 0; i < n; i++) {
      const track = await seq.getVideoTrack(i);
      if (!track) continue;
      const items = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
      for (const ti of items) out.push({ ti, track: i });
    }
    return { clips: out, count: n };
  }

  // ---------- add to the timeline ----------
  // At the playhead, on the first empty track above everything under the playhead.
  async function addToTimeline(key) {
    const project = await activeProject();
    const seq = await project.getActiveSequence();
    if (!seq) throw new Error("Open a sequence first.");
    const at = await seq.getPlayerPosition();
    const t = at.seconds;
    const { clips, count } = await videoClips(seq);
    let top = -1;
    for (const { ti, track } of clips) {
      const s = (await ti.getStartTime()).seconds, e = (await ti.getEndTime()).seconds;
      if (s <= t + 1e-6 && e > t + 1e-6) top = Math.max(top, track);
    }
    const want = Math.max(1, top + 1);
    const path = L.pathOf(key);
    note(`add ${key} at ${t.toFixed(2)}s on V${want + 1} (tracks: ${count})`);
    let items = [];
    try { items = insertMogrt(project, seq, path, at, want); } catch (e) { note("insert threw " + e); }
    if (!items.length && want >= count) {
      // Premiere may not make a new track for graphics: use the top one instead.
      try { items = insertMogrt(project, seq, path, at, Math.max(0, count - 1)); } catch (e) { note("retry threw " + e); }
    }
    if (!items.length) throw new Error("Premiere didn't add it. Is the sequence locked?");
    return { track: want + 1 };
  }

  // ---------- previews ----------
  // A scratch sequence the size of each template: the template goes in, Premiere renders a
  // few frames, the busiest one is kept, and everything made along the way is removed again.
  const SCRATCH = "TO Graphics previews (deleted automatically)";

  // The bin behind a project item, or null. (ProjectItemType only exists from Premiere 27.)
  function binOf(it) {
    try {
      const T = ppro.Constants.ProjectItemType;
      if (T && T.BIN !== undefined && it.type !== undefined && it.type !== T.BIN) return null;
      return ppro.FolderItem.cast(it) || null;
    } catch (e) { return null; }
  }

  async function itemIds(folder, out, depth) {
    out = out || new Set();
    let items = [];
    try { items = await folder.getItems(); } catch (e) { return out; }
    for (const it of items) {
      try { out.add(ppro.ProjectItem.cast(it).getId()); } catch (e) {}
      if (depth > 0) {
        const f = binOf(it);
        if (f) await itemIds(f, out, depth - 1);
      }
    }
    return out;
  }
  // Removes project items that weren't there before (the scratch sequence, and any bin or
  // graphic item Premiere made for the templates).
  async function removeNewItems(project, before) {
    const root = await project.getRootItem();
    const kill = [];
    const walk = async (folder, depth) => {
      let items = [];
      try { items = await folder.getItems(); } catch (e) { return; }
      for (const it of items) {
        let id = ""; try { id = ppro.ProjectItem.cast(it).getId(); } catch (e) {}
        if (id && !before.has(id)) { kill.push({ folder, it }); continue; }
        const f = depth > 0 ? binOf(it) : null;
        if (f) await walk(f, depth - 1);
      }
    };
    await walk(root, 2);
    if (!kill.length) return 0;
    try { runTransaction(project, "Tidy up TO Graphics previews", () => kill.map(({ folder, it }) => folder.createRemoveItemAction(it))); }
    catch (e) { note("tidy failed " + e); }
    return kill.length;
  }

  async function exists(path) { const e = await L.entryAt(path); return !!(e && !e.isFolder); }
  async function sizeOf(path) {
    const e = await L.entryAt(path);
    if (!e) return 0;
    try { return (await e.getMetadata()).size || 0; } catch (err) { return 0; }
  }
  async function landed(path, tries) {
    for (let i = 0; i < (tries || 16); i++) { if (await exists(path)) return true; await wait(250); }
    return false;
  }

  async function setFrameSize(project, seq, w, h) {
    const settings = await seq.getSettings();
    const rect = await settings.getVideoFrameRect();
    rect.width = w; rect.height = h;
    await settings.setVideoFrameRect(rect);
    try { const pr = await settings.getPreviewFrameRect(); pr.width = w; pr.height = h; await settings.setPreviewFrameRect(pr); } catch (e) {}
    runTransaction(project, "Size TO Graphics preview sequence", () => [seq.createSetSettingsAction(settings)]);
  }

  async function removeTrackItems(project, seq, items) {
    if (!items.length) return;
    const editor = ppro.SequenceEditor.getEditor(seq);
    project.lockedAccess(() => {
      project.executeTransaction((compound) => {
        ppro.TrackItemSelection.createEmptySelection((sel) => {
          for (const ti of items) sel.addItem(ti, true);
          compound.addAction(editor.createRemoveItemsAction(sel, false, ppro.Constants.MediaType.ANY, false));
        });
      }, "Remove graphic");
    });
  }

  // keys: templates to make previews for. onEach(key, ok) after each one.
  async function makePreviews(keys, onEach) {
    const project = await activeProject();
    const thumbs = await L.thumbsFolder();
    const dir = thumbs.nativePath;
    const before = await itemIds(await project.getRootItem(), null, 2);
    const prevActive = await project.getActiveSequence();
    let scratch = null, curSize = "";
    let done = 0;
    try {
      scratch = await project.createSequence(SCRATCH);
      if (!scratch) throw new Error("Premiere didn't make the preview sequence.");
      for (const key of keys) {
        const it = L.lib.items[key];
        if (!it) continue;
        let ok = false;
        try {
          const w = it.w || 1920, h = it.h || 1080;
          if (curSize !== w + "x" + h) { await setFrameSize(project, scratch, w, h); curSize = w + "x" + h; }
          const placed = insertMogrt(project, scratch, L.pathOf(key), 0, 0);
          if (!placed.length) throw new Error("insert gave nothing");
          // Give After Effects a moment to load the template before the first frame.
          await wait(900);
          const dur = it.dur || 5;
          // Small previews: about 360px on the long side.
          const scale = 360 / Math.max(w, h);
          const pw = Math.max(2, Math.round(w * scale / 2) * 2), ph = Math.max(2, Math.round(h * scale / 2) * 2);
          const base = "t" + hash(key);
          const made = [];
          let best = null, bestScore = -1, offlineSeen = false, lastRed = null;
          const points = it.thumbAt ? [it.thumbAt] : [0.5, 0.75, 0.3];
          for (let i = 0; i < points.length; i++) {
            const at = T(Math.min(dur - 0.05, dur * points[i]));
            // Premiere shows a red Media Offline frame until the template has loaded: if that's
            // what came back (or a blank frame on the first tries), wait longer and render again.
            for (let tryN = 0; tryN < 7; tryN++) {
              const name = `${base}_${i}_${tryN}.png`, full = dir.replace(/[\/\\]+$/, "") + "/" + name;
              let r = false;
              try { r = await ppro.Exporter.exportSequenceFrame(scratch, at, name, dir, pw, ph); } catch (e) { note("frame threw " + e); }
              if (!(await landed(full, 8))) { try { r = await ppro.Exporter.exportSequenceFrame(scratch, at, full, dir, pw, ph); } catch (e) {} }
              if (!(await landed(full, 20))) { note(`no frame for ${key} at ${points[i]} (${r})`); break; }
              made.push(name);
              await wait(150);
              let look = null;
              try { look = window.TOPixels.analyse(await (await thumbs.getEntry(name)).read({ format: storage.formats.binary })); } catch (e) {}
              if (look && look.offline) { offlineSeen = true; lastRed = name; note(`${key}: offline frame, waiting (try ${tryN + 1})`); await wait(800 + tryN * 700); continue; }
              if (look && look.blank && tryN < 2) { await wait(800); continue; }
              const score = look ? look.score : await sizeOf(full) / 1000;
              if (score > bestScore) { bestScore = score; best = name; }
              break;
            }
          }
          // Still red after all that: it may just be a red template, so keep the frame anyway.
          if (!best && lastRed) { best = lastRed; note(`${key}: kept a mostly-red frame (red template, or still offline)`); }
          await removeTrackItems(project, scratch, placed);
          it.previewTried = it.mtime;
          if (best) {
            // Keep the chosen one as <base>.png, delete the others.
            const final = `${base}.png`;
            const data = await (await thumbs.getEntry(best)).read({ format: storage.formats.binary });
            const out = await thumbs.createFile(final, { overwrite: true });
            await out.write(data, { format: storage.formats.binary });
            for (const n of made) { try { await (await thumbs.getEntry(n)).delete(); } catch (e) {} }
            if (it.thumb && it.thumb !== final) { try { await (await thumbs.getEntry(it.thumb)).delete(); } catch (e) {} }
            it.thumb = final;
            it.thumbFor = it.mtime;
            it.thumbV = (it.thumbV || 0) + 1;
            ok = true;
            done++;
          } else {
            for (const n of made) { try { await (await thumbs.getEntry(n)).delete(); } catch (e) {} }
            if (offlineSeen) note(`${key}: still Media Offline after waiting, no preview kept`);
          }
        } catch (e) { note(`preview ${key}: ${e && e.message ? e.message : e}`); }
        L.save();
        if (onEach) onEach(key, ok);
      }
    } finally {
      if (prevActive) { try { await project.setActiveSequence(prevActive); } catch (e) {} }
      if (scratch) {
        if (prevActive) { try { await project.closeSequence(scratch); } catch (e) {} }
        let deleted = false;
        try { deleted = await project.deleteSequence(scratch); } catch (e) {}
        if (!deleted) note("deleteSequence failed, tidying by hand");
      }
      await removeNewItems(project, before);
    }
    return done;
  }
  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  }

  // ---------- finding uses ----------
  // A graphic on the timeline carries the template's name. If the template has controls,
  // at least one of them must match too, so a renamed video clip doesn't count.
  async function componentsOf(ti) {
    const out = [];
    try {
      const chain = await ti.getComponentChain();
      const n = chain.getComponentCount();
      for (let i = 0; i < n; i++) {
        const c = chain.getComponentAtIndex(i);
        let match = "", disp = "";
        try { match = await c.getMatchName(); } catch (e) {}
        try { disp = await c.getDisplayName(); } catch (e) {}
        out.push({ c, match, disp });
      }
    } catch (e) {}
    return out;
  }
  function paramNames(c) {
    const names = [];
    let n = 0; try { n = c.getParamCount(); } catch (e) {}
    for (let i = 0; i < n; i++) { try { names.push(c.getParam(i).displayName); } catch (e) {} }
    return names;
  }

  async function isUseOf(ti, it) {
    let name = "";
    try { name = await ti.getName(); } catch (e) {}
    let pname = "";
    try { const pi = await ti.getProjectItem(); pname = pi ? pi.name : ""; } catch (e) {}
    const want = (it.name || "").toLowerCase();
    if (!want || (name.toLowerCase() !== want && pname.toLowerCase() !== want)) return false;
    if (!it.controls || !it.controls.length) return true;
    const comps = await componentsOf(ti);
    const all = new Set();
    for (const { c } of comps) for (const n of paramNames(c)) all.add(n);
    return it.controls.some((n) => all.has(n));
  }

  // Every use of these templates in the open project: [{ key, seq, ti, track, start, end }]
  async function findUses(keys, onlyActive) {
    const project = await activeProject();
    let seqs = [];
    if (onlyActive) { const s = await project.getActiveSequence(); if (s) seqs = [s]; }
    else seqs = await project.getSequences();
    const want = keys.map((k) => [k, L.lib.items[k]]).filter(([, it]) => it && it.name);
    const out = [];
    for (const seq of seqs) {
      if (seq.name === SCRATCH) continue;
      const { clips } = await videoClips(seq);
      for (const { ti, track } of clips) {
        for (const [key, it] of want) {
          if (await isUseOf(ti, it)) {
            out.push({ key, seq, ti, track, start: await ti.getStartTime(), end: await ti.getEndTime() });
            break;
          }
        }
      }
    }
    return out;
  }

  // ---------- swapping in a new version ----------
  // Reads every setting of the old graphic (text, numbers, checkboxes, colours, and its
  // Motion/Opacity), removes it, places the new version in exactly the same spot and length,
  // then puts the settings back where the new version has a control with the same name.
  async function readParams(ti) {
    const out = [];
    const comps = await componentsOf(ti);
    const seen = {};
    for (const { c, match } of comps) {
      const nth = (seen[match] = (seen[match] || 0) + 1);
      let n = 0; try { n = c.getParamCount(); } catch (e) {}
      for (let i = 0; i < n; i++) {
        let p = null; try { p = c.getParam(i); } catch (e) { continue; }
        const name = p.displayName;
        if (!name) continue;
        let varying = false; try { varying = !!p.isTimeVarying(); } catch (e) {}
        if (varying) { out.push({ match, nth, name, varying: true }); continue; }
        let v = null; try { v = await p.getStartValue(); } catch (e) { continue; }
        if (v === null || v === undefined) continue;
        out.push({ match, nth, name, v });
      }
    }
    return out;
  }

  function keyframeFor(p, v) {
    // MogrtText / Color / MogrtComment objects go in as they are; plain keyframes by value.
    const tries = [];
    if (v && typeof v === "object" && "value" in v) {
      const inner = v.value;
      tries.push(inner);
      if (inner && typeof inner === "object" && "value" in inner) tries.push(inner.value);
    }
    tries.push(v);
    for (const x of tries) { try { const k = p.createKeyframe(x); if (k) return k; } catch (e) {} }
    return null;
  }

  async function writeParams(project, ti, saved) {
    const comps = await componentsOf(ti);
    const seen = {};
    const actions = [];
    let copied = 0, skipped = 0, animated = 0;
    const byKey = new Map(saved.map((s) => [`${s.match}#${s.nth}#${s.name}`, s]));
    for (const { c, match } of comps) {
      const nth = (seen[match] = (seen[match] || 0) + 1);
      let n = 0; try { n = c.getParamCount(); } catch (e) {}
      for (let i = 0; i < n; i++) {
        let p = null; try { p = c.getParam(i); } catch (e) { continue; }
        const s = byKey.get(`${match}#${nth}#${p.displayName}`);
        if (!s) continue;
        if (s.varying) { animated++; continue; }
        const k = keyframeFor(p, s.v);
        if (!k) { skipped++; continue; }
        try { actions.push(p.createSetValueAction(k, true)); copied++; } catch (e) { skipped++; }
      }
    }
    if (actions.length) {
      try { runTransaction(project, "Copy settings to new graphic", () => actions); }
      catch (e) {
        // One bad value spoils the batch: try them one by one.
        copied = 0;
        for (const a of actions) { try { runTransaction(project, "Copy setting", () => [a]); copied++; } catch (e2) { skipped++; } }
      }
    }
    return { copied, skipped, animated };
  }

  // Snapshot of where the other clips on a track start, to spot an insert that shoved them along.
  async function trackStarts(seq, trackIdx) {
    const track = await seq.getVideoTrack(trackIdx);
    const m = [];
    for (const ti of await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)) {
      m.push({ ti, s: (await ti.getStartTime()).seconds });
    }
    return m;
  }

  async function swapOne(project, use) {
    const { seq, ti, track, key } = use;
    const start = use.start, end = use.end;
    const saved = await readParams(ti);
    const before = await trackStarts(seq, track);
    const others = before.filter((x) => x.s > start.seconds + 1e-4);
    const it = L.lib.items[key] || {};
    const nextStart = others.length ? Math.min(...others.map((x) => x.s)) : Infinity;
    const roomy = nextStart >= start.seconds + (it.dur || 0) - 1e-3;
    // 1) remove the old one (no ripple)
    await removeTrackItems(project, seq, [ti]);
    if (!roomy) {
      // The new version's default length would run into the next clip on this track, so it's
      // placed on a spare track above, trimmed, then copied down into the gap and removed.
      const viaTop = await swapViaTop(project, seq, key, start, end, track);
      if (viaTop) {
        const res = await writeParams(project, viaTop, saved);
        note(`swapped ${key} via top track: ${res.copied} copied`);
        return res;
      }
      note("top-track route failed, placing directly");
    }
    // 2) place the new version where it was
    const placed = insertMogrt(project, seq, L.pathOf(key), start, track);
    const fresh = placed.find((x) => { try { return x.getTrackIndex !== undefined; } catch (e) { return false; } }) || placed[0];
    if (!fresh) throw new Error("Premiere didn't place the new version");
    // 3) if Premiere pushed later clips along, move them back
    const fixes = [];
    for (const o of others) {
      let now = o.s; try { now = (await o.ti.getStartTime()).seconds; } catch (e) {}
      const shift = now - o.s;
      if (Math.abs(shift) > 1e-3) fixes.push({ ti: o.ti, shift });
    }
    // 4) same length as before
    let newItem = fresh;
    try {
      const all = await trackStarts(seq, track);
      const hit = all.find((x) => Math.abs(x.s - start.seconds) < 1e-3);
      if (hit) newItem = hit.ti;
    } catch (e) {}
    try { runTransaction(project, "Match graphic length", () => [newItem.createSetEndAction(end)]); }
    catch (e) { note("set end failed " + e); }
    if (fixes.length) {
      note(`moved back ${fixes.length} clips`);
      try { runTransaction(project, "Put clips back", () => fixes.map((f) => f.ti.createMoveAction(ppro.TickTime.createWithSeconds(-f.shift)))); }
      catch (e) { note("move back failed " + e); }
    }
    // 5) settings across
    const res = await writeParams(project, newItem, saved);
    note(`swapped ${key} in ${seq.name} V${track + 1} at ${start.seconds.toFixed(2)}s: ${res.copied} copied, ${res.skipped} skipped, ${res.animated} animated`);
    return res;
  }

  async function swapViaTop(project, seq, key, start, end, track) {
    try {
      const count = await seq.getVideoTrackCount();
      const placed = insertMogrt(project, seq, L.pathOf(key), start, count);
      const tmp = placed[0];
      if (!tmp) return null;
      let tmpTrack = count;
      try { tmpTrack = await tmp.getTrackIndex(); } catch (e) {}
      if (tmpTrack === track) return null;
      runTransaction(project, "Match graphic length", () => [tmp.createSetEndAction(end)]);
      const editor = ppro.SequenceEditor.getEditor(seq);
      runTransaction(project, "Place new graphic", () => [editor.createCloneTrackItemAction(tmp, T(0), track - tmpTrack, 0, true, false)]);
      await removeTrackItems(project, seq, [tmp]);
      const all = await trackStarts(seq, track);
      const hit = all.find((x) => Math.abs(x.s - start.seconds) < 1e-3);
      return hit ? hit.ti : null;
    } catch (e) { note("via top failed " + e); return null; }
  }

  async function swapUses(uses, onEach) {
    const project = await activeProject();
    const sum = { done: 0, failed: 0, copied: 0, skipped: 0, animated: 0 };
    for (const u of uses) {
      try {
        const r = await swapOne(project, u);
        sum.done++; sum.copied += r.copied; sum.skipped += r.skipped; sum.animated += r.animated;
      } catch (e) { sum.failed++; note("swap failed " + (e && e.message ? e.message : e)); }
      if (onEach) onEach(u);
    }
    return sum;
  }

  window.TOPremiere = { addToTimeline, makePreviews, findUses, swapUses, log, SCRATCH };
})();
