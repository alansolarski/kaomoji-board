import { categories, searchTags } from "./kaomoji-data.js";

const $ = (id) => document.getElementById(id);
const searchEl = $("search");
const faceEl = $("face");
const railEl = $("rail");
const contentEl = $("content");
const statusEl = $("status");
const hotkeyLabelEl = $("hotkeyLabel");
const menuEl = $("menu");
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
const HINT = "↵ copy · ctrl+1-9 · right-click for more";

const PALETTE = [1, 2, 3, 4, 5, 6].map((n) => `var(--palette-${n})`);

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
    setStatus("couldn't load your saved kaomoji", 4000);
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

function recentItems() {
  const now = Date.now();
  return Object.keys(data.usage)
    .sort((a, b) => usageScore(b, now) - usageScore(a, now))
    .slice(0, 12);
}

// ---------- search ----------

const categoryKeywords = new Map();
for (const [keyword, names] of Object.entries(searchTags)) {
  for (const name of names) {
    if (!categoryKeywords.has(name)) categoryKeywords.set(name, []);
    categoryKeywords.get(name).push(keyword);
  }
}

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
    const words = cat.name.toLowerCase().split(" ");
    const keywords = [...words, words.join(""), ...(categoryKeywords.get(cat.name) || [])];
    cat.items.forEach((t) => add(t, keywords));
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

function search(query) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const now = Date.now();
  const results = [];
  for (const entry of buildIndex()) {
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

// ---------- rendering ----------

let flat = []; // every copyable chip, in visual order
let selected = -1;
let addingCustom = false;

function browseSections() {
  const sections = [];
  const recent = recentItems();
  if (recent.length) {
    sections.push({ id: "recent", label: "recent", color: "var(--accent-2)", items: recent, kind: "recent" });
  }
  sections.push({ id: "favorites", label: "favorites", color: "var(--accent)", items: data.favorites, kind: "favorites" });
  categories.forEach((cat, i) => {
    sections.push({ id: `cat-${i}`, label: cat.name, color: PALETTE[i % PALETTE.length], items: cat.items, kind: "category" });
  });
  sections.push({ id: "custom", label: "custom", color: "var(--palette-6)", items: data.custom, kind: "custom" });
  return sections;
}

function render({ keepSelection = false } = {}) {
  const query = searchEl.value.trim();
  const sections = query
    ? [{ id: "results", label: "results", color: "var(--accent)", items: search(query), kind: "results" }]
    : browseSections();

  const prevSelected = selected;
  const prevChip = flat[selected];
  const favorites = new Set(data.favorites);
  flat = [];
  contentEl.innerHTML = "";

  for (const sec of sections) {
    const wrap = el("section", "section");
    wrap.dataset.id = sec.id;

    const head = el("div", "section-head");
    head.style.setProperty("--dot-color", sec.color);
    head.append(el("span", "dot"), el("span", "", sec.label), el("span", "count", String(sec.items.length)));
    wrap.append(head);

    const chips = el("div", "chips");
    sec.items.forEach((text, i) => chips.append(buildChip(text, sec, i, favorites)));
    if (sec.kind === "custom") chips.append(buildAddChip());
    if (!sec.items.length && sec.kind === "favorites") {
      chips.append(el("span", "empty", "right-click any kaomoji to favorite it"));
    }
    if (!sec.items.length && sec.kind === "results") {
      chips.append(el("span", "empty", "no matches"));
    }
    wrap.append(chips);
    contentEl.append(wrap);
  }

  flat.slice(0, 9).forEach((chip, i) => (chip.dataset.n = String(i + 1)));
  let next = 0;
  if (keepSelection && prevChip) {
    // Indices shift when e.g. favorites grows, so follow the same chip.
    const same = flat.findIndex(
      (c) => c.dataset.text === prevChip.dataset.text && c.dataset.section === prevChip.dataset.section
    );
    next = same >= 0 ? same : prevSelected;
  }
  selected = -1;
  select(next, false);

  faceEl.textContent = query && !flat.length ? FACE_SAD : FACE_IDLE;
  renderRail(Boolean(query));
}

function buildChip(text, sec, indexInSection, favorites) {
  const chip = el("button", "chip", text);
  chip.title = text;
  chip.dataset.text = text;
  chip.dataset.section = sec.id;
  if (sec.kind !== "favorites" && favorites.has(text)) chip.classList.add("fav");

  const flatIndex = flat.length;
  flat.push(chip);

  chip.addEventListener("click", () => useKaomoji(text, chip));
  chip.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    select(flatIndex, false);
    openMenu(e.clientX, e.clientY, text, sec.kind);
  });
  chip.addEventListener("mousemove", (e) => {
    if (pointerMoved(e) && selected !== flatIndex) select(flatIndex, false);
  });

  if (sec.kind === "favorites") {
    chip.draggable = true;
    chip.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/x-fav-index", String(indexInSection));
      e.dataTransfer.effectAllowed = "move";
    });
    chip.addEventListener("dragover", (e) => {
      if (!e.dataTransfer.types.includes("text/x-fav-index")) return;
      e.preventDefault();
      chip.classList.add("drop");
    });
    chip.addEventListener("dragleave", () => chip.classList.remove("drop"));
    chip.addEventListener("drop", (e) => {
      e.preventDefault();
      chip.classList.remove("drop");
      const from = Number(e.dataTransfer.getData("text/x-fav-index"));
      if (Number.isNaN(from) || from === indexInSection) return;
      const [moved] = data.favorites.splice(from, 1);
      data.favorites.splice(indexInSection, 0, moved);
      saveData();
      render({ keepSelection: true });
    });
  }
  return chip;
}

