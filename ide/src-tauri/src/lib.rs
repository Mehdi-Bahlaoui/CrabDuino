// CrabDuino — Tauri backend.
//
// The IDE is a thin wrapper around an Arduino-Rust cargo project (the bundled
// `firmware/` skeleton by default). Each sketch is one file under `src/bin/`;
// users edit it and we shell out to cargo in the project dir:
//   * build  -> `cargo build --release --bin <name>`            (compile only)
//   * flash  -> `cargo run --release --bin <name>`  (ravedude)  (program + console)
// The "active project" can be switched at runtime (File ▸ New sketch scaffolds a
// fresh project and points the IDE at it). All child-process output is streamed
// to the webview as `output` events, and a `task-finished` event carries the
// exit code when a task ends.

use std::io::{BufRead, BufReader, Write as _};
#[cfg(unix)]
use std::os::unix::process::CommandExt as _;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Mutex, OnceLock};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// The active project root. `None` means "use the bundled firmware skeleton".
/// A process-global so the free `firmware_dir()` (called from many places that
/// don't hold `State`) can read it; switched by `new_project` / `set_project`.
static ACTIVE_ROOT: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Paths Tauri resolves at runtime. In a packaged app, resources live under the
/// install dir while the active project and Cargo home must live in user data.
#[derive(Clone)]
struct RuntimePaths {
    resource_dir: PathBuf,
    app_data_dir: PathBuf,
}

static RUNTIME_PATHS: OnceLock<RuntimePaths> = OnceLock::new();

const RUST_TOOLCHAIN_DIR: &str = "toolchains/rust-nightly-2025-04-27";
const AVR_HAL_GIT: &str = "https://github.com/rahix/avr-hal";
const AVR_HAL_REV: &str = "e5c8f37fe48419956e722490a82b9ca9b9fc61a2";

/// Shared backend state.
#[derive(Default)]
struct AppState {
    /// The currently running flash/`cargo run` child so it can be stopped
    /// (ravedude keeps the serial console open and never exits on its own).
    flash_child: Mutex<Option<Child>>,
    /// stdin of the running flash child, so typed console input can be forwarded
    /// to ravedude (which relays it to the board over serial).
    flash_stdin: Mutex<Option<ChildStdin>>,
    /// Filesystem watcher; folders are added/removed as the tree expands so we
    /// never watch the huge `target/` dir (it is hidden and never expanded).
    watcher: Mutex<Option<RecommendedWatcher>>,
}

fn dev_firmware_dir() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let candidate = manifest.join("../../firmware");
    candidate.canonicalize().unwrap_or(candidate)
}

fn packaged_firmware_template_dir() -> Option<PathBuf> {
    let dir = RUNTIME_PATHS.get()?.resource_dir.join("firmware-template");
    if dir.join("Cargo.toml").is_file() {
        Some(dir)
    } else {
        None
    }
}

/// The bundled firmware template used for examples and project scaffolding.
/// Development falls back to the repo's `firmware/`; packaged builds use the
/// Tauri resource `firmware-template/`.
fn bundled_firmware_dir() -> PathBuf {
    if let Ok(p) = std::env::var("CRABDUINO_FIRMWARE") {
        return PathBuf::from(p);
    }
    packaged_firmware_template_dir().unwrap_or_else(dev_firmware_dir)
}

/// The directory the IDE is currently editing/building: the active project if
/// one has been opened, otherwise a writable packaged default project or the
/// development firmware directory.
fn firmware_dir() -> PathBuf {
    if let Some(active) = ACTIVE_ROOT.lock().unwrap().clone() {
        return active;
    }
    bundled_firmware_dir()
}

fn set_active_root(p: PathBuf) {
    *ACTIVE_ROOT.lock().unwrap() = Some(p);
}

fn resource_file(rel: &str) -> Option<PathBuf> {
    let p = RUNTIME_PATHS.get()?.resource_dir.join(rel);
    if p.is_file() {
        Some(p)
    } else {
        None
    }
}

fn resource_dir(rel: &str) -> Option<PathBuf> {
    let p = RUNTIME_PATHS.get()?.resource_dir.join(rel);
    if p.is_dir() {
        Some(p)
    } else {
        None
    }
}

fn cargo_home_dir() -> Option<PathBuf> {
    Some(RUNTIME_PATHS.get()?.app_data_dir.join("cargo-home"))
}

fn toml_string(path: &Path) -> String {
    let escaped = path
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    format!("\"{escaped}\"")
}

