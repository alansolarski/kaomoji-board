import { categories as rawCategories } from "./kaomoji-data.js";

const $ = (id) => document.getElementById(id);
const appEl = $("app");
const searchEl = $("search");
const contentEl = $("content");
const faceEl = $("face");
const contextEl = $("context");
const categoryBtn = $("categoryBtn");
const categoryLabel = $("categoryLabel");
const categoryDot = $("categoryDot");
const primaryBtn = $("primaryBtn");
const primaryLabel = $("primaryLabel");
const actionsBtn = $("actionsBtn");
const popoverEl = $("popover");
const settingsBtn = $("settingsBtn");
const settingsPanel = $("settingsPanel");
const settingsBackBtn = $("settingsBackBtn");
const stayOpenToggle = $("stayOpenToggle");
const autoPasteToggle = $("autoPasteToggle");
const soundToggle = $("soundToggle");
const autostartToggle = $("autostartToggle");
const themeSegmented = $("themeSegmented");
const hotkeyBtn = $("hotkeyBtn");
const hotkeyHint = $("hotkeyHint");

const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);

const FACE_IDLE = "( ˘ω˘ )";
const FACE_HAPPY = "(ﾉ◕ヮ◕)ﾉ";
const FACE_SAD = "(｡•́︿•̀｡)";

const PALETTE = [1, 2, 3, 4, 5, 6].map((n) => `var(--palette-${n})`);

const HEART_SVG =
  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">' +
  '<path d="M8 13.6 2.6 8.4A3.2 3.2 0 0 1 7.1 3.9L8 4.8l.9-.9a3.2 3.2 0 0 1 4.5 4.5Z" ' +
  'stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---------- persisted data (data.json via the backend) ----------

const DEFAULT_PREFS = { stayOpen: false, autoPaste: false, sound: true, theme: "auto" };
let data = { version: 1, favorites: [], custom: [], usage: {}, prefs: { ...DEFAULT_PREFS } };
let dataLoaded = false;

// Settings used to live in WebView localStorage; carry them over once.
function readLegacyData() {
  try {
    const get = (k) => localStorage.getItem(k);
    const list = (k) => JSON.parse(get(k) || "[]");
    return {
      favorites: list("kaomoji.favorites"),
      custom: list("kaomoji.custom"),
      prefs: {
        stayOpen: get("kaomoji.stayOpen") === "1",
        autoPaste: get("kaomoji.autoPaste") === "1",
        sound: get("kaomoji.muted") !== "1",
        theme: get("kaomoji.theme") || "auto",
      },
    };
  } catch {
    return null;
  }
}

async function loadData() {
  let stored;
  try {
    stored = await invoke("load_data");
  } catch (err) {
    // Leave the file alone; running on defaults beats clobbering it.
    console.error("couldn't load data.json", err);
    flashContext("Couldn't load your saved kaomoji", 4000);
    return;
  }
  dataLoaded = true;
  const source = stored ?? readLegacyData() ?? {};
  data = {
    version: 1,
    favorites: Array.isArray(source.favorites) ? source.favorites : [],
    custom: Array.isArray(source.custom) ? source.custom : [],
    usage: source.usage && typeof source.usage === "object" ? source.usage : {},
    prefs: { ...DEFAULT_PREFS, ...(source.prefs || {}) },
  };
  if (!stored) saveData();
}

function saveData() {
  if (!dataLoaded) return;
  invoke("save_data", { data }).catch((err) => console.error("couldn't save data.json", err));
}

// ---------- usage ranking ----------

const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_USAGE_ENTRIES = 300;

function usageScore(text, now = Date.now()) {
  const u = data.usage[text];
  if (!u) return 0;
  return u.c * Math.pow(0.5, (now - u.t) / HALF_LIFE_MS);
}

