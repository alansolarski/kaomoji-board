import { categories as rawCategories } from "./kaomoji-data.js";
import { icon } from "./icons.js";

const $ = (id) => document.getElementById(id);
const appEl = $("app");
const searchEl = $("search");
const contentEl = $("content");
const faceEl = $("face");
const contextEl = $("context");
const categoryBtn = $("categoryBtn");
const categoryLabel = $("categoryLabel");
const categoryIconSlot = $("categoryIcon");
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
const markdownSegmented = $("markdownSegmented");
const autostartToggle = $("autostartToggle");
const themeSegmented = $("themeSegmented");
const densitySegmented = $("densitySegmented");
const hotkeyBtn = $("hotkeyBtn");
const hotkeyHint = $("hotkeyHint");
const versionLabel = $("versionLabel");
const updateHint = $("updateHint");
const updateBtn = $("updateBtn");
const dataDirHint = $("dataDirHint");
const dataDirBtn = $("dataDirBtn");
const dataDirResetBtn = $("dataDirResetBtn");

const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);

const FACE_HAPPY = "(ﾉ◕ヮ◕)ﾉ";
const FACE_SAD = "(｡•́︿•̀｡)";
const FACE_CELEBRATE = "(ﾉ◕ヮ◕)ﾉ*:･ﾟ✧";

// The corner face's resting expression follows the time of day.
function idleFace(hour = new Date().getHours()) {
  if (hour >= 23 || hour < 5) return "(－ω－) zzZ";
  if (hour < 9) return "( ˘▽˘)っ♨";
  return "( ˘ω˘ )";
}


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

const DEFAULT_PREFS = {
  stayOpen: false,
  autoPaste: false,
  markdown: "chat", // escape Markdown: "off" | "chat" (only in chat apps) | "always"
  sound: true,
  theme: "auto",
  density: "comfortable",
};
let data = normalize({});
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

function normalize(source) {
  const usage = source.usage && typeof source.usage === "object" ? source.usage : {};
  return {
    version: 1,
    favorites: Array.isArray(source.favorites) ? source.favorites : [],
    custom: Array.isArray(source.custom) ? source.custom : [],
    // Your own search keywords, for any kaomoji: { text: ["word", …] }.
    tags: source.tags && typeof source.tags === "object" ? source.tags : {},
    usage,
    prefs: { ...DEFAULT_PREFS, ...(source.prefs || {}) },
    stats: normalizeStats(source.stats, usage),
  };
}

// All-time history for the stats page. Unlike `usage` it never decays or
// gets pruned. Data from before stats existed is seeded from usage counts.
function normalizeStats(stats, usage) {
  if (stats && typeof stats === "object") {
    return {
      since: stats.since || Date.now(),
      first: stats.first || null,
      counts: stats.counts || {},
      days: stats.days || {},
    };
  }
  const counts = {};
  for (const [text, u] of Object.entries(usage)) counts[text] = u.c;
  return { since: Date.now(), first: null, counts, days: {} };
}

function dayKey(time = Date.now()) {
  const d = new Date(time);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Called at startup and every time the window opens, so edits made on
// another computer (via a synced folder) show up on the next peek. Returns
// whether the data differs from what's already on screen.
async function loadData({ initial = false } = {}) {
  let stored;
  try {
    stored = await invoke("load_data");
  } catch (err) {
    // Leave the file alone; running on what we have beats clobbering it.
    console.error("couldn't load data.json", err);
    flashContext(String(err), 4000);
    return false;
  }
  const before = dataLoaded ? JSON.stringify(data) : null;
  if (stored) {
    data = normalize(stored);
  } else if (initial) {
    data = normalize(readLegacyData() ?? {});
  }
  dataLoaded = true;
  // No file yet (first run, or it was deleted): write out what we have.
  if (!stored) saveData();
  return JSON.stringify(data) !== before;
}

function saveData() {
  if (!dataLoaded) return;
  invoke("save_data", { data }).catch((err) => {
    console.error("couldn't save data.json", err);
    flashContext(String(err), 4000);
  });
}

// Combines this app's data with data found in a newly chosen folder, so
// pointing a second computer at the same folder loses nothing: lists are
// unioned (the folder's order first) and usage keeps the higher count and
// the latest time. This computer's preferences win.
function mergeData(mine, theirs) {
  if (!theirs) return mine;
  const union = (a, b) => [...new Set([...a, ...b])];
  const maxMerge = (a, b) => {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] || 0, v);
    return out;
  };
  const usage = { ...theirs.usage };
  for (const [text, u] of Object.entries(mine.usage)) {
    const other = usage[text];
    usage[text] = other ? { c: Math.max(u.c, other.c), t: Math.max(u.t, other.t) } : u;
  }
  const tags = { ...theirs.tags };
  for (const [text, kws] of Object.entries(mine.tags)) tags[text] = union(tags[text] || [], kws);
  const firsts = [mine.stats.first, theirs.stats.first].filter(Boolean);
  return {
    version: 1,
    favorites: union(theirs.favorites, mine.favorites),
    custom: union(theirs.custom, mine.custom),
    tags,
    usage,
    prefs: { ...mine.prefs },
    stats: {
      since: Math.min(mine.stats.since, theirs.stats.since),
      first: firsts.sort((a, b) => a.t - b.t)[0] || null,
      counts: maxMerge(theirs.stats.counts, mine.stats.counts),
      days: maxMerge(theirs.stats.days, mine.stats.days),
    },
  };
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
  const now = Date.now();
  const prev = data.usage[text] || { c: 0, t: 0 };
  data.usage[text] = { c: prev.c + 1, t: now };

  const stats = data.stats;
  const firstToday = !stats.days[dayKey(now)];
  stats.counts[text] = (stats.counts[text] || 0) + 1;
  stats.days[dayKey(now)] = (stats.days[dayKey(now)] || 0) + 1;
  if (!stats.first) stats.first = { text, t: now };
  pendingCelebration = milestoneReached(firstToday) ?? pendingCelebration;

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