fn ensure_cargo_home() -> Result<Option<PathBuf>, String> {
    let Some(vendor) = resource_dir("vendor") else {
        return Ok(None);
    };
    let Some(cargo_home) = cargo_home_dir() else {
        return Ok(None);
    };
    std::fs::create_dir_all(&cargo_home).map_err(|e| e.to_string())?;
    let config = format!(
        r#"[source.crates-io]
replace-with = "vendored-sources"

[source."git+{AVR_HAL_GIT}?rev={AVR_HAL_REV}"]
git = "{AVR_HAL_GIT}"
rev = "{AVR_HAL_REV}"
replace-with = "vendored-sources"

[source.vendored-sources]
directory = {}

[net]
offline = true
"#,
        toml_string(&vendor)
    );
    std::fs::write(cargo_home.join("config.toml"), config).map_err(|e| e.to_string())?;
    Ok(Some(cargo_home))
}

fn resolve_program(program: &str) -> PathBuf {
    if program == "cargo" {
        if let Some(cargo) = resource_file(&format!("{RUST_TOOLCHAIN_DIR}/bin/cargo")) {
            return cargo;
        }
    }
    PathBuf::from(program)
}

fn runtime_env() -> Result<Vec<(String, String)>, String> {
    let mut env = Vec::new();
    let mut path_dirs = Vec::new();

    for rel in [
        "bin".to_string(),
        format!("{RUST_TOOLCHAIN_DIR}/bin"),
        "toolchains/avr/bin".to_string(),
        "toolchains/avrdude/bin".to_string(),
    ] {
        if let Some(dir) = resource_dir(&rel) {
            path_dirs.push(dir);
        }
    }

    if let Some(rustc) = resource_file(&format!("{RUST_TOOLCHAIN_DIR}/bin/rustc")) {
        env.push(("RUSTC".into(), rustc.to_string_lossy().into_owned()));
    }
    if let Some(rustdoc) = resource_file(&format!("{RUST_TOOLCHAIN_DIR}/bin/rustdoc")) {
        env.push(("RUSTDOC".into(), rustdoc.to_string_lossy().into_owned()));
    }
    if let Some(cargo_home) = ensure_cargo_home()? {
        env.push((
            "CARGO_HOME".into(),
            cargo_home.to_string_lossy().into_owned(),
        ));
        env.push(("CARGO_NET_OFFLINE".into(), "true".into()));
    }

    if !path_dirs.is_empty() {
        if let Some(existing) = std::env::var_os("PATH") {
            path_dirs.extend(std::env::split_paths(&existing));
        }
        let path = std::env::join_paths(path_dirs).map_err(|e| e.to_string())?;
        env.push(("PATH".into(), path.to_string_lossy().into_owned()));
    }

    Ok(env)
}

#[derive(Clone, serde::Serialize)]
struct OutputLine {
    task: String,
    /// "stdout" | "stderr" | "info"
    stream: String,
    line: String,
}

#[derive(Clone, serde::Serialize)]
struct Finished {
    task: String,
    code: i32,
}

#[derive(Clone, serde::Serialize)]
struct DoctorCheck {
    name: String,
    /// "ok" | "warn" | "error"
    status: String,
    detail: String,
    fix: Option<String>,
}

#[derive(Clone, serde::Serialize)]
struct DoctorReport {
    checks: Vec<DoctorCheck>,
}

fn emit_line(app: &AppHandle, task: &str, stream: &str, line: &str) {
    let _ = app.emit(
        "output",
        OutputLine {
            task: task.to_string(),
            stream: stream.to_string(),
            line: line.to_string(),
        },
    );
}

async fn run_blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

/// A single entry in the file-browser tree.
#[derive(Clone, serde::Serialize)]
struct Entry {
    name: String,
    /// Absolute path on disk.
    path: String,
    is_dir: bool,
}

/// Resolve a frontend-supplied path and reject anything outside `firmware/`.
///
/// The file browser hands us absolute paths it got from `firmware_root`/`list_dir`,
/// but we still canonicalize and prefix-check so a crafted path can't read or write
/// outside the firmware project.
fn safe_path(p: &str) -> Result<PathBuf, String> {
    let root = firmware_dir()
        .canonicalize()
        .map_err(|e| format!("firmware dir not found: {e}"))?;
    let candidate = PathBuf::from(p);
    // Canonicalize when the target exists; for not-yet-created files fall back to
    // canonicalizing the parent so saving a new file still passes the guard.
    let resolved = match candidate.canonicalize() {
        Ok(c) => c,
        Err(_) => {
            let parent = candidate
                .parent()
                .ok_or_else(|| "invalid path".to_string())?
                .canonicalize()
                .map_err(|e| e.to_string())?;
            let name = candidate
                .file_name()
                .ok_or_else(|| "invalid path".to_string())?;
            parent.join(name)
        }
    };
    if resolved.starts_with(&root) {
        Ok(resolved)
    } else {
        Err("path is outside the firmware project".into())
    }
}

/// A connected board the IDE can flash to.
#[derive(Clone, serde::Serialize)]
struct DetectedBoard {
    /// Board id understood by ravedude / the picker (currently always "uno").
    board: String,
    /// Human label for the picker, e.g. "Arduino Uno".
    label: String,
    /// Serial port path, e.g. "/dev/ttyACM0" or "COM3".
    port: String,
}

