import { categories, searchTags } from "./kaomoji-data.js";

const tabsEl = document.getElementById("tabs");
const gridEl = document.getElementById("grid");
const searchEl = document.getElementById("search");
const toastEl = document.getElementById("toast");
const muteBtn = document.getElementById("muteBtn");
const settingsBtn = document.getElementById("settingsBtn");
const settingsPanel = document.getElementById("settingsPanel");
const settingsBackBtn = document.getElementById("settingsBackBtn");
const stayOpenToggle = document.getElementById("stayOpenToggle");
const autoPasteToggle = document.getElementById("autoPasteToggle");
const autostartToggle = document.getElementById("autostartToggle");
const themeSegmented = document.getElementById("themeSegmented");
const hotkeyBtn = document.getElementById("hotkeyBtn");
const hotkeyHint = document.getElementById("hotkeyHint");

const invoke = (...args) => window.__TAURI__.core.invoke(...args);

// ---------- persisted prefs ----------
const STAY_OPEN_KEY = "kaomoji.stayOpen";
const AUTO_PASTE_KEY = "kaomoji.autoPaste";
const MUTE_KEY = "kaomoji.muted";
const THEME_KEY = "kaomoji.theme";
const FAVORITES_KEY = "kaomoji.favorites";
const CUSTOM_KEY = "kaomoji.custom";

stayOpenToggle.checked = localStorage.getItem(STAY_OPEN_KEY) === "1";
stayOpenToggle.addEventListener("change", () => {
  localStorage.setItem(STAY_OPEN_KEY, stayOpenToggle.checked ? "1" : "0");
});

autoPasteToggle.checked = localStorage.getItem(AUTO_PASTE_KEY) === "1";
autoPasteToggle.addEventListener("change", () => {
  localStorage.setItem(AUTO_PASTE_KEY, autoPasteToggle.checked ? "1" : "0");
});

let muted = localStorage.getItem(MUTE_KEY) === "1";
function updateMuteBtn() {
  muteBtn.textContent = muted ? "🔇" : "🔊";
}
updateMuteBtn();
muteBtn.addEventListener("click", () => {
  muted = !muted;
  localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  updateMuteBtn();
});

let favorites = JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]");
function saveFavorites() {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
}

let customItems = JSON.parse(localStorage.getItem(CUSTOM_KEY) || "[]");
function saveCustom() {
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(customItems));
}

// ---------- theme ----------
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  [...themeSegmented.children].forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.theme === theme);
  });
}
const savedTheme = localStorage.getItem(THEME_KEY) || "auto";
applyTheme(savedTheme);
themeSegmented.addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  localStorage.setItem(THEME_KEY, btn.dataset.theme);
  applyTheme(btn.dataset.theme);
});

// ---------- settings panel open/close ----------
settingsBtn.addEventListener("click", () => {
  settingsPanel.hidden = false;
});
settingsBackBtn.addEventListener("click", () => {
  settingsPanel.hidden = true;
});

// ---------- backend-synced settings (autostart, hotkey) ----------
let recordingHotkey = false;

async function loadBackendSettings() {
  try {
    const settings = await invoke("get_settings");
    autostartToggle.checked = !!settings.autostart;
    hotkeyBtn.textContent = settings.hotkey.label;
  } catch (err) {
    console.error("failed to load settings", err);
  }
}

autostartToggle.addEventListener("change", async () => {
  const desired = autostartToggle.checked;
  try {
    await invoke("set_autostart", { enabled: desired });
  } catch (err) {
    autostartToggle.checked = !desired;
    hotkeyHint.textContent = "couldn't update startup setting";
  }
});

const MODIFIER_CODES = new Set([
  "ControlLeft", "ControlRight",
  "AltLeft", "AltRight",
  "ShiftLeft", "ShiftRight",
  "MetaLeft", "MetaRight",
]);

function codeToLabel(code) {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return code;
}

hotkeyBtn.addEventListener("click", () => {
  recordingHotkey = true;
  hotkeyBtn.classList.add("recording");
  hotkeyBtn.textContent = "press keys...";
  hotkeyHint.textContent = "include at least one modifier (Ctrl/Alt/Shift)";
});

async function handleHotkeyRecording(e) {
  e.preventDefault();
  if (MODIFIER_CODES.has(e.code)) return;

  const combo = {
    ctrl: e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
    meta: e.metaKey,
    code: e.code,
  };

  if (e.code === "Escape") {
    recordingHotkey = false;
    hotkeyBtn.classList.remove("recording");
    await loadBackendSettings();
    hotkeyHint.textContent = "";
    return;
  }

  if (!combo.ctrl && !combo.alt && !combo.shift && !combo.meta) {
    hotkeyHint.textContent = "needs at least one modifier key — try again";
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
    hotkeyBtn.textContent = combo.label;
    hotkeyHint.textContent = "saved!";
    setTimeout(() => (hotkeyHint.textContent = ""), 1500);
  } catch (err) {
    hotkeyHint.textContent = String(err);
    await loadBackendSettings();
  }
}

