// TO Graphics: Premiere Pro UXP panel. A better Graphics Templates panel for Tyler's .mogrts:
// sorted by client, filtered by type, real previews at the right shape, Captioneer and
// hidden templates kept out of the way, and new versions swapped into the timeline.
// Files: library.js (templates folder + library.json), premiere.js (timeline, previews, swaps).

const { storage, shell } = require("uxp");
const PLUGIN_VERSION = (() => { try { return require("uxp").versions.plugin; } catch (e) { return ""; } })();
const L = window.TOLib, P = window.TOPremiere;
const $ = (id) => document.getElementById(id);
const lib = L.lib;

let busy = false;
let selected = "";
let clientFilter = "all";        // "all" | "fav" | "none" | client id
let typeFilter = "";
const thumbCache = new Map();   // key -> { v, url }

// ---------- status ----------
let statusTimer = null;
function setStatus(msg, cls) {
  const el = $("status");
  el.textContent = msg || "";
  el.className = cls || "muted";
  clearTimeout(statusTimer);
  if (msg && cls === "ok") statusTimer = setTimeout(() => setStatus(""), 7000);
}

// ---------- helpers ----------
const prefs = () => lib.prefs;
function isCaption(it) { return !!it.captioneer; }
function visible(it) {
  if (it.hidden && !prefs().showHidden) return false;
  if (isCaption(it) && !prefs().showCaptions && !it.unhidden) return false;
  return true;
}
function clientName(id) { const c = L.clientById(id); return c ? c.name : ""; }
function fmtDur(s) { if (!s) return ""; return s < 10 ? (Math.round(s * 10) / 10) + "s" : Math.round(s) + "s"; }
function keys() { return Object.keys(lib.items); }