/// Does this USB VID/PID belong to a board we treat as an Arduino Uno?
///
/// Covers the genuine Uno (the ATmega16U2 USB bridge) plus the USB-serial chips
/// found on the common clones (WCH CH340, FTDI FT232). VID/PID is all we have to
/// go on, so the clone chips can in theory match an unrelated USB-serial adapter
/// — the same limitation the Arduino IDE has.
fn is_uno(vid: u16, pid: u16) -> bool {
    matches!(
        (vid, pid),
        (0x2341, 0x0043) | (0x2341, 0x0001)   // genuine Arduino Uno R3 / Uno
            | (0x2a03, 0x0043) | (0x2a03, 0x0001) // Arduino.org Uno
            | (0x1a86, 0x7523) | (0x1a86, 0x5523) // CH340/CH341 clone
            | (0x0403, 0x6001) | (0x0403, 0x6015) // FTDI clone
    )
}

/// Scan the USB serial ports for a connected Arduino Uno.
///
/// Returns the first match (label + serial port) or `None` if no Uno-like board
/// is plugged in. The frontend polls this to populate the board picker and to
/// pass the port to `flash`.
#[tauri::command]
async fn detect_board() -> Option<DetectedBoard> {
    tauri::async_runtime::spawn_blocking(|| {
        let ports = serialport::available_ports().ok()?;
        for p in ports {
            if let serialport::SerialPortType::UsbPort(usb) = p.port_type {
                if is_uno(usb.vid, usb.pid) {
                    return Some(DetectedBoard {
                        board: "uno".into(),
                        label: "Arduino Uno".into(),
                        port: p.port_name,
                    });
                }
            }
        }
        None
    })
    .await
    .ok()
    .flatten()
}

/// Canonical path of the active project directory, for seeding the file tree.
#[tauri::command]
async fn firmware_root() -> Result<String, String> {
    run_blocking(|| {
        firmware_dir()
            .canonicalize()
            .map(|p| p.to_string_lossy().into_owned())
            .map_err(|e| e.to_string())
    })
    .await
}

fn doctor_check(
    checks: &mut Vec<DoctorCheck>,
    name: &str,
    status: &str,
    detail: impl Into<String>,
    fix: Option<&str>,
) {
    checks.push(DoctorCheck {
        name: name.into(),
        status: status.into(),
        detail: detail.into(),
        fix: fix.map(str::to_string),
    });
}

fn command_first_line(program: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new(program).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    stdout
        .lines()
        .chain(stderr.lines())
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_string())
}

/// Open a native directory picker; returns the chosen folder, or `None` if the
/// user cancelled. Used to pick where a new sketch project is scaffolded.
#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .blocking_pick_folder()
            .and_then(|p| p.into_path().ok())
            .map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .ok()
    .flatten()
}

/// Scaffold a fresh Arduino-Rust project at `<parent>/<name>` and switch the IDE
/// to it. The new project gets the bundled Cargo/ravedude/toolchain config but
/// starts with a single empty `src/main.rs` instead of the bundled examples.
/// Returns the new project's canonical path.
#[tauri::command]
async fn new_project(parent: String, name: String) -> Result<String, String> {
    run_blocking(move || {
        // Sanitize to a cargo-legal crate id (used for both the dir and package name).
        let clean: String = name
            .trim()
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        if clean.is_empty() {
            return Err("please enter a project name".into());
        }
        let source = bundled_firmware_dir()
            .canonicalize()
            .map_err(|e| format!("firmware skeleton not found: {e}"))?;
        let parent = PathBuf::from(&parent)
            .canonicalize()
            .map_err(|e| format!("invalid parent folder: {e}"))?;
        let dest = parent.join(&clean);
        if dest.exists() {
            return Err(format!("{} already exists", dest.display()));
        }
        if dest.starts_with(&source) {
            return Err(format!(
                "choose a parent folder outside the firmware skeleton ({})",
                source.display()
            ));
        }

        copy_project_config(&source, &dest)
            .map_err(|e| format!("could not scaffold project: {e}"))?;

        // Rename the cargo package to match the new project and remove the
        // bundled examples' default-run target; an empty main.rs is the target.
        let cargo = dest.join("Cargo.toml");
        if let Ok(txt) = std::fs::read_to_string(&cargo) {
            let renamed = txt
                .lines()
                .filter(|line| {
                    let trimmed = line.trim_start();
                    !trimmed.starts_with("default-run =")
                        && !trimmed.contains("Each file under src/bin/")
                        && !trimmed.contains("the open file with `--bin")
                        && !trimmed.contains("to maintain; `default-run")
                })
                .collect::<Vec<_>>()
                .join("\n")
                .replacen("name = \"firmware\"", &format!("name = \"{clean}\""), 1);
            let _ = std::fs::write(&cargo, renamed);
        }

        let src_dir = dest.join("src");
        std::fs::create_dir_all(&src_dir).map_err(|e| e.to_string())?;
        std::fs::write(src_dir.join("main.rs"), "").map_err(|e| e.to_string())?;

        let root = dest.canonicalize().unwrap_or(dest);
        set_active_root(root.clone());
        Ok(root.to_string_lossy().into_owned())
    })
    .await
}