loadBackendSettings();

// ---------- tabs ----------
const FAVORITES_TAB = "favorites";
const CUSTOM_TAB = "custom";
let activeTab = 0; // index into categories, or FAVORITES_TAB / CUSTOM_TAB
let currentItems = [];
let selectedIndex = null;
let addingCustom = false;

function switchTab(tab) {
  activeTab = tab;
  searchEl.value = "";
  selectedIndex = null;
  addingCustom = false;
  renderTabs();
  renderGrid();
}

function renderTabs() {
  tabsEl.innerHTML = "";

  const pinned = [
    { id: FAVORITES_TAB, label: "Favorites", color: "var(--accent)" },
    { id: CUSTOM_TAB, label: "Custom", color: "var(--palette-6)" },
  ];

  pinned.forEach(({ id, label, color }) => {
    const btn = document.createElement("button");
    btn.className = "tab" + (activeTab === id ? " active" : "");
    btn.style.setProperty("--dot-color", color);
    btn.appendChild(buildTabDot());
    btn.appendChild(document.createTextNode(label));
    btn.addEventListener("click", () => switchTab(id));
    tabsEl.appendChild(btn);
  });

  categories.forEach((cat, i) => {
    const btn = document.createElement("button");
    btn.className = "tab" + (activeTab === i ? " active" : "");
    btn.style.setProperty("--dot-color", PALETTE[i % PALETTE.length]);
    btn.appendChild(buildTabDot());
    btn.appendChild(document.createTextNode(cat.name));
    btn.addEventListener("click", () => switchTab(i));
    tabsEl.appendChild(btn);
  });
}

const PALETTE = [
  "var(--palette-1)",
  "var(--palette-2)",
  "var(--palette-3)",
  "var(--palette-4)",
  "var(--palette-5)",
  "var(--palette-6)",
];

function buildTabDot() {
  const dot = document.createElement("span");
  dot.className = "tab-dot";
  return dot;
}

// ---------- grid ----------
function itemsForQuery(query) {
  const direct = categories
    .flatMap((c) => c.items)
    .concat(customItems)
    .filter((k) => k.toLowerCase().includes(query));

  const tagCategoryNames = new Set();
  for (const [keyword, catNames] of Object.entries(searchTags)) {
    if (keyword.includes(query) || query.includes(keyword)) {
      catNames.forEach((n) => tagCategoryNames.add(n));
    }
  }
  const tagged = categories
    .filter((c) => tagCategoryNames.has(c.name))
    .flatMap((c) => c.items);

  return [...new Set([...direct, ...tagged])];
}

function renderGrid() {
  const query = searchEl.value.trim().toLowerCase();
  gridEl.innerHTML = "";

  let items;
  if (query) {
    items = itemsForQuery(query);
  } else if (activeTab === FAVORITES_TAB) {
    items = favorites;
  } else if (activeTab === CUSTOM_TAB) {
    items = customItems;
  } else {
    items = categories[activeTab].items;
  }

  currentItems = items;

  if (items.length === 0 && !(activeTab === CUSTOM_TAB && !query)) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent =
      activeTab === FAVORITES_TAB && !query
        ? "no favorites yet (｡•̀ᴗ-)✧ heart some kaomoji!"
        : "no matches (｡•́︿•̀｡)";
    gridEl.appendChild(empty);
    if (!(activeTab === CUSTOM_TAB && !query)) return;
  }

  items.forEach((k, i) => {
    gridEl.appendChild(buildTile(k, i));
  });

  if (activeTab === CUSTOM_TAB && !query) {
    gridEl.appendChild(buildAddCustomTile());
  }
}

function buildTile(k, index) {
  const item = document.createElement("div");
  item.className = "kaomoji-item" + (selectedIndex === index ? " selected" : "");
  item.dataset.index = String(index);

  const btn = document.createElement("button");
  btn.className = "kaomoji-btn";
  btn.textContent = k;
  btn.addEventListener("click", () => copyKaomoji(k, btn));

  const heart = document.createElement("button");
  heart.className = "heart-btn" + (favorites.includes(k) ? " favorited" : "");
  heart.textContent = favorites.includes(k) ? "♥" : "♡";
  heart.title = favorites.includes(k) ? "remove from favorites" : "add to favorites";
  heart.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFavorite(k);
  });

  item.appendChild(btn);
  item.appendChild(heart);

  if (activeTab === CUSTOM_TAB) {
    const del = document.createElement("button");
    del.className = "delete-btn";
    del.textContent = "✕";
    del.title = "remove";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      customItems = customItems.filter((x) => x !== k);
      saveCustom();
      renderGrid();
    });
    item.appendChild(del);
  }

  if (activeTab === FAVORITES_TAB) {
    item.draggable = true;
    item.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", String(index));
    });
    item.addEventListener("dragover", (e) => {
      e.preventDefault();
      item.classList.add("drag-over");
    });
    item.addEventListener("dragleave", () => item.classList.remove("drag-over"));
    item.addEventListener("drop", (e) => {
      e.preventDefault();
      item.classList.remove("drag-over");
      const fromIndex = Number(e.dataTransfer.getData("text/plain"));
      const toIndex = index;
      if (Number.isNaN(fromIndex) || fromIndex === toIndex) return;
      const [moved] = favorites.splice(fromIndex, 1);
      favorites.splice(toIndex, 0, moved);
      saveFavorites();
      renderGrid();
    });
  }

  return item;
}