// Base64 for preview images (UXP has no FileReader for this).
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function b64(buf) {
  const a = new Uint8Array(buf);
  let out = "", i = 0;
  for (; i + 2 < a.length; i += 3) {
    const n = (a[i] << 16) | (a[i + 1] << 8) | a[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < a.length) {
    const n = (a[i] << 16) | ((i + 1 < a.length ? a[i + 1] : 0) << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < a.length ? B64[(n >> 6) & 63] : "=") + "=";
  }
  return out;
}
async function thumbUrl(key) {
  const it = lib.items[key];
  if (!it || !it.thumb) return "";
  const hit = thumbCache.get(key);
  if (hit && hit.v === it.thumbV && hit.file === it.thumb) return hit.url;
  try {
    const f = await (await L.thumbsFolder()).getEntry(it.thumb);
    const url = (/\.png$/i.test(it.thumb) ? "data:image/png;base64," : "data:image/jpeg;base64,") + b64(await f.read({ format: storage.formats.binary }));
    thumbCache.set(key, { v: it.thumbV, file: it.thumb, url });
    return url;
  } catch (e) { return ""; }
}

// ---------- chips ----------
function renderClients() {
  const box = $("clients");
  box.innerHTML = "";
  const all = keys().filter((k) => visible(lib.items[k]));
  const chip = (id, label, n, title) => {
    const d = document.createElement("div");
    d.className = "chip" + (clientFilter === id ? " on" : "");
    d.textContent = label;
    if (n !== undefined) { const s = document.createElement("span"); s.className = "n"; s.textContent = n; d.appendChild(s); }
    if (title) d.title = title;
    const isClient = id !== "all" && id !== "fav" && id !== "none";
    d.addEventListener("click", () => {
      if (isClient && clientFilter === id) { editClient(id); return; }   // click the chosen client again to rename it
      clientFilter = id; typeFilter = ""; render();
    });
    box.appendChild(d);
  };
  chip("all", "All", all.length);
  const favs = all.filter((k) => lib.items[k].fav).length;
  if (favs) chip("fav", "★", favs, "Favourites");
  const sorted = [...lib.clients].sort((a, b) => a.name.localeCompare(b.name));
  for (const c of sorted) chip(c.id, c.name, all.filter((k) => lib.items[k].client === c.id).length, clientFilter === c.id ? "Click again to rename" : "");
  const none = all.filter((k) => !lib.items[k].client || !L.clientById(lib.items[k].client)).length;
  if (none) chip("none", "Unsorted", none);
  if (L.clientById(clientFilter)) {
    const ren = document.createElement("div");
    ren.className = "chip add";
    ren.textContent = "Rename";
    ren.title = "Rename this client";
    ren.addEventListener("click", () => editClient(clientFilter));
    box.appendChild(ren);
  }
  const add = document.createElement("div");
  add.className = "chip add";
  add.textContent = "+ Client";
  add.addEventListener("click", () => editClient(null));
  box.appendChild(add);
}

function inClient(it) {
  if (clientFilter === "all") return true;
  if (clientFilter === "fav") return !!it.fav;
  if (clientFilter === "none") return !it.client || !L.clientById(it.client);
  return it.client === clientFilter;
}

function renderTypes(list) {
  const box = $("types");
  box.innerHTML = "";
  const counts = new Map();
  for (const k of list) for (const t of lib.items[k].types || []) counts.set(t, (counts.get(t) || 0) + 1);
  const shapes = new Map();
  for (const k of list) { const s = L.shapeOf(lib.items[k]); if (s.tag) shapes.set(s.tag, (shapes.get(s.tag) || 0) + 1); }
  if (counts.size < 1 && shapes.size < 2) { box.style.display = "none"; return; }
  box.style.display = "";
  const chip = (id, label) => {
    const d = document.createElement("div");
    d.className = "chip" + (typeFilter === id ? " on" : "");
    d.textContent = label;
    d.addEventListener("click", () => { typeFilter = typeFilter === id ? "" : id; render(); });
    box.appendChild(d);
  };
  chip("", "Any type");
  if (shapes.size > 1) for (const s of [...shapes.keys()].sort()) chip("shape:" + s, s);
  for (const t of L.TYPE_NAMES) if (counts.has(t)) chip(t, t);
}
function inType(it) {
  if (!typeFilter) return true;
  if (typeFilter.startsWith("shape:")) return L.shapeOf(it).tag === typeFilter.slice(6);
  return (it.types || []).includes(typeFilter);
}

// ---------- grid ----------
let renderSeq = 0;
async function render() {
  const mine = ++renderSeq;
  renderClients();
  const q = String($("search").value || "").trim().toLowerCase();
  const inClientList = keys().filter((k) => visible(lib.items[k]) && inClient(lib.items[k]));
  renderTypes(inClientList);
  const list = inClientList.filter((k) => {
    const it = lib.items[k];
    if (!inType(it)) return false;
    if (q && !(`${it.name} ${clientName(it.client)} ${(it.types || []).join(" ")}`.toLowerCase().includes(q))) return false;
    return true;
  });
  // Newest-changed first inside "All", else by name.
  list.sort((a, b) => (lib.items[a].name || a).localeCompare(lib.items[b].name || b, undefined, { numeric: true }));
  const grid = $("grid");
  grid.innerHTML = "";
  $("count").textContent = list.length ? `${list.length} template${list.length === 1 ? "" : "s"}` : "";
  if (!list.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = keys().length ? "Nothing here. Try another client or type." : "No templates yet. Export a Motion Graphics Template from After Effects to Local Templates, or press Add.";
    grid.appendChild(e);
    renderDetail();
    return;
  }
  // In "All", group by client.
  const groups = new Map();
  if (clientFilter === "all" && !q && !typeFilter) {
    for (const k of list) {
      const g = clientName(lib.items[k].client) || "Unsorted";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(k);
    }
  } else groups.set("", list);
  const order = [...groups.keys()].sort((a, b) => (a === "Unsorted") - (b === "Unsorted") || a.localeCompare(b));
  const tiles = [];
  for (const g of order) {
    if (g && groups.size > 1) {
      const h = document.createElement("div");
      h.className = "group";
      h.textContent = g;   // as typed (Tyler names some clients in lowercase)
      grid.appendChild(h);
    }
    for (const k of groups.get(g)) { const t = tile(k); tiles.push([k, t]); grid.appendChild(t); }
  }
  renderDetail();
  // Previews load after the grid is up.
  for (const [k, t] of tiles) {
    if (mine !== renderSeq) return;
    const url = await thumbUrl(k);
    if (url && mine === renderSeq) {
      const box = t.querySelector(".frame");
      const ph = box.querySelector(".ph");
      if (ph) { const img = document.createElement("img"); img.src = url; img.width = ph.style.width.replace("px", "") * 1; img.height = ph.style.height.replace("px", "") * 1; box.replaceChild(img, ph); }
    }
  }
}

function tile(key) {
  const it = lib.items[key];
  const t = document.createElement("div");
  t.className = "tile" + (key === selected ? " sel" : "") + (it.hidden || (isCaption(it) && !it.unhidden) ? " hid" : "");
  const frame = document.createElement("div");
  frame.className = "frame";
  // The preview is drawn at the template's real shape inside a fixed-height box.
  const sh = L.shapeOf(it);
  const sz = lib.prefs.size || "m";
  const H = sz === "s" ? 76 : sz === "l" ? 160 : 104, W = sz === "s" ? 68 : sz === "l" ? 150 : 96;
  let w = W, h = Math.round(W / sh.ratio);
  if (h > H) { h = H; w = Math.round(H * sh.ratio); }
  const ph = document.createElement("div");
  ph.className = "ph";
  ph.style.width = w + "px"; ph.style.height = h + "px";
  ph.textContent = it.thumb ? "" : "No preview yet";
  frame.appendChild(ph);
  if (sh.tag) { const b = document.createElement("div"); b.className = "badge"; b.textContent = sh.tag; frame.appendChild(b); }
  const fresh = it.updated && Date.now() - it.updated < 3 * 864e5 ? "upd" : it.added && Date.now() - it.added < 3 * 864e5 && it.seen !== true ? "new" : "";
  if (fresh) { const b = document.createElement("div"); b.className = "badge " + fresh; b.style.left = "auto"; b.style.right = "auto"; b.style.bottom = "4px"; b.style.top = "auto"; b.style.left = "4px"; b.textContent = fresh === "upd" ? "Updated" : "New"; frame.appendChild(b); }
  const star = document.createElement("img");
  star.className = "star"; star.width = 12; star.height = 12;
  star.src = it.fav ? "icons/star_on.png" : "icons/star_off_d.png";
  star.style.opacity = it.fav ? "1" : "0.45";
  star.title = it.fav ? "Remove from favourites" : "Add to favourites";
  star.addEventListener("click", (ev) => { ev.stopPropagation(); it.fav = !it.fav; L.save(); render(); });
  frame.appendChild(star);
  t.appendChild(frame);
  const n = document.createElement("div"); n.className = "tname"; n.textContent = it.name || key; t.appendChild(n);
  const meta = [clientFilter === "all" ? "" : clientName(it.client), (it.types || [])[0], fmtDur(it.dur)].filter(Boolean).join(" · ");
  const m = document.createElement("div"); m.className = "tmeta"; m.textContent = (it.fav ? "★ " : "") + meta; t.appendChild(m);
  t.addEventListener("click", () => { selected = key; it.seen = true; for (const x of document.querySelectorAll(".tile.sel")) x.classList.remove("sel"); t.classList.add("sel"); renderDetail(); });
  t.addEventListener("dblclick", () => addToTimeline(key));
  t.title = it.name + (it.file && it.file.replace(/\.mogrt$/i, "") !== it.name ? `\n${it.file}` : "") + "\nDouble-click to add at the playhead";
  return t;
}

// ---------- detail ----------
function renderDetail() {
  const it = lib.items[selected];
  $("detail").classList.toggle("on", !!it);
  if (!it) return;
  $("dName").textContent = it.name;
  const sh = L.shapeOf(it);
  $("dMeta").textContent = [sh.tag && it.w ? `${sh.tag} (${it.w}×${it.h})` : "", fmtDur(it.dur), it.app === "aefx" ? "After Effects" : it.app === "pr" ? "Premiere" : "", it.hidden ? "hidden" : ""].filter(Boolean).join(" · ");
  const sel = $("dClient");
  sel.innerHTML = "";
  const opt = (v, label) => { const o = document.createElement("option"); o.value = v; o.textContent = label; if ((it.client || "") === v) o.selected = true; sel.appendChild(o); };
  opt("", "Unsorted");
  for (const c of [...lib.clients].sort((a, b) => a.name.localeCompare(b.name))) opt(c.id, c.name);
  opt("__new", "New client…");
  const tb = $("dTypes");
  tb.innerHTML = "";
  for (const t of L.TYPE_NAMES) {
    const d = document.createElement("div");
    d.className = "chip" + ((it.types || []).includes(t) ? " on" : "");
    d.textContent = t;
    d.addEventListener("click", () => {
      const set = new Set(it.types || []);
      set.has(t) ? set.delete(t) : set.add(t);
      it.types = L.TYPE_NAMES.filter((x) => set.has(x));
      L.save();
      d.classList.toggle("on");
    });
    tb.appendChild(d);
  }
}

$("dClient").addEventListener("change", async () => {
  const it = lib.items[selected];
  if (!it) return;
  let v = $("dClient").value;
  if (v === "__new") {
    const c = await editClient(null, L.prefixOf(it.name));
    if (!c) { renderDetail(); return; }
    v = c.id;
  }
  it.client = v;
  L.save();
  render();
});
$("dClose").addEventListener("click", () => { selected = ""; render(); });
$("dAdd").addEventListener("click", () => selected && addToTimeline(selected));
$("dUses").addEventListener("click", () => selected && offerSwap([selected], true));
$("dMore").addEventListener("click", () => selected && openMore(selected));

// ---------- actions ----------
async function addToTimeline(key) {
  if (busy) return;
  busy = true;
  try {
    const r = await P.addToTimeline(key);
    setStatus(`✓ Added ${lib.items[key].name} on V${r.track}`, "ok");
  } catch (e) { setStatus(e.message || String(e), "err"); }
  finally { busy = false; }
}

// Client dialog. id null = new client. Returns the client (or null).
async function editClient(id, prefixHint) {
  const c = id ? L.clientById(id) : null;
  $("cliName").value = c ? c.name : "";
  $("cliPrefixes").value = c ? (c.prefixes || []).join(", ") : (prefixHint || "");
  $("cliDel").style.display = c ? "" : "none";
  let r = null;
  try { r = await $("cliDlg").uxpShowModal({ title: c ? "Client" : "New client", resize: "none", size: { width: 340, height: 250 } }); } catch (e) {}
  const name = String($("cliName").value || "").trim();
  const prefixes = String($("cliPrefixes").value || "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  if (r === "del" && c) { L.removeClient(c.id); if (clientFilter === c.id) clientFilter = "all"; render(); return null; }
  if (r !== "ok" || !name) return null;
  let out = c;
  if (c) { L.renameClient(c.id, name); c.prefixes = prefixes; L.save(); }
  else out = L.addClient(name, prefixes);
  // Unsorted templates with a matching prefix join this client.
  if (prefixes.length) {
    for (const it of Object.values(lib.items)) {
      if ((!it.client || !L.clientById(it.client)) && prefixes.some((p) => p.toUpperCase() === L.prefixOf(it.name).toUpperCase())) it.client = out.id;
    }
    L.save();
  }
  render();
  return out;
}
$("cliYes").addEventListener("click", () => $("cliDlg").close("ok"));
$("cliNo").addEventListener("click", () => $("cliDlg").close(null));
$("cliDel").addEventListener("click", () => $("cliDlg").close("del"));

// More… for one template
const sw = (el, on) => el.classList.toggle("on", !!on);
async function openMore(key) {
  const it = lib.items[key];
  $("moreTitle").textContent = it.name;
  $("mName").value = it.name;
  $("mNameErr").textContent = "";
  sw($("mFav"), it.fav);
  sw($("mHide"), it.hidden || (isCaption(it) && !it.unhidden));
  $("mAt").value = String(it.thumbAt || 0);
  let r = null;
  try { r = await $("moreDlg").uxpShowModal({ title: it.name, resize: "none", size: { width: 360, height: 510 } }); } catch (e) {}
  if (r === "redo") previews([key], true);
  if (r === "remove") removeTemplate(key);
  if (r === "replace") replaceVersion(key);
}
$("mFav").addEventListener("click", () => { const it = lib.items[selected]; if (!it) return; it.fav = !it.fav; sw($("mFav"), it.fav); L.save(); render(); });
$("mHide").addEventListener("click", () => {
  const it = lib.items[selected]; if (!it) return;
  const nowHidden = !$("mHide").classList.contains("on");
  it.hidden = nowHidden;
  if (isCaption(it)) it.unhidden = !nowHidden;
  sw($("mHide"), nowHidden);
  L.save(); render();
});
$("mAt").addEventListener("change", () => { const it = lib.items[selected]; if (!it) return; it.thumbAt = parseFloat($("mAt").value) || 0; L.save(); });
$("mRedo").addEventListener("click", () => $("moreDlg").close("redo"));
$("mReplace").addEventListener("click", () => $("moreDlg").close("replace"));
async function doRename() {
  const key = selected, it = lib.items[key];
  if (!it) return;
  const name = String($("mName").value || "").trim();
  if (!name || name === it.name) return;
  try {
    const newKey = await L.renameTemplate(key, name);
    selected = newKey;
    $("moreTitle").textContent = name;
    $("mNameErr").textContent = "Renamed. Copies already in projects keep their old name.";
    setStatus(`✓ Renamed to ${name}`, "ok");
    render();
  } catch (e) { $("mNameErr").textContent = e.message || String(e); }
}
$("mRename").addEventListener("click", doRename);
$("mName").addEventListener("keydown", (e) => { if (e.key === "Enter") doRename(); });
$("dName").addEventListener("dblclick", () => selected && openMore(selected));
$("mRemove").addEventListener("click", () => $("moreDlg").close("remove"));
$("mFinder").addEventListener("click", () => showInFinder(L.pathOf(selected).replace(/[\/\\][^\/\\]*$/, "")));
async function showInFinder(dir) {
  try { const err = await shell.openPath(dir); if (err) throw new Error(err); }
  catch (e) { setStatus("Couldn't open the folder: " + dir, "err"); }
}
async function removeTemplate(key) {
  const it = lib.items[key];
  if (!it) return;
  $("rmText").textContent = `"${it.name}" is taken out of your templates (and Premiere's Local Templates). Projects already using it aren't affected. A copy is kept in the hidden ".to-graphics/removed" folder.`;
  let r = null;
  try { r = await $("rmDlg").uxpShowModal({ title: "Remove", resize: "none", size: { width: 360, height: 200 } }); } catch (e) {}
  if (r !== "go") return;
  try { await L.removeFile(key); if (selected === key) selected = ""; setStatus(`✓ Removed ${it.name}`, "ok"); }
  catch (e) { setStatus(e.message || String(e), "err"); }
  render();
}
$("rmYes").addEventListener("click", () => $("rmDlg").close("go"));
$("rmNo").addEventListener("click", () => $("rmDlg").close(null));
$("mDone").addEventListener("click", () => $("moreDlg").close(null));

// ---------- adding templates ----------
async function askClash(existingKey, name) {
  const it = lib.items[existingKey] || {};
  $("clashText").textContent = `"${it.name || name}" is already in your templates. Replace it with this new version (it keeps its client and type), or keep both?`;
  let r = null;
  try { r = await $("clashDlg").uxpShowModal({ title: "Already there", resize: "none", size: { width: 380, height: 190 } }); } catch (e) {}
  return r;
}
$("clashReplace").addEventListener("click", () => $("clashDlg").close("replace"));
$("clashKeep").addEventListener("click", () => $("clashDlg").close("keep"));
$("clashSkip").addEventListener("click", () => $("clashDlg").close(null));

async function addFiles() {
  if (busy) return;
  let files = [];
  try { files = await storage.localFileSystem.getFileForOpening({ allowMultiple: true, types: ["mogrt"] }); } catch (e) { return; }
  if (!files) return;
  if (!Array.isArray(files)) files = [files];
  if (!files.length) return;
  busy = true;
  const replaced = [], added = [];
  try {
    for (const f of files) {
      const r = await L.addFile(f, askClash);
      if (!r) continue;
      (r.replaced ? replaced : added).push(r.key);
    }
  } catch (e) { setStatus(e.message || String(e), "err"); }
  finally { busy = false; }
  await refresh(true);
  if (added.length || replaced.length) setStatus(`✓ ${added.length ? added.length + " added" : ""}${added.length && replaced.length ? ", " : ""}${replaced.length ? replaced.length + " updated" : ""}`, "ok");
  if (added.length === 1 && !replaced.length) { selected = added[0]; render(); }
}
$("addBtn").addEventListener("click", addFiles);

async function replaceVersion(key) {
  let f = null;
  try { f = await storage.localFileSystem.getFileForOpening({ types: ["mogrt"] }); } catch (e) { return; }
  if (!f) return;
  try { await L.replaceFile(key, f); } catch (e) { setStatus(e.message || String(e), "err"); return; }
  await refresh(true);
}

// ---------- previews ----------
let previewing = false;
async function previews(list, force) {
  if (previewing || !list.length) return;
  previewing = true;
  const total = list.length;
  let n = 0;
  showNotice(`Making previews… 0 of ${total}`, null, true);
  try {
    if (force) for (const k of list) { const it = lib.items[k]; if (it) it.thumbFor = 0; }
    const made = await P.makePreviews(list, () => { n++; showNotice(`Making previews… ${n} of ${total}`, null, true); });
    hideNotice();
    setStatus(made === total ? `✓ ${made} preview${made === 1 ? "" : "s"} made` : `Made ${made} of ${total} previews. The rest didn't render.`, made === total ? "ok" : "err");
  } catch (e) {
    hideNotice();
    setStatus(e.message || String(e), "err");
  } finally {
    previewing = false;
    render();
    checkPending();
  }
}
function needPreview() {
  return keys().filter((k) => { const it = lib.items[k]; return visible(it) && (!it.thumb || it.thumbFor !== it.mtime) && it.previewTried !== it.mtime; });
}

// ---------- notice bar (one at a time) ----------
let noticeYes = null, noticeNo = null;
function showNotice(text, yesLabel, working, onYes, onNo) {
  $("noticeText").textContent = text;
  $("notice").classList.add("on");
  $("notice").classList.toggle("work", !!working);
  $("noticeYes").style.display = yesLabel ? "" : "none";
  $("noticeNo").style.display = yesLabel ? "" : "none";
  $("noticeYes").textContent = yesLabel || "";
  noticeYes = onYes || null; noticeNo = onNo || null;
}
function hideNotice() { $("notice").classList.remove("on"); noticeYes = noticeNo = null; }
$("noticeYes").addEventListener("click", () => { const f = noticeYes; hideNotice(); if (f) f(); });
$("noticeNo").addEventListener("click", () => { const f = noticeNo; hideNotice(); if (f) f(); });

let snoozed = new Set();
async function hasProject() { try { return !!(await require("premierepro").Project.getActiveProject()); } catch (e) { return false; } }
async function checkPending() {
  if (previewing || $("notice").classList.contains("on")) return;
  const need = needPreview().filter((k) => !snoozed.has(k));
  if (!need.length) return;
  if (!(await hasProject())) return;
  // A few new or updated ones: just do it. A big first batch: ask, because it takes a minute.
  if (need.length <= 3 && lib.prefs.autoPreviews !== false) { previews(need); return; }
  showNotice(`${need.length} templates need a preview. Premiere renders a frame of each, about a second each.`, "Make previews", false,
    () => previews(need), () => need.forEach((k) => snoozed.add(k)));
}

// ---------- new versions → timeline ----------
async function offerSwap(list, manual) {
  if (busy) return;
  let uses = [];
  try { uses = await P.findUses(list, false); } catch (e) { if (manual) setStatus(e.message || String(e), "err"); return; }
  if (!uses.length) { if (manual) setStatus("Not used in this project.", "ok"); return; }
  const names = [...new Set(uses.map((u) => lib.items[u.key].name))];
  $("usesTitle").textContent = names.length === 1 ? `Update ${names[0]}?` : `Update ${names.length} templates?`;
  $("usesText").textContent = `${uses.length} cop${uses.length === 1 ? "y" : "ies"} in this project ${uses.length === 1 ? "uses" : "use"} the ${manual ? "template" : "old version"}:`;
  const box = $("usesList");
  box.innerHTML = "";
  const bySeq = new Map();
  for (const u of uses) bySeq.set(u.seq.name, (bySeq.get(u.seq.name) || 0) + 1);
  for (const [s, n] of bySeq) { const d = document.createElement("div"); d.textContent = `${s}${n > 1 ? ` (${n})` : ""}`; box.appendChild(d); }
  let r = null;
  try { r = await $("usesDlg").uxpShowModal({ title: "Update in project", resize: "none", size: { width: 380, height: 360 } }); } catch (e) {}
  if (r !== "go") return;
  busy = true;
  let n = 0;
  setStatus(`Updating 0 of ${uses.length}…`);
  try {
    const sum = await P.swapUses(uses, () => { n++; setStatus(`Updating ${n} of ${uses.length}…`); });
    const extra = [];
    if (sum.animated) extra.push(`${sum.animated} keyframed setting${sum.animated === 1 ? "" : "s"} left at the new defaults`);
    if (sum.skipped) extra.push(`${sum.skipped} setting${sum.skipped === 1 ? "" : "s"} couldn't be copied`);
    if (sum.failed) extra.push(`${sum.failed} didn't swap`);
    setStatus(`✓ Updated ${sum.done}${extra.length ? ` (${extra.join("; ")})` : ""}`, sum.failed ? "err" : "ok");
  } catch (e) { setStatus(e.message || String(e), "err"); }
  finally { busy = false; }
}
$("usesYes").addEventListener("click", () => $("usesDlg").close("go"));
$("usesNo").addEventListener("click", () => $("usesDlg").close(null));

// ---------- watching the folder ----------
async function refresh(fromAction) {
  let ch = { added: [], updated: [], removed: [] };
  try { ch = await L.scan(); } catch (e) { setStatus(e.message || String(e), "err"); }
  if (ch.removed.includes(selected)) selected = "";
  if (ch.added.length || ch.updated.length || ch.removed.length || fromAction) render();
  if (ch.updated.length) {
    // Updated templates: make their previews, then offer to swap them into the project.
    const upd = ch.updated.slice();
    const doSwap = async () => { if (await hasProject()) offerSwap(upd, false); };
    if (await hasProject()) { await previews(upd.filter((k) => visible(lib.items[k]))); }
    doSwap();
    return;
  }
  checkPending();
}

// ---------- settings ----------
async function openSettings() {
  sw($("sCaps"), prefs().showCaptions);
  sw($("sHidden"), prefs().showHidden);
  $("sPath").textContent = L.rootPath;
  const box = $("sClients");
  box.innerHTML = "";
  for (const c of [...lib.clients].sort((a, b) => a.name.localeCompare(b.name))) {
    const row = document.createElement("div");
    row.className = "secRow";
    const n = document.createElement("span");
    n.className = "grow";
    n.textContent = c.name + ((c.prefixes || []).length ? `  (${c.prefixes.join(", ")}…)` : "");
    const b = document.createElement("div");
    b.className = "btn ghost small";
    b.textContent = "Rename";
    b.addEventListener("click", () => $("setDlg").close("client:" + c.id));
    row.appendChild(n); row.appendChild(b); box.appendChild(row);
  }
  fillAbout();
  let r = null;
  try { r = await $("setDlg").uxpShowModal({ title: "Settings", resize: "none", size: { width: 380, height: 640 } }); } catch (e) {}
  if (r && r.startsWith("client:")) { await editClient(r.slice(7)); return openSettings(); }
  if (r === "newClient") { await editClient(null); return openSettings(); }
  if (r === "redoAll") previews(keys().filter((k) => visible(lib.items[k])), true);
  if (r === "update") installUpdate();
}
$("setBtn").addEventListener("click", openSettings);
$("sCaps").addEventListener("click", () => { prefs().showCaptions = !prefs().showCaptions; sw($("sCaps"), prefs().showCaptions); L.save(); render(); });
$("sHidden").addEventListener("click", () => { prefs().showHidden = !prefs().showHidden; sw($("sHidden"), prefs().showHidden); L.save(); render(); });
$("sNewClient").addEventListener("click", () => $("setDlg").close("newClient"));
$("sRedoAll").addEventListener("click", () => $("setDlg").close("redoAll"));
$("sDone").addEventListener("click", () => $("setDlg").close(null));
$("sInstall").addEventListener("click", () => $("setDlg").close("update"));
$("sOpen").addEventListener("click", () => showInFinder(L.rootPath));
$("sLog").addEventListener("click", async () => {
  const text = [`TO Graphics ${PLUGIN_VERSION}`, `Folder: ${L.rootPath}`, ...P.log].join("\n");
  try { await navigator.clipboard.setContent({ "text/plain": text }); $("sLog").textContent = "Copied"; } catch (e) { $("sLog").textContent = "Couldn't copy"; }
  setTimeout(() => { $("sLog").textContent = "Copy log"; }, 2000);
});

// ---------- update check (same as HQ) ----------
// latest.json on GitHub: { "version": "1.0.1", "url": "<.ccx address>", "notes": "…" }. If it's
// newer, a banner offers a one-click update: the .ccx is downloaded and handed to Creative Cloud.
const UPDATE_URL = document.body.getAttribute("data-update-url") || "";
let latestRelease = null, lastCheckResult = "Not checked yet", retryTimer = null;
function newerThan(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0), pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}
async function checkForUpdate(manual) {
  if (!UPDATE_URL || !PLUGIN_VERSION) return "";
  let ok = false;
  try {
    const res = await fetch(UPDATE_URL + "?t=" + Date.now());
    if (!res.ok) throw new Error(`GitHub replied ${res.status}`);
    const info = await res.json();
    ok = true;
    if (info && info.version && info.url && newerThan(info.version, PLUGIN_VERSION)) {
      latestRelease = info;
      $("updateText").textContent = `TO Graphics ${info.version} is available${info.notes ? `: ${info.notes}` : ""}`;
      $("updateBar").classList.add("on");
      lastCheckResult = `${info.version} available`;
    } else {
      latestRelease = null;
      $("updateBar").classList.remove("on");
      lastCheckResult = "Up to date";
    }
  } catch (e) {
    lastCheckResult = `Couldn't check: ${e && e.message ? e.message : e}`;
  } finally {
    if (!ok && !manual && !retryTimer) retryTimer = setTimeout(() => { retryTimer = null; checkForUpdate(); }, 5 * 60 * 1000);
  }
  return lastCheckResult;
}
async function installUpdate() {
  if (!latestRelease) return;
  const url = latestRelease.url;
  setStatus(`Downloading ${latestRelease.version}…`);
  try {
    const res = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now());
    if (!res.ok) throw new Error("download failed");
    const data = await res.arrayBuffer();
    const folder = await storage.localFileSystem.getDataFolder();
    const file = await folder.createFile(`TOGraphics-update-${latestRelease.version}.ccx`, { overwrite: true });
    await file.write(data, { format: storage.formats.binary });
    const err = await shell.openPath(file.nativePath, "Install the latest TO Graphics with Creative Cloud");
    if (err) throw new Error(err);
    setStatus("Creative Cloud is installing the update. Click Install, then reopen this panel.", "ok");
  } catch (e) {
    try { await shell.openExternal(url, "Download the latest TO Graphics"); } catch (e2) {}
    setStatus("Couldn't install automatically. The update is downloading in your browser: double-click it to install.", "err");
  }
}
function fillAbout() {
  $("aboutVer").textContent = "TO Graphics" + (PLUGIN_VERSION ? " " + PLUGIN_VERSION : "");
  $("aboutUpd").textContent = latestRelease ? `Version ${latestRelease.version} is available` : lastCheckResult;
  $("sInstall").classList.toggle("hide", !latestRelease);
}
$("aboutCheck").addEventListener("click", async () => { $("aboutUpd").textContent = "Checking…"; await checkForUpdate(true); fillAbout(); });
$("updateBtn").addEventListener("click", installUpdate);