/// Point the IDE at an existing cargo project (used for boot-time restore and a
/// future "Open project"). Returns its canonical path.
#[tauri::command]
async fn set_project(path: String) -> Result<String, String> {
    run_blocking(move || {
        let root = PathBuf::from(&path)
            .canonicalize()
            .map_err(|e| e.to_string())?;
        if !root.join("Cargo.toml").is_file() {
            return Err("not a cargo project (no Cargo.toml)".into());
        }
        set_active_root(root.clone());
        Ok(root.to_string_lossy().into_owned())
    })
    .await
}

/// Drop a shipped example sketch into the active project's `src/bin/` and return
/// its path. The example source is always the bundled skeleton, so File ▸
/// Examples works in any project. Existing files are left untouched.
#[tauri::command]
async fn add_example(name: String) -> Result<String, String> {
    run_blocking(move || {
        let src = bundled_firmware_dir()
            .join("src/bin")
            .join(format!("{name}.rs"));
        if !src.is_file() {
            return Err(format!("unknown example: {name}"));
        }
        let dest_dir = firmware_dir().join("src/bin");
        std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
        let dest = dest_dir.join(format!("{name}.rs"));
        if !dest.exists() {
            std::fs::copy(&src, &dest).map_err(|e| e.to_string())?;
        }
        let dest = dest.canonicalize().unwrap_or(dest);
        Ok(dest.to_string_lossy().into_owned())
    })
    .await
}

/// List the immediate children of a directory (dirs first, then files; both
/// alphabetical). Hides `target/`, `.git`, and dotfiles to reduce clutter.
#[tauri::command]
async fn list_dir(path: String) -> Result<Vec<Entry>, String> {
    run_blocking(move || {
        let dir = safe_path(&path)?;
        let mut entries = Vec::new();
        for item in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let item = item.map_err(|e| e.to_string())?;
            let name = item.file_name().to_string_lossy().into_owned();
            if name == "target" || name == ".git" || name.starts_with('.') {
                continue;
            }
            let is_dir = item.file_type().map(|t| t.is_dir()).unwrap_or(false);
            entries.push(Entry {
                name,
                path: item.path().to_string_lossy().into_owned(),
                is_dir,
            });
        }
        entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
        Ok(entries)
    })
    .await
}

/// Read any file inside the firmware project.
#[tauri::command]
async fn read_file(path: String) -> Result<String, String> {
    run_blocking(move || std::fs::read_to_string(safe_path(&path)?).map_err(|e| e.to_string()))
        .await
}

/// Write the editor buffer into any file inside the firmware project.
#[tauri::command]
async fn save_file(path: String, content: String) -> Result<(), String> {
    run_blocking(move || std::fs::write(safe_path(&path)?, content).map_err(|e| e.to_string()))
        .await
}

// ---- file-browser operations ----------------------------------------------
// Every path is validated by `safe_path`, so these can only touch files inside
// the firmware project.

/// Create a new empty file. Errors if something already exists at `path`.
#[tauri::command]
async fn create_file(path: String) -> Result<(), String> {
    run_blocking(move || {
        let p = safe_path(&path)?;
        if p.exists() {
            return Err(format!("{} already exists", p.display()));
        }
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&p, "").map_err(|e| e.to_string())
    })
    .await
}

/// Create a new directory (and any missing parents).
#[tauri::command]
async fn create_dir(path: String) -> Result<(), String> {
    run_blocking(move || {
        let p = safe_path(&path)?;
        if p.exists() {
            return Err(format!("{} already exists", p.display()));
        }
        std::fs::create_dir_all(&p).map_err(|e| e.to_string())
    })
    .await
}

/// Rename or move an entry (used for inline rename, drag-and-drop, and cut/paste).
#[tauri::command]
async fn rename_entry(from: String, to: String) -> Result<(), String> {
    run_blocking(move || {
        let from = safe_path(&from)?;
        let to = safe_path(&to)?;
        if to.exists() {
            return Err(format!("{} already exists", to.display()));
        }
        std::fs::rename(&from, &to).map_err(|e| e.to_string())
    })
    .await
}

/// Move an entry to the OS trash (recoverable).
#[tauri::command]
async fn delete_entry(path: String) -> Result<(), String> {
    run_blocking(move || {
        let p = safe_path(&path)?;
        trash::delete(&p).map_err(|e| e.to_string())
    })
    .await
}