// Round-number totals and streak lengths get a little celebration from the
// face. Usually the board hides right after a copy, so it's shown the next
// time it opens.
const TOTAL_MILESTONES = [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const STREAK_MILESTONES = [3, 7, 14, 30, 50, 100, 200, 365];
let pendingCelebration = null;

function milestoneReached(firstToday) {
  const total = Object.values(data.stats.counts).reduce((a, b) => a + b, 0);
  if (TOTAL_MILESTONES.includes(total)) return `${total.toLocaleString()} kaomoji copied!`;
  // Streaks only grow on the first copy of a day.
  if (firstToday) {
    const { current } = streaks(data.stats.days);
    if (STREAK_MILESTONES.includes(current)) return `${current}-day streak!`;
  }
  return null;
}

function celebrate() {
  if (!pendingCelebration) return;
  const message = pendingCelebration;
  pendingCelebration = null;
  clearTimeout(faceTimer);
  faceEl.textContent = FACE_CELEBRATE;
  faceEl.classList.add("celebrate");
  flashContext(message, 3200);
  faceTimer = setTimeout(() => {
    faceTimer = null;
    faceEl.textContent = idleFace();
    faceEl.classList.remove("celebrate");
  }, 3200);
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
      entry = { text, order: byText.size, keywords: new Set(), yours: new Set() };
      byText.set(text, entry);
    }
    keywords.forEach((k) => entry.keywords.add(k));
  };
  for (const cat of categories) {
    cat.entries.forEach((e) => add(e.text, e.keywords));
  }
  data.custom.forEach((t) => add(t, ["custom"]));
  data.favorites.forEach((t) => add(t, ["favorite", "favourite"]));
  for (const [text, kws] of Object.entries(data.tags)) {
    const entry = byText.get(text); // skip keywords left over from deleted kaomoji
    if (entry) kws.forEach((k) => (entry.keywords.add(k), entry.yours.add(k)));
  }
  return [...byText.values()];
}

// Returns [quality, keyword that matched]. 4 = one of your own keywords,
// exactly; 3 = exact keyword; 2 = keyword prefix; 1 = appears in the
// kaomoji itself (no keyword).
function matchQuality(entry, token) {
  if (entry.yours.has(token)) return [4, token];
  let best = entry.text.toLowerCase().includes(token) ? 1 : 0;
  let matched = null;
  for (const kw of entry.keywords) {
    if (kw === token) return [3, kw];
    if (best < 2 && kw.startsWith(token)) {
      best = 2;
      matched = kw;
    }
  }
  return [best, matched];
}

// Edit distance counting a swap of neighbours as one edit ("hpapy"), with
// an early exit once it can't come in under `max`.
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2] + 1);
      row.push(d);
      rowMin = Math.min(rowMin, d);
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = row;
  }
  return prev[b.length];
}

// Typo tolerance, only used when an exact search finds nothing: a keyword
// (or the start of one, for longer words) within one or two typos.
function fuzzyKeyword(entry, token) {
  if (token.length < 4) return null;
  const max = token.length >= 7 ? 2 : 1;
  for (const kw of entry.keywords) {
    if (editDistance(token, kw, max) <= max) return kw;
    if (token.length >= 5 && kw.length > token.length && editDistance(token, kw.slice(0, token.length), max) <= max) {
      return kw;
    }
  }
  return null;
}

// Returns matching kaomoji, best first, and for each the keywords that
// matched (shown in the action bar).
function search(query, within, { fuzzy = false } = {}) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const now = Date.now();
  const results = [];
  for (const entry of buildIndex()) {
    if (within && !within.has(entry.text)) continue;
    let total = 0;
    const matched = [];
    for (const token of tokens) {
      let [q, kw] = matchQuality(entry, token);
      if (!q && fuzzy) {
        kw = fuzzyKeyword(entry, token);
        q = kw ? 1 : 0;
      }
      if (!q) {
        total = 0;
        break;
      }
      total += q;
      if (kw && !matched.includes(kw)) matched.push(kw);
    }
    if (total) results.push({ entry, total, matched, score: usageScore(entry.text, now) });
  }
  results.sort((a, b) => b.total - a.total || b.score - a.score || a.entry.order - b.entry.order);
  return {
    items: results.map((r) => r.entry.text),
    matches: new Map(results.map((r) => [r.entry.text, r.matched])),
  };
}

// Categories and keywords for each kaomoji, for Quick Look.
const kaomojiInfo = new Map();
for (const cat of rawCategories) {
  for (const item of cat.items) {
    const [text, keywords] = typeof item === "string" ? [item, ""] : item;
    let info = kaomojiInfo.get(text);
    if (!info) kaomojiInfo.set(text, (info = { categories: [], keywords: new Set() }));
    info.categories.push(cat.name);
    words(keywords).forEach((w) => info.keywords.add(w));
  }
}

// ---------- sections + category filter ----------

let categoryFilter = "all";

function allSections() {
  const sections = [];
  const frequent = frequentItems();
  if (frequent.length) {
    sections.push({ id: "frequent", label: "Frequently Used", icon: "frequent", items: frequent, kind: "frequent" });
  }
  sections.push({ id: "favorites", label: "Favorites", icon: "favorites", items: data.favorites, kind: "favorites" });
  categories.forEach((cat, i) => {
    sections.push({ id: `cat-${i}`, label: cat.name, icon: cat.name, items: cat.items, kind: "category" });
  });
  sections.push({ id: "custom", label: "Custom", icon: "custom", items: data.custom, kind: "custom" });
  return sections;
}

