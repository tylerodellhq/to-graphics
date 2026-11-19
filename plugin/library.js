// TO Graphics: the template library.
// Reads the .mogrt files in Premiere's own local templates folder (the one the Essential Graphics
// panel calls "Local Templates"), so Premiere's built-in templates never show here.
// Everything the panel knows about each template (client, types, hidden, favourite, preview
// frame) is kept in "<templates folder>/.to-graphics/library.json", next to the templates
// themselves, so it survives plugin updates and reinstalls. Previews live in ".to-graphics/thumbs".

(function () {
  const ppro = require("premierepro");
  const { storage } = require("uxp");
  const lfs = storage.localFileSystem;
  const fflate = window.fflate || require("./lib/fflate.js");

  const DATA_DIR = ".to-graphics";
  const LIB_FILE = "library.json";

  // ---------- paths ----------
  // A folder or file as file: URLs UXP will accept, on Mac and Windows alike (same as HQ).
  function fileUrls(dir) {
    const fwd = String(dir).replace(/\\/g, "/");
    const esc = (p) => encodeURI(p).replace(/#/g, "%23").replace(/\?/g, "%3F");
    if (/^[A-Za-z]:\//.test(fwd)) return ["file:/" + fwd, "file:///" + fwd, "file:/" + esc(fwd), "file:///" + esc(fwd)];
    if (fwd.startsWith("//")) return ["file:" + fwd, "file:" + esc(fwd), "file:////" + fwd.slice(2)];
    return ["file:" + fwd, "file://" + fwd, "file:" + esc(fwd), "file://" + esc(fwd)];
  }
  async function entryAt(path) {
    for (const url of fileUrls(path)) {
      try { const e = await lfs.getEntryWithUrl(url); if (e) return e; } catch (e) {}
    }
    return null;
  }
  async function subFolder(folder, name) {
    try { const e = await folder.getEntry(name); if (e && e.isFolder) return e; } catch (e) {}
    return folder.createFolder(name);
  }

  // Premiere's local templates folder. Premiere tells us where it is; if it doesn't, the
  // standard places on Mac and Windows.
  let root = null, rootPath = "";
  async function templatesFolder() {
    if (root) return root;
    const tries = [];
    try { const p = await ppro.SequenceEditor.getInstalledMogrtPath(); if (p) tries.push(String(p)); } catch (e) {}
    try {
      const home = require("os").homedir();
      tries.push(home + "/Library/Application Support/Adobe/Common/Motion Graphics Templates");
      tries.push(home + "\\AppData\\Roaming\\Adobe\\Common\\Motion Graphics Templates");
    } catch (e) {}
    for (const p of tries) {
      const e = await entryAt(p.replace(/[\/\\]+$/, ""));
      if (e && e.isFolder) { root = e; rootPath = e.nativePath || p; return root; }
    }
    throw new Error("Couldn't find Premiere's local templates folder.");
  }
  async function dataFolder() { return subFolder(await templatesFolder(), DATA_DIR); }
  async function thumbsFolder() { return subFolder(await dataFolder(), "thumbs"); }

  // ---------- reading a .mogrt ----------
  // A .mogrt is a zip. definition.json says its name, frame size, length and controls.
  // project.aegraphic is the After Effects side; Captioneer templates mention Captioneer in it.
  const str = (o) => (o && o.strDB && o.strDB[0] && o.strDB[0].str) || "";
  function readMogrt(buf) {
    const bytes = new Uint8Array(buf);
    const files = fflate.unzipSync(bytes, {
      filter: (f) => f.name === "definition.json" || (f.name === "project.aegraphic" && f.originalSize < 8e6),
    });
    const out = { name: "", w: 0, h: 0, dur: 0, app: "", controls: [], captioneer: false, tags: [] };
    if (files["definition.json"]) {
      const text = fflate.strFromU8(files["definition.json"]);
      if (/captioneer/i.test(text)) out.captioneer = true;
      try {
        const d = JSON.parse(text);
        out.name = d.capsuleName || str(d.capsuleNameLocalized) || "";
        out.app = d.authorApp || "";
        out.tags = Array.isArray(d.capsuleTags) ? d.capsuleTags.map(String) : [];
        out.controls = (d.clientControls || []).map((c) => str(c.uiName)).filter(Boolean);
        const loc = d.sourceInfoLocalized || {};
        const src = loc.en_US || loc[Object.keys(loc)[0]] || {};
        const fs = src.framesize && src.framesize.size;
        if (fs) { out.w = Math.round(fs.x) || 0; out.h = Math.round(fs.y) || 0; }
        const du = src.duration;
        if (du && du.scale) out.dur = du.value / du.scale;
      } catch (e) {}
    }
    if (!out.captioneer && files["project.aegraphic"]) {
      // Search the bytes for "captioneer" without decoding the whole file as text.
      const a = files["project.aegraphic"], pat = "captioneer";
      outer: for (let i = 0; i < a.length - pat.length; i++) {
        const c = a[i] | 32;
        if (c !== 99) continue;
        for (let j = 1; j < pat.length; j++) if ((a[i + j] | 32) !== pat.charCodeAt(j)) continue outer;
        out.captioneer = true; break;
      }
    }
    return out;
  }

  // ---------- guessing client + type from the name ----------
  // "HL Intro Card – LEE" -> prefix "HL". Only short ALL-CAPS first words count as a prefix.
  function prefixOf(name) {
    const m = /^([A-Z0-9&]{2,5})[\s_\-–]/.exec(String(name).trim());
    return m ? m[1] : "";
  }
  const TYPES = [
    ["Captions", /caption|subtitle|\bsubs?\b/i],
    ["Intro card", /intro|opener|title card/i],
    ["End card", /closing|end ?card|outro|out now/i],
    ["Lower third", /lower ?third|name ?tag|\bl3\b/i],
    ["Location", /location|map|pin/i],
    ["Counter", /counter|count\b|ticker/i],
    ["Transition", /transition|wipe|swipe|whoosh/i],
    ["Pop-up", /pop ?up|notification|incoming|active call|toggle|bubble/i],
    ["Player", /player|\bcd\b|vinyl|record/i],
    ["List", /lineup|list|tracklist|credits/i],
    ["Logo", /logo|bug|watermark/i],
  ];
  const TYPE_NAMES = TYPES.map((t) => t[0]).concat(["Text", "Other"]);
  function guessTypes(name, info) {
    const found = TYPES.filter(([, re]) => re.test(name)).map((t) => t[0]);
    if (info && info.captioneer && !found.includes("Captions")) found.unshift("Captions");
    return found.slice(0, 2);
  }

  // ---------- the library ----------
  const lib = { clients: [], items: {}, prefs: {} };
  let saveTimer = null;
  async function load() {
    try {
      const f = await (await dataFolder()).getEntry(LIB_FILE);
      const j = JSON.parse(await f.read());
      lib.clients = Array.isArray(j.clients) ? j.clients : [];
      lib.items = j.items && typeof j.items === "object" ? j.items : {};
      lib.prefs = j.prefs && typeof j.prefs === "object" ? j.prefs : {};
    } catch (e) { /* first run */ }
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
  }
  async function saveNow() {
    clearTimeout(saveTimer);
    try {
      const f = await (await dataFolder()).createFile(LIB_FILE, { overwrite: true });
      await f.write(JSON.stringify({ v: 1, clients: lib.clients, items: lib.items, prefs: lib.prefs }, null, 1));
    } catch (e) { console.log("TO Graphics: couldn't save library", e); }
  }

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  function clientById(id) { return lib.clients.find((c) => c.id === id) || null; }
  function clientForPrefix(p) {
    if (!p) return null;
    return lib.clients.find((c) => (c.prefixes || []).some((x) => x.toUpperCase() === p.toUpperCase())) || null;
  }
  function addClient(name, prefixes) {
    const c = { id: uid(), name: String(name).trim() || "Client", prefixes: prefixes || [] };
    lib.clients.push(c);
    save();
    return c;
  }
  function renameClient(id, name) { const c = clientById(id); if (c && name.trim()) { c.name = name.trim(); save(); } }
  function removeClient(id) {
    lib.clients = lib.clients.filter((c) => c.id !== id);
    for (const it of Object.values(lib.items)) if (it.client === id) it.client = "";
    save();
  }

  // Every .mogrt under the templates folder (subfolders too), skipping our own data folder.
  async function listFiles(folder, rel, out) {
    let entries = [];
    try { entries = await folder.getEntries(); } catch (e) { return out; }
    for (const e of entries) {
      if (e.name === DATA_DIR || e.name.startsWith(".")) continue;
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isFolder) await listFiles(e, r, out);
      else if (/\.mogrt$/i.test(e.name)) out.push({ rel: r, entry: e });
    }
    return out;
  }
  async function stamp(entry) {
    try { const m = await entry.getMetadata(); return { mtime: +new Date(m.dateModified), size: m.size }; } catch (e) { return { mtime: 0, size: 0 }; }
  }

  // Scan the folder. Returns what changed since last time: { added: [key], updated: [key], removed: [key] }.
  const entries = new Map();   // key -> file entry
  let scanning = false;
  async function scan() {
    if (scanning) return { added: [], updated: [], removed: [] };
    scanning = true;
    const added = [], updated = [], removed = [];
    try {
      const folder = await templatesFolder();
      const files = await listFiles(folder, "", []);
      const seen = new Set();
      for (const { rel, entry } of files) {
        seen.add(rel);
        entries.set(rel, entry);
        const st = await stamp(entry);
        let it = lib.items[rel];
        // Still being written (e.g. After Effects mid-export): look again next time.
        if (st.mtime && Date.now() - st.mtime < 3000 && (!it || it.mtime !== st.mtime)) continue;
        const changed = !it || it.mtime !== st.mtime || it.size !== st.size;
        if (!changed) continue;
        let info = null;
        try { info = readMogrt(await entry.read({ format: storage.formats.binary })); } catch (e) { info = null; }
        const name = (info && info.name) || rel.replace(/^.*\//, "").replace(/\.mogrt$/i, "");
        if (!it) {
          it = lib.items[rel] = { client: "", types: guessTypes(name, info), hidden: false, fav: false, added: Date.now() };
          added.push(rel);
        } else {
          it.updated = Date.now();
          it.thumbFor = 0;   // new version: its preview needs making again
          updated.push(rel);
        }
        Object.assign(it, st, {
          name,
          file: rel.replace(/^.*\//, ""),
          w: info ? info.w : 0, h: info ? info.h : 0, dur: info ? info.dur : 0,
          app: info ? info.app : "", controls: info ? info.controls : [],
          captioneer: !!(info && info.captioneer),
        });
        if (info && info.captioneer && !it.types.includes("Captions")) it.types.unshift("Captions");
      }
      for (const rel of Object.keys(lib.items)) {
        if (!seen.has(rel)) { removed.push(rel); delete lib.items[rel]; entries.delete(rel); }
      }
      if (added.length) autoSort(added);
      if (added.length || updated.length || removed.length) save();
    } finally {
      scanning = false;
    }
    return { added, updated, removed };
  }

  // New templates get a client from their prefix. A prefix shared by 2+ templates with no
  // client yet becomes a new client (named after the prefix; rename it in the panel).
  function autoSort(keys) {
    const pending = new Map();
    for (const rel of keys) {
      const it = lib.items[rel];
      if (!it || it.client) continue;
      const p = prefixOf(it.name);
      const c = clientForPrefix(p);
      if (c) it.client = c.id;
      else if (p) { if (!pending.has(p)) pending.set(p, []); pending.get(p).push(it); }
    }
    for (const [p, list] of pending) {
      const others = Object.values(lib.items).filter((x) => !x.client && prefixOf(x.name) === p);
      if (others.length < 2) continue;
      const c = addClient(p, [p]);
      for (const x of others) x.client = c.id;
    }
  }

  // ---------- adding / replacing files ----------
  // Copies a picked .mogrt into the templates folder. If one with the same file name or the
  // same template name is already there, `onClash(existingKey)` decides: "replace" | "keep" | null.
  async function addFile(file, onClash) {
    const folder = await templatesFolder();
    const data = await file.read({ format: storage.formats.binary });
    let info = null;
    try { info = readMogrt(data); } catch (e) {}
    const name = (info && info.name) || file.name.replace(/\.mogrt$/i, "");
    const clash = Object.keys(lib.items).find((k) => k.replace(/^.*\//, "").toLowerCase() === file.name.toLowerCase())
      || Object.keys(lib.items).find((k) => (lib.items[k].name || "").toLowerCase() === name.toLowerCase());
    let targetFolder = folder, targetName = file.name;
    if (clash) {
      const choice = await onClash(clash, name);
      if (!choice) return null;
      if (choice === "replace") {
        const e = entries.get(clash);
        if (e) {
          await e.write(data, { format: storage.formats.binary });
          return { key: clash, replaced: true };
        }
        targetName = clash.replace(/^.*\//, "");
      } else {
        targetName = await freeName(folder, file.name);
      }
    }
    const out = await targetFolder.createFile(targetName, { overwrite: true });
    await out.write(data, { format: storage.formats.binary });
    return { key: targetName, replaced: false };
  }
  async function replaceFile(key, file) {
    const e = entries.get(key);
    if (!e) throw new Error("That template's file has gone missing.");
    const data = await file.read({ format: storage.formats.binary });
    await e.write(data, { format: storage.formats.binary });
  }
  async function freeName(folder, name) {
    const base = name.replace(/\.mogrt$/i, "");
    for (let i = 2; i < 100; i++) {
      const n = `${base} ${i}.mogrt`;
      try { await folder.getEntry(n); } catch (e) { return n; }
    }
    return `${base} ${Date.now()}.mogrt`;
  }
  // Full path of a template on disk, for Premiere.
  function pathOf(key) {
    const e = entries.get(key);
    if (e && e.nativePath) return e.nativePath;
    return rootPath.replace(/[\/\\]+$/, "") + "/" + key;
  }

  // ---------- shapes ----------
  function shapeOf(it) {
    if (!it || !it.w || !it.h) return { tag: "", ratio: 16 / 9, vertical: false };
    const r = it.w / it.h;
    const near = (x) => Math.abs(r - x) < 0.03;
    const tag = near(9 / 16) ? "9:16" : near(4 / 5) ? "4:5" : near(1) ? "1:1" : near(16 / 9) ? "16:9" : near(4 / 3) ? "4:3" : `${it.w}×${it.h}`;
    return { tag, ratio: r, vertical: r < 0.95 };
  }

  window.TOLib = {
    lib, load, save, saveNow, scan, entries, pathOf, templatesFolder, dataFolder, thumbsFolder, entryAt,
    addFile, replaceFile, addClient, renameClient, removeClient, clientById, prefixOf, TYPE_NAMES, shapeOf,
    get rootPath() { return rootPath; },
  };
})();