/// Copy a file or directory (recursive). Used for copy/paste and duplicate.
#[tauri::command]
async fn copy_entry(from: String, to: String) -> Result<(), String> {
    run_blocking(move || {
        let from = safe_path(&from)?;
        let to = safe_path(&to)?;
        if to.exists() {
            return Err(format!("{} already exists", to.display()));
        }
        copy_recursive(&from, &to).map_err(|e| e.to_string())
    })
    .await
}

fn copy_recursive(from: &Path, to: &Path) -> std::io::Result<()> {
    if from.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &to.join(entry.file_name()))?;
        }
    } else {
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(from, to)?;
    }
    Ok(())
}

/// Copy a project skeleton, skipping build artifacts and repository metadata.
/// Used for the packaged first-launch project.
fn copy_skeleton(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        if name == "target" || name == ".git" {
            continue;
        }
        let src = entry.path();
        let dst = to.join(&name);
        if src.is_dir() {
            copy_skeleton(&src, &dst)?;
        } else {
            std::fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

/// Copy project config files, not bundled sketches. New sketches start with an
/// empty `src/main.rs` but keep the target, ravedude, lockfile, and editor config.
fn copy_project_config(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        let src = entry.path();
        if name == "src" || name == "target" || name == ".git" {
            continue;
        }
        if src.is_dir() {
            copy_skeleton(&src, &to.join(&name))?;
        } else {
            std::fs::copy(&src, to.join(&name))?;
        }
    }
    Ok(())
}

/// Reveal an entry in the OS file manager (Finder/Explorer/Files).
#[tauri::command]
async fn reveal(app: AppHandle, path: String) -> Result<(), String> {
    run_blocking(move || {
        let p = safe_path(&path)?;
        app.opener()
            .reveal_item_in_dir(p)
            .map_err(|e| e.to_string())
    })
    .await
}

/// Start watching a directory (non-recursive) for external changes.
#[tauri::command]
async fn watch_dir(app: AppHandle, path: String) -> Result<(), String> {
    run_blocking(move || {
        let dir = safe_path(&path)?;
        let state: State<AppState> = app.state();
        if let Some(w) = state.watcher.lock().unwrap().as_mut() {
            w.watch(&dir, RecursiveMode::NonRecursive)
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
}

/// Stop watching a directory (called when a folder is collapsed).
#[tauri::command]
async fn unwatch_dir(app: AppHandle, path: String) -> Result<(), String> {
    run_blocking(move || {
        let dir = safe_path(&path)?;
        let state: State<AppState> = app.state();
        if let Some(w) = state.watcher.lock().unwrap().as_mut() {
            let _ = w.unwatch(&dir); // ignore "wasn't watched"
        }
        Ok(())
    })
    .await
}

/// Spawn a child in the active project dir, with stdout/stderr piped. When
/// `pipe_stdin` is set, stdin is piped too so typed console input can be
/// forwarded to the child (used for the flash/ravedude session).
fn spawn_in_firmware(
    app: &AppHandle,
    task: &str,
    program: &str,
    args: &[&str],
    extra_env: &[(String, String)],
    pipe_stdin: bool,
) -> Result<Child, String> {
    let dir = firmware_dir();
    let program_path = resolve_program(program);
    emit_line(
        app,
        task,
        "info",
        &format!(
            "$ {} {}  (in {})",
            program_path.display(),
            args.join(" "),
            dir.display()
        ),
    );
    let mut cmd = Command::new(&program_path);
    cmd.args(args)
        .current_dir(&dir)
        .stdin(if pipe_stdin {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    for (k, v) in runtime_env()? {
        cmd.env(k, v);
    }

    // e.g. RAVEDUDE_PORT so ravedude flashes the exact detected port.
    for (k, v) in extra_env {
        cmd.env(k, v);
    }

    // Put the child in its own process group so the whole tree
    // (cargo -> ravedude -> avrdude) can be killed as a unit. Killing only the
    // cargo parent would orphan ravedude, which keeps the serial port + console
    // open and makes the next Upload fail with "port busy".
    #[cfg(unix)]
    cmd.process_group(0);

    // When the IDE itself is launched via `cargo tauri dev`/`cargo run`, cargo
    // exports its own toolchain pins into our environment (RUSTUP_TOOLCHAIN,
    // CARGO, RUSTC, …). If those leak into this child they override
    // firmware/rust-toolchain.toml and force the *stable* toolchain, which
    // ignores `[unstable] build-std` and fails with "can't find crate for
    // core". Strip them so the rustup proxy re-reads the firmware's pinned
    // nightly from rust-toolchain.toml.
    for var in [
        "RUSTUP_TOOLCHAIN",
        "RUSTUP_TOOLCHAIN_SOURCE",
        "CARGO",
        "RUSTC",
        "RUSTDOC",
        "RUSTC_WRAPPER",
        "RUSTC_WORKSPACE_WRAPPER",
        "RUSTC_LINKER",
    ] {
        cmd.env_remove(var);
    }

    cmd.spawn()
        .map_err(|e| format!("failed to start `{}`: {e}", program_path.to_string_lossy()))
}

/// Pump a child's stdout+stderr to the webview on background threads.
/// Returns join handles for the two reader threads.
fn pump_output(
    app: &AppHandle,
    task: &str,
    child: &mut Child,
) -> (std::thread::JoinHandle<()>, std::thread::JoinHandle<()>) {
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    let (a, t) = (app.clone(), task.to_string());
    let h_out = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            emit_line(&a, &t, "stdout", &line);
        }
    });
    let (a, t) = (app.clone(), task.to_string());
    let h_err = std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            emit_line(&a, &t, "stderr", &line);
        }
    });
    (h_out, h_err)
}