function visibleSections(query) {
  const sections = allSections();
  const filtered = categoryFilter === "all" ? null : sections.find((s) => s.id === categoryFilter);

  if (query) {
    const within = filtered ? new Set(filtered.items) : null;
    let found = search(query, within);
    let label = filtered ? `Results in ${filtered.label}` : "Results";
    if (!found.items.length) {
      found = search(query, within, { fuzzy: true });
      if (found.items.length) label = filtered ? `Closest Matches in ${filtered.label}` : "Closest Matches";
    }
    return [{ id: "results", label, items: found.items, matches: found.matches, kind: "results" }];
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
  categoryIconSlot.replaceChildren(icon(section ? section.icon : "all"));
  contentEl.scrollTop = 0;
  render();
}

// ---------- rendering ----------

let flat = []; // every copyable tile, in visual order
let selected = -1;

function render({ keepSelection = false } = {}) {
  const query = searchEl.value.trim();
  const sections = visibleSections(query);
  const prevSelected = selected;
  const prevTile = flat[selected];
  const favorites = new Set(data.favorites);
  flat = [];
  fallbackAction = null;
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
      tiles.append(el("div", "empty", "No kaomoji match that search"), buildFallback(query));
    }
    wrap.append(tiles);
    contentEl.append(wrap);
  }

  applySpans();
  watchStuckHeadings();

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

  if (!faceTimer) faceEl.textContent = query && !flat.length ? FACE_SAD : idleFace();
}

// Section headings stick at top: -1px, so a pinned one is 1px out of view
// and no longer fully visible; that's when it gets the "stuck" backing.
const stuckObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const pinned = entry.intersectionRatio < 1 && entry.boundingClientRect.top < entry.rootBounds.top + 1;
      entry.target.classList.toggle("stuck", pinned);
    }
  },
  { root: contentEl, threshold: [1] }
);

function watchStuckHeadings() {
  stuckObserver.disconnect();
  contentEl.querySelectorAll(".section-head").forEach((head) => stuckObserver.observe(head));
}

// Long kaomoji get two cells, and the few that still don't fit get the whole
// row. Whether one fits depends only on its text and the tile size, so each
// is measured once per density and remembered. Measuring forces layout and
// was most of the cost of a render.
const spanCache = new Map(); // "density|text" -> "normal" | "wide" | "full"

function applySpans() {
  const density = data.prefs.density;
  const unknown = [];
  for (const tile of flat) {
    const span = spanCache.get(`${density}|${tile.dataset.text}`);
    if (span === undefined) unknown.push(tile);
    else if (span !== "normal") tile.classList.add("wide", ...(span === "full" ? ["full"] : []));
  }
  // Nothing to measure against while the page has no width; don't cache junk.
  if (!unknown.length || !contentEl.clientWidth) return;

  // Read all widths before writing so each pass lays out once.
  const overflows = (tile) => tile.scrollWidth > tile.clientWidth;
  const wide = unknown.filter(overflows);
  wide.forEach((tile) => tile.classList.add("wide"));
  const full = new Set(wide.filter(overflows));
  full.forEach((tile) => tile.classList.add("full"));

  const wideSet = new Set(wide);
  for (const tile of unknown) {
    const span = full.has(tile) ? "full" : wideSet.has(tile) ? "wide" : "normal";
    spanCache.set(`${density}|${tile.dataset.text}`, span);
  }
}

function buildTile(text, sec, indexInSection, favorites) {
  const tile = el("button", "tile", text);
  tile.title = text;
  tile.dataset.text = text;
  tile.dataset.section = sec.id;
  tile.dataset.sectionLabel = sec.kind === "results" ? "Search Results" : sec.label;
  tile.dataset.kind = sec.kind;
  const matched = sec.matches?.get(text);
  if (matched?.length) tile.dataset.match = matched.map((kw) => `“${kw}”`).join(", ");
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
  const btn = el("button", "tile add");
  btn.append(icon("ui:add", 14), el("span", "", "Add your own"));
  btn.addEventListener("click", () => openEditor());
  return btn;
}

// When a search finds nothing, offer to add a kaomoji that it would find.
// Enter runs it, since there's no tile to select.
let fallbackAction = null;

function buildFallback(query) {
  // Letters and spaces are keywords; anything else is probably a kaomoji
  // pasted into the search.
  const isWords = /^[\p{L}\p{N}\s,]+$/u.test(query);
  const btn = el("button", "tile fallback");
  const label = isWords ? `Add a kaomoji for “${query}”` : `Add “${query}” to Custom`;
  btn.append(icon("ui:add", 14), el("span", "fallback-label", label), el("kbd", "", "↵"));
  fallbackAction = () => openEditor(isWords ? { keywords: query } : { text: query });
  btn.addEventListener("click", fallbackAction);
  return btn;
}

// ---------- keyword editor ----------

// One small dialog for adding a custom kaomoji and for giving any kaomoji
// your own search keywords.
const editorEl = $("editor");
let editor = null; // { text, isNew, textInput?, keywordsInput }

function openEditor({ text = "", keywords = "", existing = false } = {}) {
  closePopover();
  closePreview();
  const card = el("div", "overlay-card editor-card");
  card.append(el("div", "editor-title", existing ? "Edit Keywords" : "Add Custom Kaomoji"));

  let textInput = null;
  if (existing) {
    card.append(el("div", "editor-kaomoji kaomoji-font", text));
  } else {
    textInput = el("input", "editor-input kaomoji-font");
    textInput.placeholder = "Paste or type a kaomoji";
    textInput.value = text;
    card.append(field("Kaomoji", textInput));
  }

  const keywordsInput = el("input", "editor-input");
  keywordsInput.placeholder = "e.g. smug, lenny, gotcha";
  keywordsInput.value = existing ? (data.tags[text] || []).join(", ") : keywords;
  const builtIn = kaomojiInfo.get(text);
  const hint = builtIn?.keywords.size
    ? `Already found by: ${[...builtIn.keywords].join(", ")}`
    : "Search finds it by these words";
  card.append(field("Keywords", keywordsInput, hint));

  const footer = el("div", "overlay-hint");
  footer.append(hintKeys("Save", "↵"), hintKeys("Cancel", "Esc"));
  card.append(footer);

  for (const input of [textInput, keywordsInput].filter(Boolean)) {
    input.spellcheck = false;
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") saveEditor();
      else if (e.key === "Escape") closeEditor();
    });
  }

  editor = { text, isNew: !existing, textInput, keywordsInput };
  editorEl.replaceChildren(card);
  editorEl.hidden = false;
  // Start where the typing is still to do.
  (textInput && !textInput.value ? textInput : keywordsInput).focus();
}