function buildAddCustomTile() {
  if (!addingCustom) {
    const btn = document.createElement("button");
    btn.className = "add-custom-btn";
    btn.textContent = "+";
    btn.title = "add your own kaomoji";
    btn.addEventListener("click", () => {
      addingCustom = true;
      renderGrid();
    });
    return btn;
  }

  const input = document.createElement("input");
  input.className = "add-custom-input";
  input.placeholder = "paste kaomoji, Enter";
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      const val = input.value.trim();
      if (val && !customItems.includes(val)) {
        customItems.push(val);
        saveCustom();
      }
      addingCustom = false;
      renderGrid();
    } else if (e.key === "Escape") {
      addingCustom = false;
      renderGrid();
    }
  });
  input.addEventListener("blur", () => {
    addingCustom = false;
    renderGrid();
  });
  setTimeout(() => input.focus(), 0);
  return input;
}

function toggleFavorite(k) {
  const i = favorites.indexOf(k);
  if (i === -1) {
    favorites.push(k);
  } else {
    favorites.splice(i, 1);
  }
  saveFavorites();
  renderGrid();
}

// ---------- copy ----------
let toastTimer = null;
let audioCtx = null;

function playCopySound() {
  if (muted) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.06, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.12);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.12);
  } catch (err) {
    // audio not available, ignore
  }
}

async function copyKaomoji(text, btnEl) {
  try {
    await window.__TAURI__.clipboardManager.writeText(text);
  } catch (err) {
    console.error("clipboard write failed", err);
  }

  showToast();
  playCopySound();
  if (btnEl) {
    btnEl.classList.add("copied");
    setTimeout(() => btnEl.classList.remove("copied"), 150);
  }

  if (autoPasteToggle.checked) {
    setTimeout(() => invoke("paste_to_previous"), 140);
  } else if (!stayOpenToggle.checked) {
    setTimeout(() => invoke("hide_window"), 160);
  }
}

function showToast() {
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 700);
}

// ---------- keyboard navigation ----------
const COLS = 2;

function setSelected(index) {
  if (index < 0 || index >= currentItems.length) return;
  selectedIndex = index;
  renderGrid();
  const el = gridEl.querySelector(`[data-index="${index}"] .kaomoji-btn`);
  if (el) el.scrollIntoView({ block: "nearest" });
}

document.addEventListener("keydown", (e) => {
  if (!settingsPanel.hidden) {
    if (recordingHotkey) {
      handleHotkeyRecording(e);
      return;
    }
    if (e.key === "Escape") settingsPanel.hidden = true;
    return;
  }

  const searchFocused = document.activeElement === searchEl;

  if (searchFocused) {
    if (e.key === "ArrowDown" && currentItems.length > 0) {
      e.preventDefault();
      searchEl.blur();
      setSelected(0);
    } else if (e.key === "Escape") {
      invoke("hide_window");
    }
    return;
  }

  if (e.key >= "1" && e.key <= "9") {
    const idx = Number(e.key) - 1;
    if (idx < currentItems.length) {
      e.preventDefault();
      copyKaomoji(currentItems[idx]);
    }
    return;
  }

  if (e.key === "ArrowRight") {
    e.preventDefault();
    setSelected((selectedIndex ?? -1) + 1);
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    setSelected((selectedIndex ?? 1) - 1);
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    setSelected((selectedIndex ?? -COLS) + COLS);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (selectedIndex === null || selectedIndex - COLS < 0) {
      selectedIndex = null;
      renderGrid();
      searchEl.focus();
    } else {
      setSelected(selectedIndex - COLS);
    }
  } else if (e.key === "Enter") {
    if (selectedIndex !== null && currentItems[selectedIndex] !== undefined) {
      e.preventDefault();
      copyKaomoji(currentItems[selectedIndex]);
    }
  } else if (e.key === "Escape") {
    if (selectedIndex !== null) {
      selectedIndex = null;
      renderGrid();
      searchEl.focus();
    } else {
      invoke("hide_window");
    }
  } else if (/^[a-zA-Z]$/.test(e.key)) {
    searchEl.focus();
    searchEl.value += e.key;
    renderGrid();
  }
});

searchEl.addEventListener("input", () => {
  selectedIndex = null;
  renderGrid();
});

tabsEl.addEventListener(
  "wheel",
  (e) => {
    if (e.deltaY === 0) return;
    tabsEl.scrollLeft += e.deltaY;
    e.preventDefault();
  },
  { passive: false }
);

window.addEventListener("focus", () => {
  searchEl.value = "";
  selectedIndex = null;
  settingsPanel.hidden = true;
  renderGrid();
});

renderTabs();
renderGrid();