/// Kill a flash child and all its descendants (ravedude, avrdude), then reap it.
///
/// The child was spawned in its own process group (see `spawn_in_firmware`), so
/// on Unix we signal the whole group; elsewhere we fall back to killing just the
/// direct child. Reaping promptly releases the serial port.
fn kill_child_tree(child: &mut Child) {
    #[cfg(unix)]
    unsafe {
        // The group id equals the child's pid (it was made the group leader).
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill(); // direct child (and the non-Unix path)
    let _ = child.wait(); // reap so the port/handles are freed right away
}

/// Compile only: `cargo build --release [--bin <bin>]`. `bin` selects the open
/// file's binary (firmware uses one binary per file under `src/bin/`). Returns
/// after the child is spawned; completion is reported by `task-finished`.
#[tauri::command]
async fn build(app: AppHandle, bin: Option<String>) -> Result<(), String> {
    run_blocking(move || {
        let mut args = vec!["build", "--release"];
        if let Some(ref b) = bin {
            args.push("--bin");
            args.push(b);
        }
        let mut child = spawn_in_firmware(&app, "build", "cargo", &args, &[], false)?;
        let (h_out, h_err) = pump_output(&app, "build", &mut child);
        let app2 = app.clone();
        std::thread::spawn(move || {
            let _ = h_out.join();
            let _ = h_err.join();
            let exit = child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);
            let _ = app2.emit(
                "task-finished",
                Finished {
                    task: "build".into(),
                    code: exit,
                },
            );
        });
        Ok(())
    })
    .await
}

/// Compile + flash to a connected board: `cargo run --release` (ravedude).
///
/// `port` is the serial port of the detected board (from `detect_board`); when
/// present it is passed to ravedude via `RAVEDUDE_PORT` so it flashes that exact
/// device instead of guessing. Returns immediately; ravedude opens the serial
/// console and keeps running until the board disconnects or `stop_flash` is
/// called. Output streams via events.
#[tauri::command]
async fn flash(app: AppHandle, port: Option<String>, bin: Option<String>) -> Result<(), String> {
    run_blocking(move || {
        let state: State<AppState> = app.state();
        // Stop any previous flash/console session first (and its whole tree).
        let old = state.flash_child.lock().unwrap().take();
        if let Some(mut old) = old {
            kill_child_tree(&mut old);
        }
        *state.flash_stdin.lock().unwrap() = None;

        let env: Vec<(String, String)> = match &port {
            Some(p) => {
                emit_line(&app, "flash", "info", &format!("Using port {p}"));
                vec![("RAVEDUDE_PORT".into(), p.clone())]
            }
            None => vec![],
        };
        let mut args = vec!["run", "--release"];
        if let Some(ref b) = bin {
            args.push("--bin");
            args.push(b);
        }
        let mut child = spawn_in_firmware(&app, "flash", "cargo", &args, &env, true)?;
        let (h_out, h_err) = pump_output(&app, "flash", &mut child);

        // Hold onto the child's stdin so console input can be forwarded to ravedude.
        *state.flash_stdin.lock().unwrap() = child.stdin.take();

        // Keep the child so it can be stopped; wait on a detached thread so the
        // command returns immediately and the UI stays responsive.
        *state.flash_child.lock().unwrap() = Some(child);
        let app2 = app.clone();
        let handle = app.clone();
        std::thread::spawn(move || {
            let _ = h_out.join();
            let _ = h_err.join();
            let exit = {
                let state: State<AppState> = handle.state();
                *state.flash_stdin.lock().unwrap() = None;
                let mut guard = state.flash_child.lock().unwrap();
                match guard.take() {
                    Some(mut c) => c.wait().ok().and_then(|s| s.code()).unwrap_or(-1),
                    None => 0, // already stopped
                }
            };
            let _ = app2.emit(
                "task-finished",
                Finished {
                    task: "flash".into(),
                    code: exit,
                },
            );
        });
        Ok(())
    })
    .await
}

/// Stop a running flash/serial-console session (kills the whole tree).
#[tauri::command]
async fn stop_flash(app: AppHandle) -> Result<(), String> {
    run_blocking(move || {
        let state: State<AppState> = app.state();
        *state.flash_stdin.lock().unwrap() = None;
        let child = state.flash_child.lock().unwrap().take();
        if let Some(mut child) = child {
            kill_child_tree(&mut child);
            emit_line(&app, "flash", "info", "— stopped —");
        }
        Ok(())
    })
    .await
}