function field(label, input, hint) {
  const wrap = el("label", "editor-field");
  wrap.append(el("span", "editor-label", label), input);
  if (hint) wrap.append(el("span", "editor-hint", hint));
  return wrap;
}

function hintKeys(label, ...caps) {
  const group = el("span");
  caps.forEach((c) => group.append(el("kbd", "", c)));
  group.append(el("span", "", label));
  return group;
}

function saveEditor() {
  const text = editor.textInput ? editor.textInput.value.trim() : editor.text;
  if (!text) return editor.textInput.focus();
  const keywords = [...new Set(words(editor.keywordsInput.value))];
  const adding = editor.isNew;
  const isNew = adding && !data.custom.includes(text) && !kaomojiInfo.has(text);
  if (isNew) data.custom.push(text);
  if (keywords.length) data.tags[text] = keywords;
  else delete data.tags[text];
  closeEditor();
  saveData();

  // Show where it went: in the results if there's a search (which now finds
  // it), otherwise in Custom.
  if (isNew && !searchEl.value.trim()) setCategory("custom");
  else render({ keepSelection: true });
  const index = flat.findIndex((t) => t.dataset.text === text);
  if (index >= 0) select(index);
  const home = kaomojiInfo.get(text)?.categories[0] ?? "Custom";
  flashContext(isNew ? "Added to Custom" : adding ? `Already in ${home} · keywords saved` : "Keywords saved");
}

function closeEditor() {
  if (!editor) return;
  editor = null;
  editorEl.hidden = true;
  searchEl.focus();
}

editorEl.addEventListener("mousedown", (e) => {
  if (e.target === editorEl) closeEditor();
});

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
  if (previewOpen) renderPreview();
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
  if (!tile) contextEl.textContent = "Kaomoji";
  else if (tile.dataset.match) contextEl.textContent = `Kaomoji – matched ${tile.dataset.match}`;
  else contextEl.textContent = `Kaomoji – ${tile.dataset.sectionLabel}`;
}

function flashContext(message, ms = 1400) {
  clearTimeout(contextTimer);
  pendingUndo = null;
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

// A soft rising two-note chime (E5 → A5): gentle fade-in, a slight upward
// glide, and only a whisper of octave overtone, filtered to take the edge
// off. Takes any audio context so it can also be rendered offline.
export function synthCopySound(ctx, destination, t0 = ctx.currentTime) {
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 2500;
  filter.connect(destination);

  const note = (freq, start, dur, peak) => {
    for (const [mult, level, len] of [[1, 1, dur], [2, 0.06, dur * 0.5]]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t = t0 + start;
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq * mult * 0.97, t);
      osc.frequency.exponentialRampToValueAtTime(freq * mult, t + 0.04);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak * level, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + len);
      osc.connect(gain).connect(filter);
      osc.start(t);
      osc.stop(t + len + 0.02);
    }
  };
  note(659.25, 0, 0.2, 0.045);
  note(880, 0.075, 0.28, 0.036);
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
    faceEl.textContent = idleFace();
  }, 900);

  const md = data.prefs.markdown;
  const output = md === "always" || (md === "chat" && fromMarkdownApp) ? escapeMarkdown(text) : text;
  try {
    if (mode === "paste") {
      await invoke("paste_kaomoji", { text: output });
      showHud("Pasted", text);
      return;
    }
    await window.__TAURI__.clipboardManager.writeText(output);
  } catch (err) {
    console.error("copy failed", err);
    flashContext("Couldn't copy (｡•́︿•̀｡)", 2500);
    return;
  }
  flashContext("Copied to clipboard");
  if (!data.prefs.stayOpen) {
    setTimeout(() => {
      hideWindow();
      showHud("Copied", text);
    }, 90);
  } else if (pendingCelebration) setTimeout(celebrate, 700);
}

// Set by the backend each time the board opens: whether the app it was
// opened from is a chat app that reads Markdown (Discord, Slack, …).
let fromMarkdownApp = false;