function buildAddChip() {
  if (!addingCustom) {
    const btn = el("button", "chip add", "+ add");
    btn.title = "add your own kaomoji";
    btn.addEventListener("click", () => {
      addingCustom = true;
      render({ keepSelection: true });
    });
    return btn;
  }

  const input = el("input", "chip add-input");
  input.placeholder = "paste, then ↵";
  input.spellcheck = false;
  const finish = (save) => {
    if (!addingCustom) return;
    addingCustom = false;
    const value = input.value.trim();
    if (save && value && !data.custom.includes(value)) {
      data.custom.push(value);
      saveData();
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

// ---------- rail + scroll spy ----------

function renderRail(searching) {
  railEl.innerHTML = "";
  railEl.classList.toggle("dim", searching);
  for (const sec of browseSections()) {
    const item = el("button", "rail-item");
    item.dataset.id = sec.id;
    item.style.setProperty("--dot-color", sec.color);
    item.append(el("span", "dot"), el("span", "", sec.label));
    item.addEventListener("click", () => jumpTo(sec.id));
    railEl.append(item);
  }
  updateScrollSpy();
}

function jumpTo(id) {
  if (searchEl.value) {
    searchEl.value = "";
    render();
  }
  const section = contentEl.querySelector(`[data-id="${id}"]`);
  if (!section) return;
  contentEl.scrollTop = section.offsetTop - 2;
  updateScrollSpy();
  const firstChip = section.querySelector(".chip:not(.add)");
  if (firstChip) select(flat.indexOf(firstChip), false);
  searchEl.focus();
}

function updateScrollSpy() {
  let current = null;
  if (!searchEl.value.trim()) {
    const atBottom = contentEl.scrollTop + contentEl.clientHeight >= contentEl.scrollHeight - 2;
    for (const section of contentEl.children) {
      if (section.offsetTop <= contentEl.scrollTop + 16) current = section.dataset.id;
    }
    if (atBottom && contentEl.lastElementChild) current = contentEl.lastElementChild.dataset.id;
  }
  for (const item of railEl.children) {
    const active = item.dataset.id === current;
    item.classList.toggle("active", active);
    if (active) {
      const top = item.offsetTop;
      const bottom = top + item.offsetHeight;
      if (top < railEl.scrollTop) railEl.scrollTop = top - 8;
      else if (bottom > railEl.scrollTop + railEl.clientHeight) railEl.scrollTop = bottom - railEl.clientHeight + 8;
    }
  }
}

contentEl.addEventListener("scroll", updateScrollSpy, { passive: true });

// ---------- selection + keyboard ----------

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
  const chip = flat[selected];
  if (!chip) return;
  chip.classList.add("sel");
  if (scroll) chip.scrollIntoView({ block: "nearest" });
}

// Moves to the chip in the nearest row above/below, closest horizontally.
function moveVertical(dir) {
  const current = flat[selected];
  if (!current) return select(0);
  const r = current.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  let best = -1;
  let bestTop = null;
  let bestDx = Infinity;
  flat.forEach((chip, i) => {
    const cr = chip.getBoundingClientRect();
    if (dir > 0 ? cr.top <= r.top + 4 : cr.top >= r.top - 4) return;
    const dx = Math.abs(cr.left + cr.width / 2 - cx);
    const closerRow = bestTop === null || (dir > 0 ? cr.top < bestTop - 2 : cr.top > bestTop + 2);
    const sameRow = bestTop !== null && Math.abs(cr.top - bestTop) <= 2;
    if (closerRow || (sameRow && dx < bestDx)) {
      best = i;
      bestTop = closerRow ? cr.top : bestTop;
      bestDx = dx;
    }
  });
  if (best >= 0) select(best);
}

function selectedText() {
  return flat[selected]?.dataset.text;
}

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
  if (!menuEl.hidden) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeMenu();
    }
    return;
  }

  const digit = /^[1-9]$/.test(e.key) ? Number(e.key) : 0;
  if (digit && (e.ctrlKey || e.altKey || !searchEl.value)) {
    e.preventDefault();
    const chip = flat[digit - 1];
    if (chip) useKaomoji(chip.dataset.text, chip);
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
      if (selectedText()) useKaomoji(selectedText(), flat[selected]);
      return;
    case "Escape":
      e.preventDefault();
      if (searchEl.value) {
        searchEl.value = "";
        render();
      } else {
        hideWindow();
      }
      return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
    e.preventDefault();
    if (selectedText()) toggleFavorite(selectedText());
    return;
  }

  // Typing anywhere goes to search. Only move focus: the browser then types
  // the character into the input itself.
  if (document.activeElement !== searchEl && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
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

// ---------- context menu ----------

function openMenu(x, y, text, kind) {
  menuEl.innerHTML = "";
  const isFav = data.favorites.includes(text);
  const add = (label, action, className) => {
    const btn = el("button", className, label);
    btn.addEventListener("click", () => {
      closeMenu();
      action();
    });
    menuEl.append(btn);
  };
  add("copy", () => useKaomoji(text, flat[selected]));
  add(isFav ? "unfavorite" : "favorite", () => toggleFavorite(text));
  if (kind === "recent") add("remove from recent", () => forgetUsage(text));
  if (kind === "custom") add("delete", () => deleteCustom(text), "danger");

  menuEl.hidden = false;
  const app = menuEl.offsetParent;
  const maxX = app.clientWidth - menuEl.offsetWidth - 6;
  const maxY = app.clientHeight - menuEl.offsetHeight - 6;
  menuEl.style.left = `${Math.max(6, Math.min(x, maxX))}px`;
  menuEl.style.top = `${Math.max(6, Math.min(y, maxY))}px`;
}

function closeMenu() {
  menuEl.hidden = true;
}

document.addEventListener("mousedown", (e) => {
  if (!menuEl.hidden && !menuEl.contains(e.target)) closeMenu();
});
// Wheel rather than scroll: programmatic scrolls (scrollIntoView) fire a
// late scroll event that would close a menu that just opened.
contentEl.addEventListener("wheel", closeMenu, { passive: true });

function toggleFavorite(text) {
  const i = data.favorites.indexOf(text);
  if (i === -1) data.favorites.push(text);
  else data.favorites.splice(i, 1);
  saveData();
  setStatus(i === -1 ? "added to favorites" : "removed from favorites");
  render({ keepSelection: true });
}

function deleteCustom(text) {
  data.custom = data.custom.filter((t) => t !== text);
  saveData();
  render({ keepSelection: true });
}

function forgetUsage(text) {
  delete data.usage[text];
  saveData();
  render({ keepSelection: true });
}

// ---------- copy / paste ----------

let audioCtx = null;
let faceTimer = null;
let statusTimer = null;

function setStatus(message, ms = 900) {
  statusEl.textContent = message;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (statusEl.textContent = HINT), ms);
}

