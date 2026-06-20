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

// ---- inline SVG icons ------------------------------------------------------
// The locked mono font (Source Code Pro) has no glyphs for emoji/box-drawing
// arrows, so every icon is a small stroked SVG that inherits `currentColor`.
const ICON_PATHS = {
  chevron: '<polyline points="9 18 15 12 9 6"/>',
  folder:
    '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  file: '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/>',
  newFile:
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>',
  newFolder:
    '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>',
  refresh:
    '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  collapse: '<polyline points="17 11 12 6 7 11"/><polyline points="17 18 12 13 7 18"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  upload:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  guide:
    '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 0 3-3h7z"/>',
};
function iconMarkup(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ""}</svg>`;
}
function setIcon(el, name) {
  if (el) el.innerHTML = iconMarkup(name);
}
// Fill every static [data-icon] holder (toolbar, sidebar, console toggle, …).
document.querySelectorAll("[data-icon]").forEach((el) => setIcon(el, el.dataset.icon));

// ---- editor (CodeMirror 5) -------------------------------------------------
const cm = CodeMirror.fromTextArea(document.getElementById("editor"), {
  value: STARTER,
  mode: "rust",
  theme: "github",
  lineNumbers: true,
  indentUnit: 4,
  tabSize: 4,
  autoCloseBrackets: true,
  matchBrackets: true,
  styleActiveLine: true,
});
cm.setValue(STARTER);

const code = () => cm.getValue();
// `programmatic` is true while we replace the buffer ourselves (open a file,
// load a template) so the change handler doesn't flag those as unsaved edits.
let programmatic = false;
const setCode = (text) => {
  programmatic = true;
  cm.setValue(text);
  programmatic = false;
};

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
const consoleEl = $("console");
const consoleWrap = $("console-wrap");
const treeEl = $("file-tree");
const sidebarTitle = $("sidebar-title");
const projectActionButtons = ["act-new-file", "act-new-folder", "act-refresh", "act-collapse"]
  .map((id) => $(id))
  .filter(Boolean);

// ---- console ---------------------------------------------------------------
// Height is the --console-h grid track; collapsing shrinks the track to the
// header and remembers the previous height for restore.
let lastConsoleH = (localStorage.getItem("consoleH") || "200") + "px";
function expandConsole() {
  if (!consoleWrap.classList.contains("collapsed")) return;
  consoleWrap.classList.remove("collapsed");
  document.documentElement.style.setProperty("--console-h", lastConsoleH);
  cm.refresh();
}
function isErrorLine(line) {
  return (
    /^\s*(error(\[[^\]]+\])?|fatal):/i.test(line) ||
    /\b(panic|panicked|permission denied|no such file or directory)\b/i.test(line) ||
    /\b(avrdude|ravedude):.*\b(error|failed|can't|cannot|not responding|not in sync|timeout)\b/i.test(line)
  );
}
function consoleClass(stream, line) {
  if (stream === "error") return "error";
  if (stream === "stderr" && isErrorLine(line)) return "error";
  return stream;
}
function logLine(stream, line) {
  const div = document.createElement("div");
  div.className = `ln ln-${consoleClass(stream, line)}`;
  div.textContent = line;
  consoleEl.appendChild(div);
  consoleEl.scrollTop = consoleEl.scrollHeight;
  expandConsole();
}
function clearConsole() {
  consoleEl.innerHTML = "";
}

// ---- task state ------------------------------------------------------------
let busy = false;
let currentPath = null; // file currently open in the editor (set by openFile)
let firmwareRoot = null; // canonical active-project path; null until opened

function setBusy(on, flashing = false) {
  busy = on;
  btnStop.hidden = !flashing;
  updateRunButtons();
}

// The cargo bin name for the open file. `src/main.rs` is the package's default
// binary and therefore runs without `--bin`; files under src/bin/<name>.rs use
// `--bin <name>`. Undefined means the open file is not runnable.
function currentBin() {
  if (!currentPath) return undefined;
  const path = currentPath.replace(/\\/g, "/");
  const m = path.match(/\/src\/bin\/([^/]+)\.rs$/);
  if (m) return m[1];
  return path.endsWith("/src/main.rs") ? null : undefined;
}

// Verify needs a runnable Rust target; Upload also needs a detected board.
// Both are off while a task is running.
function updateRunButtons() {
  const bin = currentBin();
  const runnable = !!firmwareRoot && bin !== undefined;
  btnVerify.disabled = busy || !runnable;
  btnUpload.disabled = busy || !runnable || !detectedPort;
}

// ---- board detection -------------------------------------------------------
// Poll the backend for a connected Arduino Uno. The picker shows the board only
// while it's detected; Upload is enabled only then, and flashes to its port.
const boardSelect = $("board-select");
let detectedPort = null; // serial port of the detected Uno, or null when none

function renderBoard(board) {
  boardSelect.innerHTML = "";
  const opt = document.createElement("option");
  if (board) {
    detectedPort = board.port;
    opt.value = board.board;
    opt.textContent = `${board.label} — ${board.port}`;
    boardSelect.disabled = false;
  } else {
    detectedPort = null;
    opt.value = "";
    opt.textContent = "No board detected";
    boardSelect.disabled = true;
  }
  boardSelect.appendChild(opt);
  updateRunButtons();
}

async function pollBoard() {
  let board = null;
  try {
    board = await invoke("detect_board");
  } catch (_) {
    board = null; // detection failed → treat as no board
  }
  // Re-render only on change so we don't clobber the picker every tick.
  if ((board ? board.port : null) !== detectedPort) renderBoard(board);
}

renderBoard(null); // start in the "no board" state
pollBoard();
setInterval(pollBoard, 2000);

// ---- backend events --------------------------------------------------------
listen("output", (e) => logLine(e.payload.stream, e.payload.line));

listen("task-finished", (e) => {
  const ok = e.payload.code === 0;
  const verb = e.payload.task === "flash" ? "Upload" : "Verify";
  setBusy(false, false);
  if (ok) {
    logLine("info", `— ${verb} finished —`);
  } else {
    logLine("error", `— ${verb} failed (exit ${e.payload.code}) —`);
    if (e.payload.task === "flash") {
      logLine(
        "info",
        "Tip: reseat the USB cable; if the port is stuck/busy, use File ▸ Reset connection and try again.",
      );
    }
  }
});

// ---- actions ---------------------------------------------------------------
async function verify() {
  if (busy) return;
  const bin = currentBin();
  if (bin === undefined) {
    logLine("info", "Open src/main.rs or a sketch under src/bin/ to Verify it.");
    return;
  }
  clearConsole();
  setBusy(true);
  const target = bin || "main";
  const binArg = bin ? ` --bin ${bin}` : "";
  logLine("info", `Building ${target} (cargo build --release${binArg})…`);
  try {
    await saveCurrent();
    await invoke("build", { bin });
  } catch (err) {
    logLine("error", String(err));
    setBusy(false);
  }
}

async function upload() {
  if (busy) return;
  const bin = currentBin();
  if (bin === undefined) {
    logLine("info", "Open src/main.rs or a sketch under src/bin/ to Upload it.");
    return;
  }
  if (!detectedPort) {
    logLine("info", "No Arduino Uno detected — plug one in to upload.");
    return;
  }
  clearConsole();
  setBusy(true, true);
  const target = bin || "main";
  const binArg = bin ? ` --bin ${bin}` : "";
  logLine("info", `Compiling & flashing ${target} to ${detectedPort} (cargo run --release${binArg})…`);
  try {
    await saveCurrent();
    await invoke("flash", { port: detectedPort, bin });
  } catch (err) {
    logLine("error", String(err));
    setBusy(false, false);
  }
}

async function stopFlash() {
  try {
    await invoke("stop_flash");
  } catch (err) {
    logLine("error", String(err));
  }
  setBusy(false, false);
}

// Recover a stuck serial port: force-kill any flash/ravedude/avrdude session
// holding it, then re-detect the board. Use when Upload fails with a busy/stuck
// port. (Hardware issues like a loose cable still need a reseat.)
async function resetConnection() {
  try {
    await invoke("reset_connection");
    setBusy(false, false);
    await pollBoard(); // refresh the board picker right away
  } catch (err) {
    logLine("error", String(err));
  }
}

async function environmentDoctor() {
  try {
    const report = await invoke("environment_doctor");
    showDoctorDialog(report);
    const errors = report.checks.filter((c) => c.status === "error").length;
    const warnings = report.checks.filter((c) => c.status === "warn").length;
    logLine("info", `Environment Doctor: ${errors} errors, ${warnings} warnings`);
  } catch (err) {
    logLine("error", String(err));
  }
}

// Persist the editor buffer to the active file. Used by Ctrl+S and before build/flash.
async function saveCurrent() {
  if (!currentPath) return;
  await invoke("save_file", { path: currentPath, content: code() });
}
async function save() {
  if (!currentPath) return;
  try {
    await saveCurrent();
    setDirty(false); // the dot clearing is the "saved" feedback
  } catch (err) {
    logLine("error", String(err));
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

// ".ino → .rs" guide overlay
$("btn-guide").addEventListener("click", () => ($("guide").hidden = false));
$("btn-close-guide").addEventListener("click", () => ($("guide").hidden = true));

$("btn-clear").addEventListener("click", clearConsole);
$("btn-toggle-console").addEventListener("click", () => {
  // The chevron rotation is driven by the `.collapsed` class in CSS, not text.
  const collapsed = consoleWrap.classList.toggle("collapsed");
  const docEl = document.documentElement;
  if (collapsed) {
    lastConsoleH = getComputedStyle(docEl).getPropertyValue("--console-h").trim() || lastConsoleH;
    docEl.style.setProperty("--console-h", "34px");
  } else {
    docEl.style.setProperty("--console-h", lastConsoleH);
  }
  cm.refresh();
});

// ---- console input (terminal-style) ----------------------------------------
// A typed line is echoed and forwarded to the running flash/ravedude session,
// which relays it to the board over serial. No-op (with a hint) when idle.
$("console-input-row").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("console-input");
  const line = input.value;
  if (!line) return;
  input.value = "";
  logLine("stdout", "› " + line);
  try {
    await invoke("send_input", { line });
  } catch (err) {
    logLine("info", String(err));
  }
});

// Menu actions (only the File/Edit top-level items; submenu handled below).
document.querySelectorAll(".menu-items > button").forEach((b) => {
  b.addEventListener("click", () => {
    const action = b.dataset.action;
    if (action === "save") save();
    else if (action === "new") newSketch();
    else if (action === "open") openFolder();
    else if (action === "reset") resetConnection();
    else if (action === "doctor") environmentDoctor();
    else if (action === "undo") cm.undo();
    else if (action === "redo") cm.redo();
    b.closest(".menu")?.classList.remove("open");
  });
});

// File ▸ Examples ▸ … — drop a shipped example into the active project and open it.
document.querySelectorAll("[data-example]").forEach((b) => {
  b.addEventListener("click", () => openExample(b.dataset.example));
});
// Clicking the "Examples" label shouldn't close the File menu (it's hover-driven).
document.querySelector(".submenu-label")?.addEventListener("click", (e) => e.stopPropagation());
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
  cm.refresh();
});

// ---- file browser (VS Code-like explorer) ----------------------------------
let activeRow = null; // row of the open file (white highlight)
let selectedRow = null; // row with selection/keyboard focus
let clipboard = null; // { path, name, isDir, mode: "copy" | "cut" }
let dirty = false; // unsaved edits in the open file?

function setProjectActionsEnabled(enabled) {
  for (const button of projectActionButtons) button.disabled = !enabled;
}

function showNoProject() {
  localStorage.removeItem("projectRoot");
  firmwareRoot = null;
  currentPath = null;
  activeRow = null;
  selectedRow = null;
  clipboard = null;
  setDirty(false);
  setCode("");
  cm.setOption("mode", "rust");
  cm.refresh();
  if (sidebarTitle) {
    sidebarTitle.textContent = "No project";
    sidebarTitle.title = "No project open";
  }
  treeEl.innerHTML = '<div class="empty-project">Open folder or create new sketch</div>';
  setProjectActionsEnabled(false);
  updateRunButtons();
}

// Toggle the unsaved indicator (a white dot) on the open file's row.
function setDirty(on) {
  dirty = on;
  if (activeRow) activeRow.classList.toggle("dirty", on);
}
// User edits (but not our own setCode) mark the open file unsaved.
cm.on("change", () => {
  if (!programmatic && currentPath) setDirty(true);
});

// path helpers (firmwareRoot is an absolute, forward-slash path)
const sep = "/";
const basename = (p) => p.slice(p.lastIndexOf(sep) + 1);
const parentDir = (p) => p.slice(0, p.lastIndexOf(sep)) || firmwareRoot;
const joinPath = (dir, name) => dir + sep + name;
const relPath = (p) =>
  p.startsWith(firmwareRoot + sep) ? p.slice(firmwareRoot.length + 1) : basename(p);

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
    updateRunButtons(); // the open file decides which bin Verify/Upload target
    if (activeRow) activeRow.classList.remove("active", "dirty");
    activeRow = row;
    if (row) row.classList.add("active");
    setDirty(false); // a freshly loaded buffer is clean
  } catch (err) {
    logLine("error", String(err));
  }
}

// ---- tree rendering --------------------------------------------------------
// Build one indented row (caret + icon + label) shared by files and folders.
function makeRow(entry, depth) {
  const row = document.createElement("div");
  row.className = "file-item";
  if (entry.is_dir) row.classList.add("dir");
  else if (entry.name.endsWith(".rs")) row.classList.add("rs");
  row.dataset.path = entry.path;
  row.tabIndex = 0;
  row.style.paddingLeft = depth * 14 + 6 + "px";
  row._entry = entry;
  row._depth = depth;
  const tw = document.createElement("span");
  tw.className = "file-tw";
  if (entry.is_dir) setIcon(tw, "chevron");
  const ic = document.createElement("span");
  ic.className = "file-ic";
  setIcon(ic, entry.is_dir ? "folder" : "file");
  const label = document.createElement("span");
  label.className = "file-label";
  label.textContent = entry.name;
  const dot = document.createElement("span");
  dot.className = "file-dot";
  row.append(tw, ic, label, dot);
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
    row._tw.classList.toggle("open", open);
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
      if (dirty) r.classList.add("dirty");
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
  if (!firmwareRoot || !dirPath) return;
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
    logLine("error", String(err));
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
    logLine("error", String(err));
  }
}

async function duplicate(entry) {
  const dir = parentDir(entry.path);
  const dest = await uniqueDest(dir, entry.name);
  try {
    await invoke("copy_entry", { from: entry.path, to: dest });
    await refreshDir(dir);
  } catch (err) {
    logLine("error", String(err));
  }
}

async function moveInto(srcPath, destDir) {
  if (!firmwareRoot) return;
  if (!srcPath || srcPath === destDir) return;
  if (destDir.startsWith(srcPath + sep)) return; // can't move into own subtree
  if (parentDir(srcPath) === destDir) return; // already there
  const dest = joinPath(destDir, basename(srcPath));
  try {
    await invoke("rename_entry", { from: srcPath, to: dest });
    await refreshDir(parentDir(srcPath));
    await refreshDir(destDir);
  } catch (err) {
    logLine("error", String(err));
  }
}

async function deleteEntry(entry) {
  const ok = await confirmDialog(`Delete “${entry.name}”?\nIt will be moved to the Trash.`);
  if (!ok) return;
  try {
    await invoke("delete_entry", { path: entry.path });
    await refreshDir(parentDir(entry.path));
  } catch (err) {
    logLine("error", String(err));
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
        logLine("error", String(err));
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
  if (!firmwareRoot || !dirPath) return;
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
  setIcon(ic, isDir ? "folder" : "file");
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
      logLine("error", String(err));
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

// Ask for a single line of text (used to name a new sketch). Resolves to the
// trimmed value, or null if cancelled.
function promptDialog(message, initial = "") {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const modal = document.createElement("div");
    modal.className = "modal";
    const p = document.createElement("p");
    p.textContent = message;
    const input = document.createElement("input");
    input.className = "file-input";
    input.value = initial;
    input.style.width = "100%";
    input.style.marginBottom = "18px";
    const btns = document.createElement("div");
    btns.className = "modal-btns";
    const no = document.createElement("button");
    no.className = "btn btn-ghost";
    no.textContent = "Cancel";
    const yes = document.createElement("button");
    yes.className = "btn btn-primary";
    yes.textContent = "Create";
    btns.append(no, yes);
    modal.append(p, input, btns);
    overlay.append(modal);
    const close = (v) => {
      overlay.remove();
      resolve(v);
    };
    yes.addEventListener("click", () => close(input.value.trim()));
    no.addEventListener("click", () => close(null));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(null);
    });
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        close(input.value.trim());
      } else if (e.key === "Escape") {
        e.preventDefault();
        close(null);
      }
    });
    document.body.append(overlay);
    input.focus();
    input.select();
  });
}

function showDoctorDialog(report) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const modal = document.createElement("div");
  modal.className = "modal doctor-modal";
  const title = document.createElement("div");
  title.className = "doctor-title";
  title.textContent = "Environment Doctor";
  const list = document.createElement("div");
  list.className = "doctor-list";

  for (const check of report.checks) {
    const row = document.createElement("div");
    row.className = `doctor-row doctor-${check.status}`;
    const status = document.createElement("span");
    status.className = "doctor-status";
    status.textContent = check.status.toUpperCase();
    const body = document.createElement("div");
    body.className = "doctor-body";
    const name = document.createElement("div");
    name.className = "doctor-name";
    name.textContent = check.name;
    const detail = document.createElement("div");
    detail.className = "doctor-detail";
    detail.textContent = check.detail;
    body.append(name, detail);
    if (check.fix) {
      const fix = document.createElement("div");
      fix.className = "doctor-fix";
      fix.textContent = check.fix;
      body.append(fix);
    }
    row.append(status, body);
    list.append(row);
  }

  const btns = document.createElement("div");
  btns.className = "modal-btns";
  const closeBtn = document.createElement("button");
  closeBtn.className = "btn btn-primary";
  closeBtn.textContent = "Close";
  btns.append(closeBtn);
  modal.append(title, list, btns);
  overlay.append(modal);
  const close = () => overlay.remove();
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  document.body.append(overlay);
  closeBtn.focus();
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
  if (!firmwareRoot) {
    return [
      { label: "New sketch", action: newSketch },
      { label: "Open folder", action: openFolder },
    ];
  }
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
  if (!firmwareRoot) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
});
treeEl.addEventListener("drop", (e) => {
  if (!firmwareRoot) return;
  e.preventDefault();
  moveInto(e.dataTransfer.getData("text/path"), firmwareRoot);
});

// sidebar header action buttons
$("act-new-file").addEventListener("click", () => firmwareRoot && inlineCreate(firmwareRoot, false));
$("act-new-folder").addEventListener("click", () => firmwareRoot && inlineCreate(firmwareRoot, true));
$("act-refresh").addEventListener("click", () => firmwareRoot && refreshDir(firmwareRoot));
$("act-collapse").addEventListener("click", collapseAll);

// ---- project switching -----------------------------------------------------
// Render a project's tree and open src/main.rs when present; bundled example
// projects fall back to src/bin/blink.rs. Shared by boot, File ▸ New sketch,
// and (future) Open project.
async function loadProject(root) {
  firmwareRoot = root;
  setProjectActionsEnabled(true);
  if (sidebarTitle) {
    sidebarTitle.textContent = basename(root);
    sidebarTitle.title = root;
  }
  currentPath = null;
  activeRow = null;
  setDirty(false);
  updateRunButtons();
  await listInto(treeEl, firmwareRoot, 0);
  invoke("watch_dir", { path: firmwareRoot }).catch(() => {});
  // Expand src/ first so main.rs, or the bin folder fallback, is visible.
  const srcRow = findRow(firmwareRoot + "/src");
  if (srcRow && srcRow._setOpen) await srcRow._setOpen(true);
  const mainPath = firmwareRoot + "/src/main.rs";
  const mainRow = findRow(mainPath);
  if (mainRow) {
    select(mainRow);
    await openFile(mainPath, "main.rs", mainRow);
    return;
  }
  const binRow = findRow(firmwareRoot + "/src/bin");
  if (binRow && binRow._setOpen) await binRow._setOpen(true);
  const blinkPath = firmwareRoot + "/src/bin/blink.rs";
  const blinkRow = findRow(blinkPath);
  if (blinkRow) {
    select(blinkRow);
    await openFile(blinkPath, "blink.rs", blinkRow);
  }
}

// File ▸ New sketch: pick a parent folder, name the project, scaffold it, switch.
async function newSketch() {
  let parent;
  try {
    parent = await invoke("pick_folder");
  } catch (err) {
    logLine("error", String(err));
    return;
  }
  if (!parent) return; // cancelled
  const name = await promptDialog("New sketch name", "firmware_2");
  if (!name) return;
  try {
    const root = await invoke("new_project", { parent, name });
    await loadProject(root);
    logLine("info", `New sketch created at ${root}`);
  } catch (err) {
    logLine("error", String(err));
  }
}

// File ▸ Open folder: pick an existing Cargo/CrabDuino project and switch to it.
async function openFolder() {
  let folder;
  try {
    folder = await invoke("pick_folder");
  } catch (err) {
    logLine("error", String(err));
    return;
  }
  if (!folder) return; // cancelled
  try {
    const root = await invoke("set_project", { path: folder });
    await loadProject(root);
    logLine("info", `Opened folder ${root}`);
  } catch (err) {
    logLine("error", String(err));
  }
}

// File ▸ Examples ▸ …: copy a shipped example into the active project, open it.
async function openExample(name) {
  document.querySelectorAll(".menu").forEach((m) => m.classList.remove("open"));
  if (!firmwareRoot) {
    logLine("info", "Open a folder or create a new sketch before adding examples.");
    return;
  }
  try {
    const path = await invoke("add_example", { name });
    // Make sure src/bin is expanded so the new file shows and can be highlighted.
    const srcRow = findRow(firmwareRoot + "/src");
    if (srcRow && srcRow._setOpen) await srcRow._setOpen(true);
    const binRow = findRow(firmwareRoot + "/src/bin");
    if (binRow && binRow._setOpen) await binRow._setOpen(true);
    await refreshDir(firmwareRoot + "/src/bin");
    const row = findRow(path);
    if (row) select(row);
    await openFile(path, name + ".rs", row);
  } catch (err) {
    logLine("error", String(err));
  }
}

// ---- boot: start with no folder open ---------------------------------------
showNoProject();