function recordUse(text) {
  const prev = data.usage[text] || { c: 0, t: 0 };
  data.usage[text] = { c: prev.c + 1, t: Date.now() };
  const keys = Object.keys(data.usage);
  if (keys.length > MAX_USAGE_ENTRIES) {
    const now = Date.now();
    keys
      .sort((a, b) => usageScore(a, now) - usageScore(b, now))
      .slice(0, keys.length - MAX_USAGE_ENTRIES)
      .forEach((k) => delete data.usage[k]);
  }
  saveData();
}

function frequentItems() {
  const now = Date.now();
  return Object.keys(data.usage)
    .sort((a, b) => usageScore(b, now) - usageScore(a, now))
    .slice(0, 8);
}

// ---------- search ----------

const words = (s) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

// Items are either "text" or ["text", "keywords"]; flatten once up front.
const categories = rawCategories.map((cat) => {
  const nameWords = words(cat.name);
  const catKeywords = [...nameWords, nameWords.join(""), ...words(cat.keywords)];
  const entries = cat.items.map((item) =>
    typeof item === "string"
      ? { text: item, keywords: catKeywords }
      : { text: item[0], keywords: [...catKeywords, ...words(item[1])] }
  );
  return { name: cat.name, entries, items: entries.map((e) => e.text) };
});

function buildIndex() {
  const byText = new Map();
  const add = (text, keywords) => {
    let entry = byText.get(text);
    if (!entry) {
      entry = { text, order: byText.size, keywords: new Set() };
      byText.set(text, entry);
    }
    keywords.forEach((k) => entry.keywords.add(k));
  };
  for (const cat of categories) {
    cat.entries.forEach((e) => add(e.text, e.keywords));
  }
  data.custom.forEach((t) => add(t, ["custom"]));
  data.favorites.forEach((t) => add(t, ["favorite", "favourite"]));
  return [...byText.values()];
}

// 3 = exact keyword, 2 = keyword prefix, 1 = appears in the kaomoji itself.
function matchQuality(entry, token) {
  let best = entry.text.toLowerCase().includes(token) ? 1 : 0;
  for (const kw of entry.keywords) {
    if (kw === token) return 3;
    if (kw.startsWith(token)) best = 2;
  }
  return best;
}

function search(query, within) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const now = Date.now();
  const results = [];
  for (const entry of buildIndex()) {
    if (within && !within.has(entry.text)) continue;
    let total = 0;
    for (const token of tokens) {
      const q = matchQuality(entry, token);
      if (!q) {
        total = 0;
        break;
      }
      total += q;
    }
    if (total) results.push({ entry, total, score: usageScore(entry.text, now) });
  }
  results.sort((a, b) => b.total - a.total || b.score - a.score || a.entry.order - b.entry.order);
  return results.map((r) => r.entry.text);
}

// ---------- sections + category filter ----------

let categoryFilter = "all";

function allSections() {
  const sections = [];
  const frequent = frequentItems();
  if (frequent.length) {
    sections.push({ id: "frequent", label: "Frequently Used", color: "var(--accent)", items: frequent, kind: "frequent" });
  }
  sections.push({ id: "favorites", label: "Favorites", color: "var(--accent)", items: data.favorites, kind: "favorites" });
  categories.forEach((cat, i) => {
    sections.push({ id: `cat-${i}`, label: cat.name, color: PALETTE[i % PALETTE.length], items: cat.items, kind: "category" });
  });
  sections.push({ id: "custom", label: "Custom", color: "var(--palette-6)", items: data.custom, kind: "custom" });
  return sections;
}

function visibleSections(query) {
  const sections = allSections();
  const filtered = categoryFilter === "all" ? null : sections.find((s) => s.id === categoryFilter);

  if (query) {
    const items = search(query, filtered ? new Set(filtered.items) : null);
    const label = filtered ? `Results in ${filtered.label}` : "Results";
    return [{ id: "results", label, color: "var(--accent)", items, kind: "results" }];
  }
  if (filtered) return [filtered];
  // In the combined view, an empty favorites section is just noise.
  return sections.filter((s) => s.items.length || s.kind === "custom");
}