function playCopySound() {
  if (!data.prefs.sound) return;
  try {
    audioCtx = audioCtx || new AudioContext();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.06, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.12);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.12);
  } catch {
    // no audio device; not worth surfacing
  }
}

async function useKaomoji(text, chip) {
  closeMenu();
  // Deliberately no re-render: reshuffling "recent" under the cursor is
  // jarring. The next time the window opens picks it up.
  recordUse(text);
  playCopySound();
  if (chip) {
    chip.classList.add("flash");
    setTimeout(() => chip.classList.remove("flash"), 160);
  }
  faceEl.textContent = FACE_HAPPY;
  clearTimeout(faceTimer);
  faceTimer = setTimeout(() => (faceEl.textContent = FACE_IDLE), 900);

  try {
    if (data.prefs.autoPaste) {
      await invoke("paste_kaomoji", { text });
      return;
    }
    await window.__TAURI__.clipboardManager.writeText(text);
  } catch (err) {
    console.error("copy failed", err);
    setStatus("couldn't copy (｡•́︿•̀｡)", 2000);
    return;
  }
  setStatus("copied!");
  if (!data.prefs.stayOpen) setTimeout(hideWindow, 90);
}

function hideWindow() {
  invoke("hide_window");
}

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
}

function bindPref(toggle, key) {
  toggle.addEventListener("change", () => {
    data.prefs[key] = toggle.checked;
    saveData();
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
  closeMenu();
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
  hotkeyLabelEl.textContent = label.toLowerCase();
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
    hotkeyHint.textContent = "couldn't update the startup setting";
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
  hotkeyBtn.textContent = "press keys…";
  hotkeyHint.textContent = "include ctrl, alt, shift or win · esc to cancel";
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
    hotkeyHint.textContent = "needs a modifier key — try again";
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
    hotkeyHint.textContent = "saved!";
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
  closeMenu();
  addingCustom = false;
  searchEl.value = "";
  render();
  contentEl.scrollTop = 0;
  updateScrollSpy();
  setTimeout(() => searchEl.focus(), 0);
}

(async () => {
  window.__TAURI__.event.listen("shown", onShown);
  statusEl.textContent = HINT;
  await loadData();
  applyPrefs();
  render();
  loadBackendSettings();
  searchEl.focus();
})();