// ---------- preview size (S / M / L, remembered) ----------
function applySize() {
  const s = lib.prefs.size || "m";
  document.body.classList.remove("sz-s", "sz-l");
  if (s !== "m") document.body.classList.add("sz-" + s);
  $("sizeBtn").textContent = s === "s" ? "Small" : s === "l" ? "Large" : "Medium";
}
$("sizeBtn").addEventListener("click", () => {
  const order = ["s", "m", "l"];
  lib.prefs.size = order[(order.indexOf(lib.prefs.size || "m") + 1) % 3];
  L.save(); applySize(); render();
});

// ---------- start ----------
$("search").addEventListener("input", () => render());
(async () => {
  try {
    await L.templatesFolder();
    await L.load();
    if (lib.prefs.showCaptions === undefined) lib.prefs.showCaptions = false;
  } catch (e) { setStatus(e.message || String(e), "err"); }
  applySize();
  // 1.0.2: previews made before the Media Offline check (JPEGs) are remade once.
  for (const it of Object.values(lib.items)) if (it.thumb && /\.jpg$/i.test(it.thumb) && !it.pngRedo) { it.thumbFor = 0; it.previewTried = 0; it.pngRedo = true; }
  // First run: everything already in the folder is not "New".
  const firstRun = !keys().length;
  await refresh(true);
  if (firstRun && keys().length) { for (const k of keys()) lib.items[k].seen = true; L.save(); render(); }
  if (UPDATE_URL) setTimeout(checkForUpdate, 1500);
  // Light polling, so templates exported from After Effects show up on their own.
  setInterval(() => { if (!busy && !previewing) refresh(false); }, 4000);
})();