function setCategory(id) {
  if (!allSections().some((s) => s.id === id)) id = "all";
  categoryFilter = id;
  const section = allSections().find((s) => s.id === id);
  categoryLabel.textContent = section ? section.label : "All Categories";
  categoryDot.style.setProperty("--dot-color", section ? section.color : "var(--ink-soft)");
  categoryDot.hidden = !section;
  contentEl.scrollTop = 0;
  render();
}

// ---------- rendering ----------

let flat = []; // every copyable tile, in visual order
let selected = -1;
let addingCustom = false;

function render({ keepSelection = false } = {}) {
  const query = searchEl.value.trim();
  const sections = visibleSections(query);
  const prevSelected = selected;
  const prevTile = flat[selected];
  const favorites = new Set(data.favorites);
  flat = [];
  contentEl.innerHTML = "";

  for (const sec of sections) {
    const wrap = el("section", "section");
    const head = el("div", "section-head");
    head.append(el("span", "", sec.label), el("span", "count", String(sec.items.length)));
    wrap.append(head);

    const tiles = el("div", "tiles");
    sec.items.forEach((text, i) => tiles.append(buildTile(text, sec, i, favorites)));
    if (sec.kind === "custom" && !query) tiles.append(buildAddTile());
    if (!sec.items.length && sec.kind === "favorites") {
      tiles.append(el("div", "empty", "No favorites yet. Select a kaomoji and press Ctrl+D."));
    }
    if (!sec.items.length && sec.kind === "results") {
      tiles.append(el("div", "empty", "No kaomoji match that search"));
    }
    wrap.append(tiles);
    contentEl.append(wrap);
  }

  // Long kaomoji get two cells, and the few that still don't fit get the
  // whole row. Read all widths before writing so each pass lays out once.
  const overflows = (tile) => tile.scrollWidth > tile.clientWidth;
  const wide = flat.filter(overflows);
  wide.forEach((tile) => tile.classList.add("wide"));
  wide.filter(overflows).forEach((tile) => tile.classList.add("full"));

  flat.slice(0, 9).forEach((tile, i) => (tile.dataset.n = String(i + 1)));

  let next = 0;
  if (keepSelection && prevTile) {
    // Indices shift when e.g. favorites grows, so follow the same tile.
    const same = flat.findIndex(
      (t) => t.dataset.text === prevTile.dataset.text && t.dataset.section === prevTile.dataset.section
    );
    next = same >= 0 ? same : prevSelected;
  }
  selected = -1;
  select(next, false);

  if (!faceTimer) faceEl.textContent = query && !flat.length ? FACE_SAD : FACE_IDLE;
}

function buildTile(text, sec, indexInSection, favorites) {
  const tile = el("button", "tile", text);
  tile.title = text;
  tile.dataset.text = text;
  tile.dataset.section = sec.id;
  tile.dataset.sectionLabel = sec.kind === "results" ? "Search Results" : sec.label;
  tile.dataset.kind = sec.kind;
  const isFav = favorites.has(text);
  if (isFav) tile.classList.add("fav");

  // A span, not a nested button (invalid inside <button>). Stopping the
  // click here keeps it from reaching the tile's copy handler.
  const heart = el("span", "heart");
  heart.title = isFav ? "Remove from Favorites (Ctrl+D)" : "Add to Favorites (Ctrl+D)";
  heart.innerHTML = HEART_SVG;
  heart.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFavorite(text);
  });
  tile.append(heart);

  const flatIndex = flat.length;
  flat.push(tile);

  tile.addEventListener("click", () => runPrimary(flatIndex));
  tile.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    select(flatIndex, false);
    openActions({ x: e.clientX, y: e.clientY });
  });
  tile.addEventListener("mousemove", (e) => {
    if (pointerMoved(e) && selected !== flatIndex) select(flatIndex, false);
  });

  if (sec.kind === "favorites") {
    tile.draggable = true;
    tile.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/x-fav-index", String(indexInSection));
      e.dataTransfer.effectAllowed = "move";
    });
    tile.addEventListener("dragover", (e) => {
      if (!e.dataTransfer.types.includes("text/x-fav-index")) return;
      e.preventDefault();
      tile.classList.add("drop");
    });
    tile.addEventListener("dragleave", () => tile.classList.remove("drop"));
    tile.addEventListener("drop", (e) => {
      e.preventDefault();
      tile.classList.remove("drop");
      const from = Number(e.dataTransfer.getData("text/x-fav-index"));
      if (Number.isNaN(from) || from === indexInSection) return;
      const [moved] = data.favorites.splice(from, 1);
      data.favorites.splice(indexInSection, 0, moved);
      saveData();
      render({ keepSelection: true });
    });
  }
  return tile;
}