// Discord (like most chat apps) reads * _ ~ ` | \ as Markdown, which eats
// arms (¯\_(ツ)_/¯) and italicizes whatever sits between two (*^▽^*). A
// backslash before each shows it as typed. A leading > # or - would start a
// quote, heading or list.
export function escapeMarkdown(text) {
  return text.replace(/[\\*_~`|]/g, "\\$&").replace(/^[>#-]/, "\\$&");
}

// The board is gone by now, so a little pill above the taskbar confirms it.
function showHud(label, text) {
  invoke("show_hud", { label, text, dark: isDark() }).catch(() => {});
}

function isDark() {
  const theme = data.prefs.theme;
  return theme === "dark" || (theme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
}

function hideWindow() {
  invoke("hide_window");
}

function commit() {
  saveData();
  render({ keepSelection: true });
}

// Each undo puts back just the one thing it removed, in its old position,
// so anything else done in the meantime survives.
function toggleFavorite(text) {
  const i = data.favorites.indexOf(text);
  if (i === -1) {
    data.favorites.push(text);
    flashContext("Added to Favorites");
  } else {
    data.favorites.splice(i, 1);
    offerUndo("Removed from Favorites", () => {
      if (!data.favorites.includes(text)) data.favorites.splice(i, 0, text);
    });
  }
  commit();
}

// Nudges a favorite one place earlier (-1) or later (+1).
function moveFavorite(text, delta) {
  const from = data.favorites.indexOf(text);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= data.favorites.length) return;
  data.favorites.splice(from, 1);
  data.favorites.splice(to, 0, text);
  commit();
  flat[selected]?.scrollIntoView({ block: "nearest" });
}

function deleteCustom(text) {
  const i = data.custom.indexOf(text);
  if (i === -1) return;
  data.custom.splice(i, 1);
  offerUndo("Deleted from Custom", () => {
    if (!data.custom.includes(text)) data.custom.splice(i, 0, text);
  });
  commit();
}

function forgetUsage(text) {
  const saved = data.usage[text];
  delete data.usage[text];
  offerUndo("Removed from Frequently Used", () => {
    if (saved && !data.usage[text]) data.usage[text] = saved;
  });
  commit();
}

// ---------- undo ----------

const UNDO_MS = 6000;
let pendingUndo = null;

function offerUndo(message, restore) {
  clearTimeout(contextTimer);
  pendingUndo = restore;
  contextEl.textContent = "";
  const btn = el("button", "undo-btn", "Undo");
  btn.addEventListener("click", runUndo);
  contextEl.append(el("span", "", message), btn, el("kbd", "", "Ctrl"), el("kbd", "", "Z"));
  // Reuses the context timer so selection changes don't overwrite the offer.
  contextTimer = setTimeout(clearUndo, UNDO_MS);
}

function clearUndo() {
  pendingUndo = null;
  clearTimeout(contextTimer);
  contextTimer = null;
  updateContext();
}

function runUndo() {
  const restore = pendingUndo;
  if (!restore) return false;
  clearUndo();
  restore();
  commit();
  flashContext("Restored");
  return true;
}

// ---------- popover (actions + category picker) ----------

let popoverKind = null;
let popoverItems = [];
let popoverActive = -1;

// items: [{ label, icon?, keys?, checked?, danger?, run }] | "sep" | { title }
// With `searchable`, a field at the top filters items by label as you type.
function openPopover(kind, items, place, { searchable = false } = {}) {
  popoverKind = kind;
  popoverEl.innerHTML = "";
  popoverEl.dataset.place = typeof place === "string" ? place : "cursor";

  let searchInput = null;
  if (searchable) {
    const wrap = el("div", "popover-search");
    searchInput = el("input");
    searchInput.placeholder = "Search…";
    searchInput.spellcheck = false;
    wrap.append(icon("ui:search", 13), searchInput);
    popoverEl.append(wrap);
  }
  const list = el("div", "popover-list");
  popoverEl.append(list);

  const renderItems = (filter = "") => {
    const query = filter.trim().toLowerCase();
    list.innerHTML = "";
    popoverItems = [];
    popoverActive = -1;
    for (const item of items) {
      // Headings and separators only make sense in the unfiltered list.
      if (item === "sep") {
        if (!query) list.append(el("div", "popover-sep"));
        continue;
      }
      if (item.title) {
        if (!query) list.append(el("div", "popover-title", item.title));
        continue;
      }
      if (query && !item.label.toLowerCase().includes(query)) continue;

      const btn = el("button", "popover-item" + (item.danger ? " danger" : ""));
      if (item.icon) btn.append(icon(item.icon));
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
      list.append(btn);
      popoverItems.push({ ...item, btn });
    }
    if (!popoverItems.length) list.append(el("div", "popover-empty", "No matches"));
    const checkedIndex = popoverItems.findIndex((i) => i.checked);
    setPopoverActive(!query && checkedIndex >= 0 ? checkedIndex : 0);
  };
  renderItems();
  searchInput?.addEventListener("input", () => renderItems(searchInput.value));

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

  // Restart the entrance animation even if it was already open.
  popoverEl.classList.remove("opening");
  void popoverEl.offsetWidth;
  popoverEl.classList.add("opening");

  categoryBtn.classList.toggle("open", kind === "category");
  searchInput?.focus();
}

function setPopoverActive(index) {
  popoverItems[popoverActive]?.btn.classList.remove("active");
  if (!popoverItems.length) {
    popoverActive = -1;
    return;
  }
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
  // Typing was going into the popover's search; hand focus back.
  if (popoverEl.contains(document.activeElement)) searchEl.focus();
  popoverEl.hidden = true;
  categoryBtn.classList.remove("open");
}

function openActions(place = "actions") {
  const tile = flat[selected];
  const addCustom = { label: "Add Custom Kaomoji…", icon: "ui:add", run: () => openEditor() };
  if (!tile) {
    openPopover("actions", [addCustom], place);
    return;
  }
  const text = tile.dataset.text;
  const paste = { label: "Paste into Last App", icon: "ui:paste", run: () => useKaomoji(text, tile, "paste") };
  const copy = { label: "Copy to Clipboard", icon: "ui:copy", run: () => useKaomoji(text, tile, "copy") };
  const [primary, secondary] = data.prefs.autoPaste ? [paste, copy] : [copy, paste];
  const isFav = data.favorites.includes(text);

  const items = [
    { title: text },
    { ...primary, keys: ["↵"] },
    { ...secondary, keys: ["Ctrl", "↵"] },
    "sep",
    {
      label: isFav ? "Remove from Favorites" : "Add to Favorites",
      icon: isFav ? "ui:unfavorite" : "ui:favorite",
      keys: ["Ctrl", "D"],
      run: () => toggleFavorite(text),
    },
  ];
  if (tile.dataset.kind === "favorites") {
    const at = data.favorites.indexOf(text);
    if (at > 0) {
      items.push({ label: "Move Left", icon: "ui:move-left", keys: ["Ctrl", "Shift", "←"], run: () => moveFavorite(text, -1) });
    }
    if (at < data.favorites.length - 1) {
      items.push({ label: "Move Right", icon: "ui:move-right", keys: ["Ctrl", "Shift", "→"], run: () => moveFavorite(text, 1) });
    }
  }
  if (tile.dataset.kind === "frequent") {
    items.push({ label: "Remove from Frequently Used", icon: "ui:forget", run: () => forgetUsage(text) });
  }
  items.push(
    { label: "Edit Keywords…", icon: "ui:keywords", keys: ["Ctrl", "E"], run: () => editKeywords(text) },
    { label: "Quick Look", icon: "ui:preview", keys: ["Ctrl", "Y"], run: openPreview }
  );
  items.push("sep", addCustom, { label: "Your Stats…", icon: "ui:stats", run: openStats });
  if (tile.dataset.kind === "custom") {
    items.push({ label: "Delete", icon: "ui:delete", danger: true, run: () => deleteCustom(text) });
  }
  openPopover("actions", items, place);
}

function openCategories() {
  const items = [
    { label: "All Categories", icon: "all", checked: categoryFilter === "all", run: () => setCategory("all") },
    "sep",
    ...allSections().map((s) => ({
      label: s.label,
      icon: s.icon,
      checked: categoryFilter === s.id,
      run: () => setCategory(s.id),
    })),
  ];
  openPopover("category", items, "category", { searchable: true });
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

// ---------- Quick Look ----------

// A big view of the selected kaomoji, for the dense ones that are hard to
// read at tile size. Arrow keys keep browsing while it's open.
const previewEl = $("preview");
let previewOpen = false;

function openPreview() {
  if (!flat[selected]) return;
  closePopover();
  previewOpen = true;
  renderPreview();
  previewEl.hidden = false;
}

function closePreview() {
  previewOpen = false;
  previewEl.hidden = true;
}

function renderPreview() {
  const tile = flat[selected];
  if (!tile) return closePreview();
  const text = tile.dataset.text;
  const info = kaomojiInfo.get(text);
  const card = el("div", "overlay-card");
  card.append(el("div", "preview-text kaomoji-font", text));

  const meta = el("div", "preview-meta");
  const places = [...(info?.categories ?? []), ...(data.custom.includes(text) ? ["Custom"] : [])];
  meta.append(el("span", "", places.join(" · ") || tile.dataset.sectionLabel));
  const copies = data.stats.counts[text] || 0;
  meta.append(el("span", "", copies === 0 ? "Not copied yet" : copies === 1 ? "Copied once" : `Copied ${copies} times`));
  if (data.favorites.includes(text)) {
    const fav = el("span", "preview-fav");
    fav.append(icon("favorites", 12), el("span", "", "Favorite"));
    meta.append(fav);
  }
  card.append(meta);

  // Your own keywords first, highlighted.
  const yours = data.tags[text] || [];
  const builtIn = [...(info?.keywords ?? [])].filter((kw) => !yours.includes(kw));
  if (yours.length || builtIn.length) {
    const chips = el("div", "preview-chips");
    yours.forEach((kw) => chips.append(el("span", "chip yours", kw)));
    builtIn.forEach((kw) => chips.append(el("span", "chip", kw)));
    card.append(chips);
  }

  const hint = el("div", "overlay-hint");
  hint.append(
    hintKeys("Browse", "←", "→"),
    hintKeys(primaryLabel.textContent, "↵"),
    hintKeys("Keywords", "Ctrl", "E"),
    hintKeys("Close", "Esc")
  );
  card.append(hint);
  previewEl.replaceChildren(card);
}

function handlePreviewKey(e, ctrl, key) {
  e.preventDefault();
  const tile = flat[selected];
  if (e.key === "Escape" || e.key === " " || (ctrl && key === "y")) closePreview();
  else if (e.key === "ArrowLeft") select(selected - 1);
  else if (e.key === "ArrowRight") select(selected + 1);
  else if (e.key === "ArrowUp") moveVertical(-1);
  else if (e.key === "ArrowDown") moveVertical(1);
  else if (e.key === "Enter") {
    closePreview();
    ctrl ? runSecondary(selected) : runPrimary(selected);
  } else if (ctrl && key === "d" && tile) toggleFavorite(tile.dataset.text);
  else if (ctrl && key === "e" && tile) editKeywords(tile.dataset.text);
}

function editKeywords(text) {
  openEditor({ text, existing: true });
}

previewEl.addEventListener("mousedown", (e) => {
  if (e.target === previewEl) closePreview();
});

// ---------- keyboard ----------

document.addEventListener("keydown", (e) => {
  if (!statsPanel.hidden) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeStats();
    }
    return;
  }
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

  // The editor's own fields handle their keys; this is for clicks elsewhere
  // in the dialog.
  if (editor) {
    if (e.key === "Escape") closeEditor();
    return;
  }
  if (previewOpen) {
    handlePreviewKey(e, ctrl, key);
    return;
  }
  if (ctrl && key === "e") {
    e.preventDefault();
    const tile = flat[selected];
    if (tile) editKeywords(tile.dataset.text);
    return;
  }
  // Space only while the search is empty, so it can still separate words.
  if ((ctrl && key === "y") || (e.key === " " && !searchEl.value && !popoverKind)) {
    e.preventDefault();
    openPreview();
    return;
  }

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
  // Only while an undo is on offer; otherwise Ctrl+Z stays text undo in search.
  if (ctrl && key === "z" && pendingUndo) {
    e.preventDefault();
    runUndo();
    return;
  }
  if (ctrl && key === "d") {
    e.preventDefault();
    const tile = flat[selected];
    if (tile) toggleFavorite(tile.dataset.text);
    return;
  }
  if (ctrl && e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
    e.preventDefault();
    const tile = flat[selected];
    if (tile?.dataset.kind === "favorites") moveFavorite(tile.dataset.text, e.key === "ArrowLeft" ? -1 : 1);
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
      if (flat.length) runPrimary(selected);
      else fallbackAction?.();
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

// ---------- stats ----------

const statsBtn = $("statsBtn");
const statsPanel = $("statsPanel");
const statsBackBtn = $("statsBackBtn");
const statsBody = $("statsBody");

const formatDate = (time) =>
  new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

function streaks(days) {
  const active = new Set(Object.keys(days).filter((d) => days[d] > 0));
  const shift = (key, delta) => {
    const [y, m, d] = key.split("-").map(Number);
    return dayKey(new Date(y, m - 1, d + delta).getTime());
  };
  // A streak is still alive if you haven't copied anything yet today.
  let day = active.has(dayKey()) ? dayKey() : shift(dayKey(), -1);
  let current = 0;
  while (active.has(day)) {
    current++;
    day = shift(day, -1);
  }
  let longest = 0;
  for (const start of active) {
    if (active.has(shift(start, -1))) continue; // not the start of a run
    let len = 0;
    for (let d = start; active.has(d); d = shift(d, 1)) len++;
    longest = Math.max(longest, len);
  }
  return { current, longest, activeDays: active.size };
}

// GitHub-style grid: one column per week (oldest first), Monday at the
// top, ending with the current week. Shades are relative to the busiest day
// shown.
const HEATMAP_WEEKS = 26;

function renderHeatmap(card, days) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weekday = (today.getDay() + 6) % 7; // Monday = 0
  const start = new Date(today);
  start.setDate(start.getDate() - weekday - (HEATMAP_WEEKS - 1) * 7);

  const cells = [];
  for (let i = 0; i < HEATMAP_WEEKS * 7; i++) {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    cells.push({ date, count: date > today ? null : days[dayKey(date.getTime())] || 0 });
  }
  const busiest = Math.max(1, ...cells.map((c) => c.count ?? 0));

  const grid = el("div", "heatmap");
  for (const { date, count } of cells) {
    const cell = el("span", "heat-cell");
    if (count === null) {
      cell.classList.add("future");
    } else {
      cell.dataset.level = count ? String(Math.min(4, Math.ceil((count / busiest) * 4))) : "0";
      cell.title = `${count} ${count === 1 ? "copy" : "copies"} on ${formatDate(date)}`;
    }
    grid.append(cell);
  }

  const legend = el("div", "heat-legend");
  legend.append(el("span", "", "Last 6 months"), el("span", "spacer"), el("span", "", "Less"));
  for (let level = 0; level <= 4; level++) {
    const swatch = el("span", "heat-cell");
    swatch.dataset.level = String(level);
    legend.append(swatch);
  }
  legend.append(el("span", "", "More"));

  const wrap = el("div", "heatmap-wrap");
  wrap.append(grid, legend);
  card.append(wrap);
}

function renderStats() {
  const { counts, days, since, first } = data.stats;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  statsBody.innerHTML = "";

  if (!total) {
    statsBody.append(el("div", "stats-empty", "Nothing yet ( ˘ω˘ ) Copy some kaomoji and check back!"));
    return;
  }

  // Same card language as Settings: titled groups of rounded cards.
  const group = (title) => {
    if (title) statsBody.append(el("div", "settings-group-title", title));
    const card = el("div", "settings-card");
    statsBody.append(card);
    return card;
  };

  const hero = el("div", "stats-hero");
  hero.append(
    el("span", "big", total.toLocaleString()),
    el("span", "sub", `kaomoji copied since ${formatDate(since)}`),
    el("span", "face", "(ﾉ◕ヮ◕)ﾉ*:･ﾟ✧")
  );
  group("Overview").append(hero);

  const { current, longest, activeDays } = streaks(days);
  const cards = el("div", "stat-cards");
  for (const [value, label] of [
    [current, "day streak"],
    [longest, "longest streak"],
    [activeDays, activeDays === 1 ? "active day" : "active days"],
  ]) {
    const card = el("div", "stat-card");
    card.append(el("div", "value", String(value)), el("div", "label", label));
    cards.append(card);
  }
  statsBody.append(cards);

  renderHeatmap(group("Activity"), days);

  const topCard = group("Most used");
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const maxCount = top[0][1];
  top.forEach(([text, count], i) => {
    const row = el("button", "top-row");
    row.title = `Copy ${text}`;
    const bar = el("span", "top-bar");
    const fill = el("span");
    fill.style.width = `${Math.max(4, (count / maxCount) * 100)}%`;
    bar.append(fill);
    row.append(el("span", "top-rank", String(i + 1)), el("span", "top-kaomoji kaomoji-font", text), bar, el("span", "top-count", `×${count}`));
    row.addEventListener("click", () => useKaomoji(text, null, data.prefs.autoPaste ? "paste" : "copy"));
    topCard.append(row);
  });

  const lines = [];
  const byCategory = new Map();
  for (const [text, count] of Object.entries(counts)) {
    const cat = categories.find((c) => c.items.includes(text))?.name ?? (data.custom.includes(text) ? "Custom" : null);
    if (cat) byCategory.set(cat, (byCategory.get(cat) || 0) + count);
  }
  const favCat = [...byCategory.entries()].sort((a, b) => b[1] - a[1])[0];
  if (favCat) lines.push(["Favorite category", `${favCat[0]} (${favCat[1]})`]);
  const busiest = Object.entries(days).sort((a, b) => b[1] - a[1])[0];
  if (busiest) {
    const [y, m, d] = busiest[0].split("-").map(Number);
    lines.push(["Busiest day", `${formatDate(new Date(y, m - 1, d))} (${busiest[1]})`]);
  }
  if (first) lines.push(["First kaomoji", `${first.text}  ·  ${formatDate(first.t)}`]);

  if (!lines.length) return;
  const factsCard = group("Fun facts");
  for (const [label, value] of lines) {
    const line = el("div", "setting-row stat-line");
    line.append(el("span", "", label), el("span", "value kaomoji-font", value));
    factsCard.append(line);
  }
}

function openStats() {
  closePopover();
  renderStats();
  statsBody.scrollTop = 0;
  statsPanel.hidden = false;
}

function closeStats() {
  statsPanel.hidden = true;
  searchEl.focus();
}

statsBtn.addEventListener("click", openStats);
statsBackBtn.addEventListener("click", closeStats);

// ---------- settings ----------

let recordingHotkey = false;
let hotkeyLabel = "";

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  for (const btn of themeSegmented.children) {
    btn.classList.toggle("active", btn.dataset.theme === theme);
  }
}

function applyDensity(density) {
  document.documentElement.setAttribute("data-density", density);
  for (const btn of densitySegmented.children) {
    btn.classList.toggle("active", btn.dataset.density === density);
  }
}

function applyPrefs() {
  stayOpenToggle.checked = data.prefs.stayOpen;
  autoPasteToggle.checked = data.prefs.autoPaste;
  applyMarkdownPref(data.prefs.markdown);
  soundToggle.checked = data.prefs.sound;
  applyTheme(data.prefs.theme);
  applyDensity(data.prefs.density);
  updatePrimaryLabel();
}

densitySegmented.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-density]");
  if (!btn) return;
  data.prefs.density = btn.dataset.density;
  applyDensity(data.prefs.density);
  saveData();
  // Which kaomoji need two cells depends on the tile size.
  render({ keepSelection: true });
});

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

function applyMarkdownPref(mode) {
  for (const btn of markdownSegmented.children) {
    btn.classList.toggle("active", btn.dataset.markdown === mode);
  }
}

markdownSegmented.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-markdown]");
  if (!btn) return;
  data.prefs.markdown = btn.dataset.markdown;
  applyMarkdownPref(data.prefs.markdown);
  saveData();
});

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

const DEFAULT_HOTKEY = { ctrl: true, alt: true, shift: false, meta: false, code: "KeyK", label: "Ctrl+Alt+K" };
const hotkeyResetBtn = $("hotkeyResetBtn");

// "Ctrl+Alt+K" -> Ctrl Alt K as keycaps.
function renderHotkeyKeys(label) {
  hotkeyBtn.replaceChildren(...label.split("+").map((key) => el("kbd", "", key)));
}

function showHotkeyLabel(label) {
  hotkeyLabel = label;
  renderHotkeyKeys(label);
  hotkeyResetBtn.hidden = label === DEFAULT_HOTKEY.label;
}

hotkeyResetBtn.addEventListener("click", async () => {
  try {
    await invoke("set_hotkey", { hotkey: DEFAULT_HOTKEY });
    showHotkeyLabel(DEFAULT_HOTKEY.label);
    hotkeyHint.textContent = "";
  } catch (err) {
    hotkeyHint.textContent = String(err);
  }
});

async function loadBackendSettings() {
  try {
    const settings = await invoke("get_settings");
    autostartToggle.checked = Boolean(settings.autostart);
    showHotkeyLabel(settings.hotkey.label);
    showDataDir(settings.dataDir);
    versionLabel.textContent = `Version ${settings.version}`;
  } catch (err) {
    console.error("couldn't load settings", err);
  }
}

function showDataDir(dir) {
  dataDirResetBtn.hidden = !dir;
  dataDirHint.textContent = dir
    ? `Synced via ${dir}`
    : "Only on this PC. Choose a synced folder (like Proton Drive) to share favorites and custom kaomoji between computers.";
}

async function switchDataDir(dir) {
  let existing;
  try {
    existing = await invoke("set_data_dir", { dir });
  } catch (err) {
    dataDirHint.textContent = String(err);
    return;
  }
  data = mergeData(data, existing ? normalize(existing) : null);
  saveData();
  applyPrefs();
  render({ keepSelection: true });
  showDataDir(dir);
  const note = existing ? "merged with the data already there" : "your data was copied there";
  dataDirHint.textContent += ` · ${note}`;
}

dataDirBtn.addEventListener("click", async () => {
  let dir;
  try {
    dir = await invoke("pick_data_folder");
  } catch (err) {
    dataDirHint.textContent = String(err);
    return;
  }
  if (dir) await switchDataDir(dir);
});

dataDirResetBtn.addEventListener("click", () => switchDataDir(null));

// ---------- updates ----------

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
let availableUpdate = null;
let lastUpdateCheck = 0;

async function checkForUpdate({ manual = false } = {}) {
  lastUpdateCheck = Date.now();
  if (manual) updateHint.textContent = "Checking…";
  try {
    availableUpdate = await invoke("check_update");
  } catch (err) {
    // Background checks stay silent (offline, no release yet, dev build).
    if (manual) updateHint.textContent = `Couldn't check for updates: ${err}`;
    return;
  }
  settingsBtn.classList.toggle("has-update", Boolean(availableUpdate));
  if (availableUpdate) {
    updateHint.textContent = `Version ${availableUpdate.version} is available`;
    updateBtn.textContent = `Install ${availableUpdate.version}`;
  } else {
    updateHint.textContent = manual ? "You're up to date" : "";
    updateBtn.textContent = "Check for updates";
  }
}

updateBtn.addEventListener("click", async () => {
  if (!availableUpdate) {
    checkForUpdate({ manual: true });
    return;
  }
  updateBtn.disabled = true;
  updateHint.textContent = "Downloading… the app restarts when it's done";
  try {
    await invoke("install_update");
  } catch (err) {
    updateHint.textContent = `Update failed: ${err}`;
    updateBtn.disabled = false;
  }
});

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
  renderHotkeyKeys(hotkeyLabel);
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
    renderHotkeyKeys(hotkeyLabel);
    hotkeyHint.textContent = String(err);
  }
}