/// Forward a line of console input to the running flash session's stdin.
///
/// ravedude's `--open-console` relays stdin to the board over serial, so this
/// makes the Output panel behave like a terminal. Errors if nothing is running.
#[tauri::command]
async fn send_input(app: AppHandle, line: String) -> Result<(), String> {
    run_blocking(move || {
        let state: State<AppState> = app.state();
        let mut guard = state.flash_stdin.lock().unwrap();
        match guard.as_mut() {
            Some(stdin) => {
                writeln!(stdin, "{line}").map_err(|e| e.to_string())?;
                stdin.flush().map_err(|e| e.to_string())
            }
            None => Err("no running session to send input to".into()),
        }
    })
    .await
}

/// Recover a stuck serial connection.
///
/// Force-kills any running flash/console session (cargo + ravedude + avrdude) so
/// the serial port is released, even if a previous session was orphaned. Safe to
/// call when nothing is running. Exposed as File ▸ Reset connection.
#[tauri::command]
async fn reset_connection(app: AppHandle) -> Result<(), String> {
    run_blocking(move || {
        let state: State<AppState> = app.state();
        *state.flash_stdin.lock().unwrap() = None;
        let child = state.flash_child.lock().unwrap().take();
        let had_session = child.is_some();
        if let Some(mut child) = child {
            kill_child_tree(&mut child);
        }
        emit_line(
            &app,
            "flash",
            "info",
            if had_session {
                "— connection reset: stopped the flash session and freed the port —"
            } else {
                "— connection reset: no active session —"
            },
        );
        Ok(())
    })
    .await
}