function buildAddTile() {
  if (!addingCustom) {
    const btn = el("button", "tile add", "+ Add your own");
    btn.addEventListener("click", startAddingCustom);
    return btn;
  }

  const input = el("input", "tile add-input");
  input.placeholder = "Paste a kaomoji, then ↵";
  input.spellcheck = false;
  const finish = (save) => {
    if (!addingCustom) return;
    addingCustom = false;
    const value = input.value.trim();
    if (save && value && !data.custom.includes(value)) {
      data.custom.push(value);
      saveData();
      flashContext("Added to Custom");
    }
    render({ keepSelection: true });
    searchEl.focus();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(false));
  setTimeout(() => input.focus(), 0);
  return input;
}

function startAddingCustom() {
  addingCustom = true;
  searchEl.value = "";
  if (categoryFilter !== "all" && categoryFilter !== "custom") setCategory("custom");
  render({ keepSelection: true });
  contentEl.querySelector(".add-input")?.scrollIntoView({ block: "nearest" });
}

// ---------- selection ----------

// Scrolling can fire mousemove without the pointer actually moving; only
// real movement should steal the keyboard selection.
let lastPointer = { x: -1, y: -1 };
function pointerMoved(e) {
  const moved = e.screenX !== lastPointer.x || e.screenY !== lastPointer.y;
  lastPointer = { x: e.screenX, y: e.screenY };
  return moved;
}

function select(index, scroll = true) {
  flat[selected]?.classList.remove("sel");
  selected = flat.length ? Math.max(0, Math.min(index, flat.length - 1)) : -1;
  const tile = flat[selected];
  if (tile) {
    tile.classList.add("sel");
    if (scroll) tile.scrollIntoView({ block: "nearest" });
  }
  updateContext();
}

// Moves to the tile in the nearest row above/below, closest horizontally.
function moveVertical(dir) {
  const current = flat[selected];
  if (!current) return select(0);
  const r = current.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  let best = -1;
  let bestTop = null;
  let bestDx = Infinity;
  flat.forEach((tile, i) => {
    const tr = tile.getBoundingClientRect();
    if (dir > 0 ? tr.top <= r.top + 4 : tr.top >= r.top - 4) return;
    const dx = Math.abs(tr.left + tr.width / 2 - cx);
    const closerRow = bestTop === null || (dir > 0 ? tr.top < bestTop - 2 : tr.top > bestTop + 2);
    const sameRow = bestTop !== null && Math.abs(tr.top - bestTop) <= 2;
    if (closerRow || (sameRow && dx < bestDx)) {
      best = i;
      bestTop = closerRow ? tr.top : bestTop;
      bestDx = dx;
    }
  });
  if (best >= 0) select(best);
}

// ---------- action bar ----------

let contextTimer = null;

function updateContext() {
  if (contextTimer) return;
  const tile = flat[selected];
  contextEl.textContent = tile ? `Kaomoji – ${tile.dataset.sectionLabel}` : "Kaomoji";
}

function flashContext(message, ms = 1400) {
  clearTimeout(contextTimer);
  contextEl.textContent = message;
  contextTimer = setTimeout(() => {
    contextTimer = null;
    updateContext();
  }, ms);
}

function updatePrimaryLabel() {
  primaryLabel.textContent = data.prefs.autoPaste ? "Paste" : "Copy";
}

