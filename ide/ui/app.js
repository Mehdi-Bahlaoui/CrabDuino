// CrabDuino — frontend (plain JS, no build step).
// Tauri exposes its API on window.__TAURI__ because tauri.conf.json sets
// "withGlobalTauri": true.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const STARTER = `#![no_std]
#![no_main]

use panic_halt as _;

#[arduino_hal::entry]
fn main() -> ! {
    let dp = arduino_hal::Peripherals::take().unwrap();
    let pins = arduino_hal::pins!(dp);

    let mut led = pins.d13.into_output();

    loop {
        led.toggle();
        arduino_hal::delay_ms(1000);
    }
}
`;

// ---- editor (CodeMirror 5) -------------------------------------------------
const cm = CodeMirror.fromTextArea(document.getElementById("editor"), {
  value: STARTER,
  mode: "rust",
  theme: "dracula",
  lineNumbers: true,
  indentUnit: 4,
  tabSize: 4,
  autoCloseBrackets: true,
  matchBrackets: true,
  styleActiveLine: true,
});
cm.setValue(STARTER);

const code = () => cm.getValue();
const setCode = (text) => cm.setValue(text);

// ---- zoom (Ctrl +/-/0, Ctrl+scroll) ----------------------------------------
// Editor and console share the --editor-font CSS variable, so both scale.
let fontPx = parseInt(localStorage.getItem("editorFont") || "28", 10) || 28;
function setFont(px) {
  fontPx = Math.min(72, Math.max(8, px));
  document.documentElement.style.setProperty("--editor-font", fontPx + "px");
  localStorage.setItem("editorFont", String(fontPx));
  cm.refresh(); // CodeMirror 5 must recompute gutters/line geometry
}
setFont(fontPx);

cm.getWrapperElement().addEventListener(
  "wheel",
  (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setFont(fontPx + (e.deltaY < 0 ? 2 : -2));
    }
  },
  { passive: false },
);

// ---- restore persisted panel sizes -----------------------------------------
const savedSidebar = localStorage.getItem("sidebarW");
if (savedSidebar) document.documentElement.style.setProperty("--sidebar-w", savedSidebar + "px");
const savedConsole = localStorage.getItem("consoleH");
if (savedConsole) document.documentElement.style.setProperty("--console-h", savedConsole + "px");

// ---- elements --------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const btnVerify = $("btn-verify");
const btnUpload = $("btn-upload");
const btnStop = $("btn-stop");
const statusEl = $("status");
const consoleEl = $("console");
const consoleWrap = $("console-wrap");
const treeEl = $("file-tree");

// ---- console ---------------------------------------------------------------
// Height is the --console-h grid track; collapsing shrinks the track to the
// header and remembers the previous height for restore.
let lastConsoleH = (localStorage.getItem("consoleH") || "200") + "px";
function expandConsole() {
  if (!consoleWrap.classList.contains("collapsed")) return;
  consoleWrap.classList.remove("collapsed");
  document.documentElement.style.setProperty("--console-h", lastConsoleH);
  $("btn-toggle-console").textContent = "▾";
  cm.refresh();
}
function logLine(stream, line) {
  const div = document.createElement("div");
  div.className = `ln ln-${stream}`;
  div.textContent = line;
  consoleEl.appendChild(div);
  consoleEl.scrollTop = consoleEl.scrollHeight;
  expandConsole();
}
function clearConsole() {
  consoleEl.innerHTML = "";
}
function setStatus(text, kind = "ready") {
  statusEl.textContent = text;
  statusEl.className = `status status-${kind}`;
}

// ---- task state ------------------------------------------------------------
let busy = false;
function setBusy(on, flashing = false) {
  busy = on;
  btnVerify.disabled = on;
  btnUpload.disabled = on;
  btnStop.hidden = !flashing;
}

// ---- backend events --------------------------------------------------------
listen("output", (e) => logLine(e.payload.stream, e.payload.line));

listen("task-finished", (e) => {
  const ok = e.payload.code === 0;
  const verb = e.payload.task === "flash" ? "Upload" : "Verify";
  setBusy(false, false);
  if (ok) {
    logLine("info", `— ${verb} finished —`);
    setStatus(`${verb.toLowerCase()} ok`, "ok");
  } else {
    logLine("info", `— ${verb} failed (exit ${e.payload.code}) —`);
    setStatus(`${verb.toLowerCase()} failed`, "err");
  }
});

// ---- actions ---------------------------------------------------------------
async function verify() {
  if (busy) return;
  clearConsole();
  setBusy(true);
  setStatus("compiling…", "busy");
  logLine("info", "Building (cargo build --release)…");
  try {
    await saveCurrent();
    await invoke("build");
  } catch (err) {
    logLine("stderr", String(err));
    setBusy(false);
    setStatus("error", "err");
  }
}

async function upload() {
  if (busy) return;
  clearConsole();
  setBusy(true, true);
  setStatus("uploading…", "busy");
  logLine("info", "Compiling & flashing (cargo run --release)…");
  try {
    await saveCurrent();
    await invoke("flash");
  } catch (err) {
    logLine("stderr", String(err));
    setBusy(false, false);
    setStatus("error", "err");
  }
}

async function stopFlash() {
  try {
    await invoke("stop_flash");
  } catch (err) {
    logLine("stderr", String(err));
  }
  setBusy(false, false);
  setStatus("stopped", "ready");
}

// Persist the editor buffer to the active file. Used by Ctrl+S and before build/flash.
async function saveCurrent() {
  if (!currentPath) return;
  await invoke("save_file", { path: currentPath, content: code() });
}
async function save() {
  try {
    await saveCurrent();
    setStatus("saved", "ok");
  } catch (err) {
    logLine("stderr", String(err));
    setStatus("save failed", "err");
  }
}

// ---- window controls (frameless window) ------------------------------------
const appWin = window.__TAURI__.window.getCurrentWindow();
$("win-min").addEventListener("click", () => appWin.minimize());
$("win-max").addEventListener("click", () => appWin.toggleMaximize());
$("win-close").addEventListener("click", () => appWin.close());

// ---- wiring ----------------------------------------------------------------
btnVerify.addEventListener("click", verify);
btnUpload.addEventListener("click", upload);
btnStop.addEventListener("click", stopFlash);

$("btn-simulator").addEventListener("click", () => ($("simulator").hidden = false));
$("btn-close-sim").addEventListener("click", () => ($("simulator").hidden = true));

$("btn-clear").addEventListener("click", clearConsole);
$("btn-toggle-console").addEventListener("click", () => {
  const collapsed = consoleWrap.classList.toggle("collapsed");
  $("btn-toggle-console").textContent = collapsed ? "▴" : "▾";
  const docEl = document.documentElement;
  if (collapsed) {
    lastConsoleH = getComputedStyle(docEl).getPropertyValue("--console-h").trim() || lastConsoleH;
    docEl.style.setProperty("--console-h", "34px");
  } else {
    docEl.style.setProperty("--console-h", lastConsoleH);
  }
  cm.refresh();
});

// Menu actions
document.querySelectorAll(".menu-items button").forEach((b) => {
  b.addEventListener("click", () => {
    const action = b.dataset.action;
    if (action === "save") save();
    else if (action === "new") setCode(STARTER);
    else if (action === "undo") cm.undo();
    else if (action === "redo") cm.redo();
    b.closest(".menu")?.classList.remove("open");
  });
});
document.querySelectorAll(".menu").forEach((m) => {
  m.querySelector(".menu-label").addEventListener("click", (ev) => {
    ev.stopPropagation();
    const wasOpen = m.classList.contains("open");
    document.querySelectorAll(".menu").forEach((x) => x.classList.remove("open"));
    if (!wasOpen) m.classList.add("open");
  });
});
document.addEventListener("click", () =>
  document.querySelectorAll(".menu").forEach((x) => x.classList.remove("open")),
);

// Ctrl+S to save; Ctrl +/-/0 to zoom
window.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key;
  if (k.toLowerCase() === "s") {
    e.preventDefault();
    save();
  } else if (k === "=" || k === "+") {
    e.preventDefault();
    setFont(fontPx + 2);
  } else if (k === "-") {
    e.preventDefault();
    setFont(fontPx - 2);
  } else if (k === "0") {
    e.preventDefault();
    setFont(28);
  }
});

// ---- draggable splitters ---------------------------------------------------
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function makeDrag(handle, onMove) {
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    handle.classList.add("dragging");
    document.body.style.userSelect = "none";
    const move = (ev) => onMove(ev);
    const up = () => {
      handle.classList.remove("dragging");
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
}
makeDrag($("rz-sidebar"), (e) => {
  const w = clamp(e.clientX, 120, 600);
  document.documentElement.style.setProperty("--sidebar-w", w + "px");
  localStorage.setItem("sidebarW", String(w));
});
makeDrag($("rz-console"), (e) => {
  const h = clamp(window.innerHeight - e.clientY, 80, window.innerHeight * 0.7);
  document.documentElement.style.setProperty("--console-h", h + "px");
  localStorage.setItem("consoleH", String(h));
  lastConsoleH = h + "px";
  consoleWrap.classList.remove("collapsed");
  $("btn-toggle-console").textContent = "▾";
  cm.refresh();
});

// ---- file browser (VS Code-like explorer) ----------------------------------
let firmwareRoot = null; // canonical firmware/ path (set at boot)
let currentPath = null; // file currently open in the editor
let activeRow = null; // row of the open file (white highlight)
let selectedRow = null; // row with selection/keyboard focus
let clipboard = null; // { path, name, isDir, mode: "copy" | "cut" }

// path helpers (firmwareRoot is an absolute, forward-slash path)
const sep = "/";
const basename = (p) => p.slice(p.lastIndexOf(sep) + 1);
const parentDir = (p) => p.slice(0, p.lastIndexOf(sep)) || firmwareRoot;
const joinPath = (dir, name) => dir + sep + name;
const relPath = (p) =>
  p.startsWith(firmwareRoot + sep) ? p.slice(firmwareRoot.length + 1) : basename(p);

function iconFor(entry, open) {
  if (entry.is_dir) return open ? "📂" : "📁";
  if (entry.name.endsWith(".rs")) return "🦀";
  return "📄";
}
function modeFor(name) {
  return name.endsWith(".rs") ? "rust" : null; // CM5 falls back to plain text
}
function select(row) {
  if (selectedRow) selectedRow.classList.remove("selected");
  selectedRow = row;
  if (row) row.classList.add("selected");
}

async function openFile(path, name, row) {
  try {
    const text = await invoke("read_file", { path });
    setCode(text);
    cm.setOption("mode", modeFor(name));
    cm.refresh();
    currentPath = path;
    if (activeRow) activeRow.classList.remove("active");
    activeRow = row;
    if (row) row.classList.add("active");
    setStatus(name, "ready");
  } catch (err) {
    logLine("stderr", String(err));
    setStatus("open failed", "err");
  }
}

// ---- tree rendering --------------------------------------------------------
// Build one indented row (caret + icon + label) shared by files and folders.
function makeRow(entry, depth) {
  const row = document.createElement("div");
  row.className = "file-item";
  row.dataset.path = entry.path;
  row.tabIndex = 0;
  row.style.paddingLeft = depth * 14 + 6 + "px";
  row._entry = entry;
  row._depth = depth;
  const tw = document.createElement("span");
  tw.className = "file-tw";
  tw.textContent = entry.is_dir ? "▸" : "";
  const ic = document.createElement("span");
  ic.className = "file-ic";
  ic.textContent = iconFor(entry, false);
  const label = document.createElement("span");
  label.className = "file-label";
  label.textContent = entry.name;
  row.append(tw, ic, label);
  row._tw = tw;
  row._ic = ic;
  row._label = label;
  return row;
}

async function listInto(container, dirPath, depth) {
  const entries = await invoke("list_dir", { path: dirPath });
  container.innerHTML = "";
  for (const entry of entries) container.appendChild(makeNode(entry, depth));
}

function makeNode(entry, depth) {
  return entry.is_dir ? makeDirNode(entry, depth) : makeFileNode(entry, depth);
}

function makeFileNode(entry, depth) {
  const row = makeRow(entry, depth);
  row.addEventListener("click", () => {
    select(row);
    openFile(entry.path, entry.name, row);
  });
  attachRowEvents(row);
  return row;
}

function makeDirNode(entry, depth) {
  const wrap = document.createElement("div");
  const row = makeRow(entry, depth);
  const children = document.createElement("div");
  children.hidden = true;
  let loaded = false;
  let open = false;
  async function reload() {
    await listInto(children, entry.path, depth + 1);
  }
  async function setOpen(want) {
    open = want;
    row._tw.textContent = open ? "▾" : "▸";
    row._ic.textContent = iconFor(entry, open);
    children.hidden = !open;
    if (open) {
      if (!loaded) {
        loaded = true;
        await reload();
      }
      invoke("watch_dir", { path: entry.path }).catch(() => {});
    } else {
      invoke("unwatch_dir", { path: entry.path }).catch(() => {});
    }
  }
  row._children = children;
  row._reload = reload;
  row._isOpen = () => open;
  row._setOpen = setOpen;
  row.addEventListener("click", () => {
    select(row);
    setOpen(!open);
  });
  attachRowEvents(row);
  wrap.append(row, children);
  return wrap;
}

function findRow(path) {
  return [...treeEl.querySelectorAll(".file-item")].find((r) => r.dataset.path === path);
}

// After a rebuild the rows are fresh DOM nodes, so re-apply the open-file and
// selection highlights by matching paths.
function restoreHighlights() {
  if (currentPath) {
    const r = findRow(currentPath);
    if (r) {
      activeRow = r;
      r.classList.add("active");
    }
  }
  if (selectedRow) {
    const r = findRow(selectedRow.dataset.path);
    if (r) {
      selectedRow = r;
      r.classList.add("selected");
    }
  }
}

// Re-list a single directory in place (the only view that needs to change after
// an operation or external edit). Nested expanded folders collapse — acceptable.
async function refreshDir(dirPath) {
  try {
    if (dirPath === firmwareRoot) {
      await listInto(treeEl, firmwareRoot, 0);
    } else {
      const row = findRow(dirPath);
      if (row && row._reload && row._isOpen && row._isOpen()) await row._reload();
    }
    restoreHighlights();
  } catch {
    /* dir may have been deleted; ignore */
  }
}

function collapseAll() {
  treeEl.querySelectorAll(".file-item").forEach((r) => {
    if (r._isOpen && r._isOpen()) r._setOpen(false);
  });
}

// ---- watch-driven refresh (debounced) --------------------------------------
const pendingDirs = new Set();
let refreshTimer = null;
function scheduleRefresh(dir) {
  pendingDirs.add(dir);
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    const dirs = [...pendingDirs];
    pendingDirs.clear();
    dirs.forEach(refreshDir);
  }, 150);
}
listen("fs-changed", (e) => scheduleRefresh(parentDir(e.payload)));

// ---- operations ------------------------------------------------------------
function copyText(text) {
  navigator.clipboard?.writeText(text).catch(() => {});
}
async function revealEntry(path) {
  try {
    await invoke("reveal", { path });
  } catch (err) {
    logLine("stderr", String(err));
  }
}
function setClipboard(entry, mode) {
  clipboard = { path: entry.path, name: entry.name, isDir: entry.is_dir, mode };
}

// Find a non-colliding destination name ("foo copy", "foo copy 2", …).
async function uniqueDest(dir, name) {
  let existing = [];
  try {
    existing = (await invoke("list_dir", { path: dir })).map((e) => e.name);
  } catch {
    /* keep empty */
  }
  if (!existing.includes(name)) return joinPath(dir, name);
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let i = 1;
  let candidate;
  do {
    candidate = `${base} copy${i > 1 ? " " + i : ""}${ext}`;
    i++;
  } while (existing.includes(candidate));
  return joinPath(dir, candidate);
}

async function paste(targetDir) {
  if (!clipboard) return;
  const dest = await uniqueDest(targetDir, clipboard.name);
  try {
    if (clipboard.mode === "cut") {
      await invoke("rename_entry", { from: clipboard.path, to: dest });
      await refreshDir(parentDir(clipboard.path));
      clipboard = null;
    } else {
      await invoke("copy_entry", { from: clipboard.path, to: dest });
    }
    await refreshDir(targetDir);
  } catch (err) {
    logLine("stderr", String(err));
  }
}

async function duplicate(entry) {
  const dir = parentDir(entry.path);
  const dest = await uniqueDest(dir, entry.name);
  try {
    await invoke("copy_entry", { from: entry.path, to: dest });
    await refreshDir(dir);
  } catch (err) {
    logLine("stderr", String(err));
  }
}

async function moveInto(srcPath, destDir) {
  if (!srcPath || srcPath === destDir) return;
  if (destDir.startsWith(srcPath + sep)) return; // can't move into own subtree
  if (parentDir(srcPath) === destDir) return; // already there
  const dest = joinPath(destDir, basename(srcPath));
  try {
    await invoke("rename_entry", { from: srcPath, to: dest });
    await refreshDir(parentDir(srcPath));
    await refreshDir(destDir);
  } catch (err) {
    logLine("stderr", String(err));
  }
}

async function deleteEntry(entry) {
  const ok = await confirmDialog(`Delete “${entry.name}”?\nIt will be moved to the Trash.`);
  if (!ok) return;
  try {
    await invoke("delete_entry", { path: entry.path });
    await refreshDir(parentDir(entry.path));
  } catch (err) {
    logLine("stderr", String(err));
  }
}

// ---- inline inputs (rename + create) ---------------------------------------
function inlineRename(row) {
  if (!row) return;
  const entry = row._entry;
  const label = row._label;
  const input = document.createElement("input");
  input.className = "file-input";
  input.value = entry.name;
  label.replaceWith(input);
  input.focus();
  const dot = entry.name.lastIndexOf(".");
  input.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
  let done = false;
  async function commit() {
    if (done) return;
    done = true;
    const name = input.value.trim();
    input.replaceWith(label);
    if (name && name !== entry.name) {
      try {
        await invoke("rename_entry", { from: entry.path, to: joinPath(parentDir(entry.path), name) });
        await refreshDir(parentDir(entry.path));
      } catch (err) {
        logLine("stderr", String(err));
      }
    }
  }
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      done = true;
      input.replaceWith(label);
    }
  });
  input.addEventListener("blur", commit);
}

async function inlineCreate(dirPath, isDir) {
  let container;
  let depth;
  if (dirPath === firmwareRoot) {
    container = treeEl;
    depth = 0;
  } else {
    const row = findRow(dirPath);
    if (!row || !row._setOpen) return;
    await row._setOpen(true);
    container = row._children;
    depth = row._depth + 1;
  }
  const rowEl = document.createElement("div");
  rowEl.className = "file-item";
  rowEl.style.paddingLeft = depth * 14 + 6 + "px";
  const tw = document.createElement("span");
  tw.className = "file-tw";
  const ic = document.createElement("span");
  ic.className = "file-ic";
  ic.textContent = isDir ? "📁" : "📄";
  const input = document.createElement("input");
  input.className = "file-input";
  input.placeholder = isDir ? "folder name" : "file name";
  rowEl.append(tw, ic, input);
  container.prepend(rowEl);
  input.focus();
  let done = false;
  async function commit() {
    if (done) return;
    done = true;
    const name = input.value.trim();
    rowEl.remove();
    if (!name) return;
    const path = joinPath(dirPath, name);
    try {
      await invoke(isDir ? "create_dir" : "create_file", { path });
      await refreshDir(dirPath);
      if (!isDir) {
        const r = findRow(path);
        select(r);
        openFile(path, name, r);
      }
    } catch (err) {
      logLine("stderr", String(err));
    }
  }
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      done = true;
      rowEl.remove();
    }
  });
  input.addEventListener("blur", commit);
}

// ---- confirm modal ---------------------------------------------------------
function confirmDialog(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const modal = document.createElement("div");
    modal.className = "modal";
    const p = document.createElement("p");
    p.textContent = message;
    const btns = document.createElement("div");
    btns.className = "modal-btns";
    const no = document.createElement("button");
    no.className = "btn btn-ghost";
    no.textContent = "Cancel";
    const yes = document.createElement("button");
    yes.className = "btn btn-primary";
    yes.textContent = "Move to Trash";
    btns.append(no, yes);
    modal.append(p, btns);
    overlay.append(modal);
    const close = (v) => {
      overlay.remove();
      resolve(v);
    };
    yes.addEventListener("click", () => close(true));
    no.addEventListener("click", () => close(false));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(false);
    });
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close(false);
    });
    document.body.append(overlay);
    yes.focus();
  });
}

// ---- context menu ----------------------------------------------------------
const ctxMenu = document.createElement("div");
ctxMenu.className = "ctx-menu";
ctxMenu.hidden = true;
document.body.append(ctxMenu);

function hideMenu() {
  ctxMenu.hidden = true;
  ctxMenu.innerHTML = "";
}
document.addEventListener("click", hideMenu);
window.addEventListener("blur", hideMenu);
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideMenu();
});

function showMenu(x, y, items) {
  ctxMenu.innerHTML = "";
  for (const item of items) {
    if (item === "-") {
      const s = document.createElement("div");
      s.className = "ctx-sep";
      ctxMenu.append(s);
      continue;
    }
    const b = document.createElement("button");
    b.className = "ctx-item";
    b.textContent = item.label;
    if (item.disabled) {
      b.disabled = true;
    } else {
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        hideMenu();
        item.action();
      });
    }
    ctxMenu.append(b);
  }
  ctxMenu.hidden = false;
  ctxMenu.style.left = Math.min(x, window.innerWidth - ctxMenu.offsetWidth - 4) + "px";
  ctxMenu.style.top = Math.min(y, window.innerHeight - ctxMenu.offsetHeight - 4) + "px";
}

function menuForEntry(entry) {
  const items = [];
  if (entry.is_dir) {
    items.push({ label: "New File", action: () => inlineCreate(entry.path, false) });
    items.push({ label: "New Folder", action: () => inlineCreate(entry.path, true) });
    items.push("-");
  } else {
    items.push({ label: "Open", action: () => openFile(entry.path, entry.name, findRow(entry.path)) });
    items.push("-");
  }
  items.push({ label: "Cut", action: () => setClipboard(entry, "cut") });
  items.push({ label: "Copy", action: () => setClipboard(entry, "copy") });
  if (entry.is_dir) items.push({ label: "Paste", disabled: !clipboard, action: () => paste(entry.path) });
  items.push({ label: "Duplicate", action: () => duplicate(entry) });
  items.push("-");
  items.push({ label: "Copy Path", action: () => copyText(entry.path) });
  items.push({ label: "Copy Relative Path", action: () => copyText(relPath(entry.path)) });
  items.push("-");
  items.push({ label: "Rename", action: () => inlineRename(findRow(entry.path)) });
  items.push({ label: "Delete", action: () => deleteEntry(entry) });
  items.push("-");
  items.push({ label: "Reveal in File Manager", action: () => revealEntry(entry.path) });
  return items;
}

function menuForBackground() {
  return [
    { label: "New File", action: () => inlineCreate(firmwareRoot, false) },
    { label: "New Folder", action: () => inlineCreate(firmwareRoot, true) },
    { label: "Paste", disabled: !clipboard, action: () => paste(firmwareRoot) },
    "-",
    { label: "Refresh", action: () => refreshDir(firmwareRoot) },
  ];
}

// ---- per-row events: context menu, drag-and-drop, keyboard -----------------
function attachRowEvents(row) {
  const entry = row._entry;
  const targetDir = entry.is_dir ? entry.path : parentDir(entry.path);

  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    select(row);
    showMenu(e.clientX, e.clientY, menuForEntry(entry));
  });

  row.draggable = true;
  row.addEventListener("dragstart", (e) => {
    e.stopPropagation();
    e.dataTransfer.setData("text/path", entry.path);
    e.dataTransfer.effectAllowed = "move";
  });
  row.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    row.classList.add("drop-target");
  });
  row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
  row.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    row.classList.remove("drop-target");
    moveInto(e.dataTransfer.getData("text/path"), targetDir);
  });

  row.addEventListener("keydown", (e) => {
    if (e.key === "F2") {
      e.preventDefault();
      inlineRename(row);
    } else if (e.key === "Delete") {
      e.preventDefault();
      deleteEntry(entry);
    } else if (e.key === "Enter") {
      e.preventDefault();
      row.click();
    }
  });
}

// background (empty area / root) context menu + drop target
treeEl.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  showMenu(e.clientX, e.clientY, menuForBackground());
});
treeEl.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
});
treeEl.addEventListener("drop", (e) => {
  e.preventDefault();
  moveInto(e.dataTransfer.getData("text/path"), firmwareRoot);
});

// sidebar header action buttons
$("act-new-file").addEventListener("click", () => inlineCreate(firmwareRoot, false));
$("act-new-folder").addEventListener("click", () => inlineCreate(firmwareRoot, true));
$("act-refresh").addEventListener("click", () => refreshDir(firmwareRoot));
$("act-collapse").addEventListener("click", collapseAll);

// ---- boot: render firmware/ tree and open src/main.rs ----------------------
(async () => {
  try {
    firmwareRoot = await invoke("firmware_root");
    await listInto(treeEl, firmwareRoot, 0);
    invoke("watch_dir", { path: firmwareRoot }).catch(() => {});
    // Expand src/ and open main.rs so the IDE opens on the sketch as before.
    const srcRow = findRow(firmwareRoot + "/src");
    if (srcRow && srcRow._setOpen) await srcRow._setOpen(true);
    const mainPath = firmwareRoot + "/src/main.rs";
    const mainRow = findRow(mainPath);
    if (mainRow) {
      select(mainRow);
      openFile(mainPath, "main.rs", mainRow);
    } else {
      await openFile(mainPath, "main.rs", null);
    }
    setStatus("ready");
  } catch (err) {
    logLine("stderr", String(err));
    setStatus("using template", "ready"); // keep starter if firmware not found
  }
})();