// ---------- window lifecycle ----------

// The board resets as it hides, so it's already showing the fresh default
// view the next time it opens, rather than flashing the old search and then
// redrawing.
function onHidden() {
  if (!settingsPanel.hidden) closeSettings();
  statsPanel.hidden = true;
  closePopover();
  closePreview();
  if (pendingUndo) clearUndo();
  closeEditor();
  searchEl.value = "";
  setCategory("all");
}

async function onShown(event) {
  fromMarkdownApp = Boolean(event?.payload?.fromMarkdownApp);
  setTimeout(() => searchEl.focus(), 0);
  // The time of day may have changed since it hid.
  if (!faceTimer) faceEl.textContent = idleFace();
  // Only redraw if the data changed while hidden (e.g. from a synced folder).
  if (await loadData()) {
    applyPrefs();
    render();
  }
  if (pendingCelebration) setTimeout(celebrate, 250);
  if (Date.now() - lastUpdateCheck > UPDATE_CHECK_INTERVAL_MS) checkForUpdate();
}

// Fills every [data-icon] placeholder in the page with its icon.
function hydrateIcons() {
  for (const slot of document.querySelectorAll("[data-icon]")) {
    slot.replaceChildren(icon(slot.dataset.icon, Number(slot.dataset.size) || 15));
  }
}

// Scrollbars stay hidden until you scroll or hover (see .autohide in CSS).
for (const scroller of document.querySelectorAll(".content, .settings-body")) {
  let timer = null;
  scroller.addEventListener(
    "scroll",
    () => {
      scroller.classList.add("scrolling");
      clearTimeout(timer);
      timer = setTimeout(() => scroller.classList.remove("scrolling"), 900);
    },
    { passive: true }
  );
}

(async () => {
  hydrateIcons();
  window.__TAURI__.event.listen("shown", onShown);
  window.__TAURI__.event.listen("hidden", onHidden);
  await loadData({ initial: true });
  applyPrefs();
  setCategory("all");
  loadBackendSettings();
  searchEl.focus();
  // Let startup settle before touching the network.
  setTimeout(() => checkForUpdate(), 5000);
})();