primaryBtn.addEventListener("click", () => runPrimary(selected));
actionsBtn.addEventListener("click", () => (popoverKind === "actions" ? closePopover() : openActions()));

// ---------- copy / paste ----------

let audioCtx = null;
let faceTimer = null;

// A soft rising two-note chime (B5 → E6). Each note has a quick upward
// chirp for a bit of "pop" and a faint octave overtone for a glassy ring.
// Takes any audio context so it can also be rendered offline.
export function synthCopySound(ctx, destination, t0 = ctx.currentTime) {
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 5000;
  filter.connect(destination);

  const note = (freq, start, dur, peak) => {
    for (const [mult, level, len] of [[1, 1, dur], [2, 0.18, dur * 0.55]]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t = t0 + start;
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq * mult * 0.94, t);
      osc.frequency.exponentialRampToValueAtTime(freq * mult, t + 0.03);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak * level, t + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + len);
      osc.connect(gain).connect(filter);
      osc.start(t);
      osc.stop(t + len + 0.02);
    }
  };
  note(987.77, 0, 0.18, 0.07);
  note(1318.51, 0.07, 0.26, 0.055);
}

function playCopySound() {
  if (!data.prefs.sound) return;
  try {
    audioCtx = audioCtx || new AudioContext();
    if (audioCtx.state === "suspended") audioCtx.resume();
    synthCopySound(audioCtx, audioCtx.destination);
  } catch {
    // no audio device; not worth surfacing
  }
}

function runPrimary(index) {
  const tile = flat[index];
  if (tile) useKaomoji(tile.dataset.text, tile, data.prefs.autoPaste ? "paste" : "copy");
}

function runSecondary(index) {
  const tile = flat[index];
  if (tile) useKaomoji(tile.dataset.text, tile, data.prefs.autoPaste ? "copy" : "paste");
}

async function useKaomoji(text, tile, mode) {
  closePopover();
  // Deliberately no re-render: reshuffling "Frequently Used" under the
  // cursor is jarring. The next time the window opens picks it up.
  recordUse(text);
  playCopySound();
  if (tile) {
    tile.classList.add("flash");
    setTimeout(() => tile.classList.remove("flash"), 160);
  }
  faceEl.textContent = FACE_HAPPY;
  clearTimeout(faceTimer);
  faceTimer = setTimeout(() => {
    faceTimer = null;
    faceEl.textContent = FACE_IDLE;
  }, 900);

  try {
    if (mode === "paste") {
      await invoke("paste_kaomoji", { text });
      return;
    }
    await window.__TAURI__.clipboardManager.writeText(text);
  } catch (err) {
    console.error("copy failed", err);
    flashContext("Couldn't copy (｡•́︿•̀｡)", 2500);
    return;
  }
  flashContext("Copied to clipboard");
  if (!data.prefs.stayOpen) setTimeout(hideWindow, 90);
}

function hideWindow() {
  invoke("hide_window");
}

function toggleFavorite(text) {
  const i = data.favorites.indexOf(text);
  if (i === -1) data.favorites.push(text);
  else data.favorites.splice(i, 1);
  saveData();
  flashContext(i === -1 ? "Added to Favorites" : "Removed from Favorites");
  render({ keepSelection: true });
}

function deleteCustom(text) {
  data.custom = data.custom.filter((t) => t !== text);
  saveData();
  flashContext("Deleted");
  render({ keepSelection: true });
}

function forgetUsage(text) {
  delete data.usage[text];
  saveData();
  flashContext("Removed from Frequently Used");
  render({ keepSelection: true });
}

// ---------- popover (actions + category picker) ----------

let popoverKind = null;
let popoverItems = [];
let popoverActive = -1;