/// Check the packaged runtime and the host pieces that still matter on Linux.
#[tauri::command]
async fn environment_doctor() -> Result<DoctorReport, String> {
    run_blocking(move || {
        let mut checks = Vec::new();
        let packaged = packaged_firmware_template_dir().is_some();

        if let Some(paths) = RUNTIME_PATHS.get() {
            doctor_check(
                &mut checks,
                "Resource directory",
                "ok",
                paths.resource_dir.display().to_string(),
                None,
            );
            doctor_check(
                &mut checks,
                "App data directory",
                "ok",
                paths.app_data_dir.display().to_string(),
                None,
            );
        } else {
            doctor_check(
                &mut checks,
                "Runtime paths",
                "error",
                "Tauri runtime paths were not initialized",
                None,
            );
        }

        let template = bundled_firmware_dir();
        let template_status = if template.join("Cargo.toml").is_file() {
            "ok"
        } else {
            "error"
        };
        doctor_check(
            &mut checks,
            "Firmware template",
            template_status,
            template.display().to_string(),
            None,
        );

        let project = firmware_dir();
        let project_status = if project.join("Cargo.toml").is_file() {
            "ok"
        } else {
            "error"
        };
        doctor_check(
            &mut checks,
            "Active project",
            project_status,
            project.display().to_string(),
            None,
        );

        let cargo = resolve_program("cargo");
        let cargo_version = command_first_line(&cargo, &["--version"]);
        doctor_check(
            &mut checks,
            "Cargo",
            if cargo_version.is_some() {
                if cargo.is_absolute() {
                    "ok"
                } else {
                    "warn"
                }
            } else {
                "error"
            },
            cargo_version.unwrap_or_else(|| format!("not runnable: {}", cargo.display())),
            if cargo.is_absolute() {
                None
            } else {
                Some("Packaged releases should include CrabDuino's private Cargo.")
            },
        );

        let rustc = resource_file(&format!("{RUST_TOOLCHAIN_DIR}/bin/rustc"));
        match rustc {
            Some(path) => doctor_check(
                &mut checks,
                "Rust compiler",
                "ok",
                command_first_line(&path, &["--version"])
                    .unwrap_or_else(|| path.display().to_string()),
                None,
            ),
            None => doctor_check(
                &mut checks,
                "Rust compiler",
                if packaged { "error" } else { "warn" },
                "using the host rustup/toolchain fallback",
                if packaged {
                    Some("Rebuild the package resources with scripts/package-linux-deb.sh.")
                } else {
                    None
                },
            ),
        }

        let vendor = resource_dir("vendor");
        doctor_check(
            &mut checks,
            "Vendored crates",
            if vendor.is_some() {
                "ok"
            } else if packaged {
                "error"
            } else {
                "warn"
            },
            vendor
                .as_ref()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| {
                    "not bundled; development builds may use Cargo cache/network".into()
                }),
            if packaged {
                vendor
                    .is_none()
                    .then_some("Run cargo vendor through the package script.")
            } else {
                None
            },
        );

        let avr_gcc =
            resource_file("toolchains/avr/bin/avr-gcc").unwrap_or_else(|| PathBuf::from("avr-gcc"));
        let avr_gcc_version = command_first_line(&avr_gcc, &["--version"]);
        doctor_check(
            &mut checks,
            "AVR GCC",
            if avr_gcc_version.is_some() {
                if avr_gcc.is_absolute() {
                    "ok"
                } else {
                    "warn"
                }
            } else {
                "error"
            },
            avr_gcc_version.unwrap_or_else(|| format!("not runnable: {}", avr_gcc.display())),
            if avr_gcc.is_absolute() {
                None
            } else {
                Some("Packaged releases should include CrabDuino's private AVR toolchain.")
            },
        );

        let ravedude = resource_file("bin/ravedude").unwrap_or_else(|| PathBuf::from("ravedude"));
        let ravedude_version = command_first_line(&ravedude, &["--version"]);
        doctor_check(
            &mut checks,
            "Ravedude",
            if ravedude_version.is_some() {
                if ravedude.is_absolute() {
                    "ok"
                } else {
                    "warn"
                }
            } else {
                "error"
            },
            ravedude_version.unwrap_or_else(|| format!("not runnable: {}", ravedude.display())),
            if ravedude.is_absolute() {
                None
            } else {
                Some("Packaged releases should include CrabDuino's private ravedude.")
            },
        );

        let avrdude = resource_file("bin/avrdude").unwrap_or_else(|| PathBuf::from("avrdude"));
        let avrdude_version = command_first_line(&avrdude, &["-v"]);
        doctor_check(
            &mut checks,
            "AVRDUDE",
            if avrdude_version.is_some() {
                if avrdude.is_absolute() {
                    "ok"
                } else {
                    "warn"
                }
            } else {
                "error"
            },
            avrdude_version.unwrap_or_else(|| format!("not runnable: {}", avrdude.display())),
            if avrdude.is_absolute() {
                None
            } else {
                Some("Packaged releases should include the avrdude wrapper and config.")
            },
        );

        let manifest = resource_file("manifest.json");
        doctor_check(
            &mut checks,
            "Release manifest",
            if manifest.is_some() {
                "ok"
            } else if packaged {
                "error"
            } else {
                "warn"
            },
            manifest
                .as_ref()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| "not present in this development run".into()),
            None,
        );

        #[cfg(target_os = "linux")]
        {
            let groups = command_first_line(Path::new("id"), &["-nG"]).unwrap_or_default();
            let has_serial_group = groups
                .split_whitespace()
                .any(|g| matches!(g, "dialout" | "uucp"));
            doctor_check(
                &mut checks,
                "Serial permission",
                if has_serial_group { "ok" } else { "warn" },
                if has_serial_group {
                    "current user is in a common serial-port group"
                } else {
                    "current user is not in dialout/uucp"
                },
                if has_serial_group {
                    None
                } else {
                    Some("Run: sudo usermod -aG dialout \"$USER\"; then log out and back in.")
                },
            );
        }

        Ok(DoctorReport { checks })
    })
    .await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(|app| {
            let resource_dir = app.path().resource_dir().unwrap_or_else(|_| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("package-resources")
            });
            let app_data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| dev_firmware_dir().join(".crabduino-data"));
            let _ = RUNTIME_PATHS.set(RuntimePaths {
                resource_dir,
                app_data_dir,
            });
            if let Err(e) = ensure_cargo_home() {
                eprintln!("CrabDuino startup warning: {e}");
            }

            // Build the fs watcher now that we have an AppHandle to emit from.
            // It forwards each changed path to the webview as `fs-changed`; the
            // frontend refreshes the affected folder if it is currently shown.
            let handle = app.handle().clone();
            let watcher =
                notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                    use notify::event::{EventKind, ModifyKind};
                    if let Ok(event) = res {
                        // Only structural changes affect the tree listing. Ignore plain
                        // content/metadata writes so saving a file (or cargo rewriting
                        // Cargo.lock) doesn't churn and reset the explorer.
                        match event.kind {
                            EventKind::Create(_)
                            | EventKind::Remove(_)
                            | EventKind::Modify(ModifyKind::Name(_)) => {}
                            _ => return,
                        }
                        for path in event.paths {
                            let s = path.to_string_lossy();
                            if s.contains("/target/") || s.contains("/.git/") {
                                continue;
                            }
                            let _ = handle.emit("fs-changed", s.into_owned());
                        }
                    }
                })?;
            *app.state::<AppState>().watcher.lock().unwrap() = Some(watcher);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            detect_board,
            firmware_root,
            pick_folder,
            new_project,
            set_project,
            add_example,
            list_dir,
            read_file,
            save_file,
            create_file,
            create_dir,
            rename_entry,
            delete_entry,
            copy_entry,
            reveal,
            watch_dir,
            unwatch_dir,
            build,
            flash,
            stop_flash,
            send_input,
            reset_connection,
            environment_doctor
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