// items: [{ label, keys?, dot?, checked?, danger?, run }] | "sep" | { title }
function openPopover(kind, items, place) {
  popoverKind = kind;
  popoverItems = [];
  popoverEl.innerHTML = "";

  for (const item of items) {
    if (item === "sep") {
      popoverEl.append(el("div", "popover-sep"));
      continue;
    }
    if (item.title) {
      popoverEl.append(el("div", "popover-title", item.title));
      continue;
    }
    const btn = el("button", "popover-item" + (item.danger ? " danger" : ""));
    if (item.dot) {
      const dot = el("span", "dot");
      dot.style.setProperty("--dot-color", item.dot);
      btn.append(dot);
    }
    btn.append(el("span", "label", item.label));
    if (item.checked) btn.append(el("span", "check", "✓"));
    if (item.keys) {
      const keys = el("span", "keys");
      item.keys.forEach((k) => keys.append(el("kbd", "", k)));
      btn.append(keys);
    }
    const index = popoverItems.length;
    btn.addEventListener("mousemove", (e) => {
      if (pointerMoved(e)) setPopoverActive(index);
    });
    btn.addEventListener("click", () => runPopoverItem(index));
    popoverEl.append(btn);
    popoverItems.push({ ...item, btn });
  }

  popoverEl.hidden = false;
  const appW = appEl.clientWidth;
  const appH = appEl.clientHeight;
  const w = popoverEl.offsetWidth;
  const h = popoverEl.offsetHeight;
  let x;
  let y;
  if (place === "actions") {
    x = appW - w - 8;
    y = appH - h - 48;
  } else if (place === "category") {
    const r = categoryBtn.getBoundingClientRect();
    const a = appEl.getBoundingClientRect();
    x = r.right - a.left - w;
    y = r.bottom - a.top + 6;
  } else {
    x = place.x;
    y = place.y;
  }
  popoverEl.style.left = `${Math.max(6, Math.min(x, appW - w - 6))}px`;
  popoverEl.style.top = `${Math.max(6, Math.min(y, appH - h - 6))}px`;

  const checkedIndex = popoverItems.findIndex((i) => i.checked);
  setPopoverActive(checkedIndex >= 0 ? checkedIndex : 0);
  categoryBtn.classList.toggle("open", kind === "category");
}

function setPopoverActive(index) {
  popoverItems[popoverActive]?.btn.classList.remove("active");
  popoverActive = (index + popoverItems.length) % popoverItems.length;
  const item = popoverItems[popoverActive];
  item?.btn.classList.add("active");
  item?.btn.scrollIntoView({ block: "nearest" });
}

function runPopoverItem(index) {
  const item = popoverItems[index];
  closePopover();
  item?.run();
}

function closePopover() {
  if (!popoverKind) return;
  popoverKind = null;
  popoverEl.hidden = true;
  categoryBtn.classList.remove("open");
}

function openActions(place = "actions") {
  const tile = flat[selected];
  if (!tile) {
    openPopover("actions", [{ label: "Add Custom Kaomoji…", run: startAddingCustom }], place);
    return;
  }
  const text = tile.dataset.text;
  const paste = { label: "Paste into Last App", run: () => useKaomoji(text, tile, "paste") };
  const copy = { label: "Copy to Clipboard", run: () => useKaomoji(text, tile, "copy") };
  const [primary, secondary] = data.prefs.autoPaste ? [paste, copy] : [copy, paste];
  const isFav = data.favorites.includes(text);

  const items = [
    { title: text },
    { ...primary, keys: ["↵"] },
    { ...secondary, keys: ["Ctrl", "↵"] },
    "sep",
    { label: isFav ? "Remove from Favorites" : "Add to Favorites", keys: ["Ctrl", "D"], run: () => toggleFavorite(text) },
  ];
  if (tile.dataset.kind === "frequent") items.push({ label: "Remove from Frequently Used", run: () => forgetUsage(text) });
  items.push("sep", { label: "Add Custom Kaomoji…", run: startAddingCustom });
  if (tile.dataset.kind === "custom") items.push({ label: "Delete", danger: true, run: () => deleteCustom(text) });
  openPopover("actions", items, place);
}

function openCategories() {
  const items = [
    { label: "All Categories", checked: categoryFilter === "all", run: () => setCategory("all") },
    "sep",
    ...allSections().map((s) => ({
      label: s.label,
      dot: s.color,
      checked: categoryFilter === s.id,
      run: () => setCategory(s.id),
    })),
  ];
  openPopover("category", items, "category");
}

categoryBtn.addEventListener("click", () => (popoverKind === "category" ? closePopover() : openCategories()));

document.addEventListener("mousedown", (e) => {
  if (popoverKind && !popoverEl.contains(e.target) && !categoryBtn.contains(e.target) && !actionsBtn.contains(e.target)) {
    closePopover();
  }
});
// Wheel rather than scroll: programmatic scrolls (scrollIntoView) fire a
// late scroll event that would close a popover that just opened.
contentEl.addEventListener("wheel", () => popoverKind === "actions" && closePopover(), { passive: true });

// ---------- keyboard ----------

document.addEventListener("keydown", (e) => {
  if (!settingsPanel.hidden) {
    if (recordingHotkey) {
      handleHotkeyRecording(e);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSettings();
    }
    return;
  }

  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  if (ctrl && key === "k") {
    e.preventDefault();
    popoverKind === "actions" ? closePopover() : openActions();
    return;
  }
  if (ctrl && key === "p") {
    e.preventDefault();
    popoverKind === "category" ? closePopover() : openCategories();
    return;
  }

  if (popoverKind) {
    if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) setPopoverActive(popoverActive + 1);
    else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) setPopoverActive(popoverActive - 1);
    else if (e.key === "Enter") runPopoverItem(popoverActive);
    else if (e.key === "Escape") closePopover();
    else return;
    e.preventDefault();
    return;
  }

  if (ctrl && e.key === "Enter") {
    e.preventDefault();
    runSecondary(selected);
    return;
  }
  if (ctrl && key === "d") {
    e.preventDefault();
    const tile = flat[selected];
    if (tile) toggleFavorite(tile.dataset.text);
    return;
  }

  const digit = /^[1-9]$/.test(e.key) ? Number(e.key) : 0;
  if (digit && (ctrl || e.altKey || !searchEl.value)) {
    e.preventDefault();
    runPrimary(digit - 1);
    return;
  }

  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      moveVertical(1);
      return;
    case "ArrowUp":
      e.preventDefault();
      moveVertical(-1);
      return;
    case "ArrowRight":
      e.preventDefault();
      select(selected + 1);
      return;
    case "ArrowLeft":
      e.preventDefault();
      select(selected - 1);
      return;
    case "Tab":
      e.preventDefault();
      select(e.shiftKey ? selected - 1 : selected + 1);
      return;
    case "Enter":
      e.preventDefault();
      runPrimary(selected);
      return;
    case "Escape":
      e.preventDefault();
      if (searchEl.value) {
        searchEl.value = "";
        render();
      } else if (categoryFilter !== "all") {
        setCategory("all");
      } else {
        hideWindow();
      }
      return;
  }

  // Typing anywhere goes to search. Only move focus: the browser then types
  // the character into the input itself.
  if (document.activeElement !== searchEl && e.key.length === 1 && !ctrl && !e.altKey) {
    searchEl.focus();
  }
});

searchEl.addEventListener("input", () => {
  contentEl.scrollTop = 0;
  render();
});

// No browser context menu (reload/inspect) anywhere except text inputs.
document.addEventListener("contextmenu", (e) => {
  if (!e.target.closest("input")) e.preventDefault();
});

// ---------- settings ----------

let recordingHotkey = false;
let hotkeyLabel = "";

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  for (const btn of themeSegmented.children) {
    btn.classList.toggle("active", btn.dataset.theme === theme);
  }
}

function applyPrefs() {
  stayOpenToggle.checked = data.prefs.stayOpen;
  autoPasteToggle.checked = data.prefs.autoPaste;
  soundToggle.checked = data.prefs.sound;
  applyTheme(data.prefs.theme);
  updatePrimaryLabel();
}

function bindPref(toggle, key) {
  toggle.addEventListener("change", () => {
    data.prefs[key] = toggle.checked;
    saveData();
    updatePrimaryLabel();
  });
}
bindPref(stayOpenToggle, "stayOpen");
bindPref(autoPasteToggle, "autoPaste");
bindPref(soundToggle, "sound");

themeSegmented.addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  data.prefs.theme = btn.dataset.theme;
  applyTheme(data.prefs.theme);
  saveData();
});

function openSettings() {
  closePopover();
  settingsPanel.hidden = false;
}

function closeSettings() {
  if (recordingHotkey) cancelHotkeyRecording();
  settingsPanel.hidden = true;
  searchEl.focus();
}

settingsBtn.addEventListener("click", openSettings);
settingsBackBtn.addEventListener("click", closeSettings);

function showHotkeyLabel(label) {
  hotkeyLabel = label;
  hotkeyBtn.textContent = label;
}

async function loadBackendSettings() {
  try {
    const settings = await invoke("get_settings");
    autostartToggle.checked = Boolean(settings.autostart);
    showHotkeyLabel(settings.hotkey.label);
  } catch (err) {
    console.error("couldn't load settings", err);
  }
}

autostartToggle.addEventListener("change", async () => {
  const desired = autostartToggle.checked;
  try {
    await invoke("set_autostart", { enabled: desired });
  } catch {
    autostartToggle.checked = !desired;
    hotkeyHint.textContent = "Couldn't update the startup setting";
  }
});

const MODIFIER_CODES = new Set([
  "ControlLeft", "ControlRight", "AltLeft", "AltRight",
  "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight",
]);

function codeToLabel(code) {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return code;
}

hotkeyBtn.addEventListener("click", () => {
  if (recordingHotkey) return;
  recordingHotkey = true;
  // Otherwise pressing the current combo would hide the window mid-recording.
  invoke("pause_hotkey").catch(() => {});
  hotkeyBtn.classList.add("recording");
  hotkeyBtn.textContent = "Press keys…";
  hotkeyHint.textContent = "Include Ctrl, Alt, Shift or Win · Esc to cancel";
});

function cancelHotkeyRecording() {
  recordingHotkey = false;
  hotkeyBtn.classList.remove("recording");
  hotkeyBtn.textContent = hotkeyLabel;
  hotkeyHint.textContent = "";
  invoke("resume_hotkey").catch(() => {});
}

async function handleHotkeyRecording(e) {
  e.preventDefault();
  if (MODIFIER_CODES.has(e.code)) return;
  if (e.code === "Escape") {
    cancelHotkeyRecording();
    return;
  }

  const combo = { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey, code: e.code };
  if (!combo.ctrl && !combo.alt && !combo.shift && !combo.meta) {
    hotkeyHint.textContent = "Needs a modifier key — try again";
    return;
  }

  const parts = [];
  if (combo.ctrl) parts.push("Ctrl");
  if (combo.alt) parts.push("Alt");
  if (combo.shift) parts.push("Shift");
  if (combo.meta) parts.push("Win");
  parts.push(codeToLabel(combo.code));
  combo.label = parts.join("+");

  recordingHotkey = false;
  hotkeyBtn.classList.remove("recording");
  try {
    await invoke("set_hotkey", { hotkey: combo });
    showHotkeyLabel(combo.label);
    hotkeyHint.textContent = "Saved";
    setTimeout(() => (hotkeyHint.textContent = ""), 1500);
  } catch (err) {
    // The backend has already put the previous hotkey back.
    hotkeyBtn.textContent = hotkeyLabel;
    hotkeyHint.textContent = String(err);
  }
}

// ---------- window lifecycle ----------

function onShown() {
  if (!settingsPanel.hidden) closeSettings();
  closePopover();
  addingCustom = false;
  searchEl.value = "";
  setCategory("all");
  setTimeout(() => searchEl.focus(), 0);
}

(async () => {
  window.__TAURI__.event.listen("shown", onShown);
  await loadData();
  applyPrefs();
  setCategory("all");
  loadBackendSettings();
  searchEl.focus();
})();
