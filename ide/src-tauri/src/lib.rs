// CrabDuino — Tauri backend.
//
// The IDE is a thin wrapper around the `firmware/` Rust skeleton (see the repo
// README). Users edit Rust; we write it into `firmware/src/main.rs` and shell
// out to cargo:
//   * build  -> `cargo build --release`            (compile only)
//   * flash  -> `cargo run --release`  (ravedude)  (program + serial console)
// All child-process output is streamed to the webview as `output` events, and a
// `task-finished` event carries the exit code when a task ends.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

/// Shared backend state.
#[derive(Default)]
struct AppState {
    /// The currently running flash/`cargo run` child so it can be stopped
    /// (ravedude keeps the serial console open and never exits on its own).
    flash_child: Mutex<Option<Child>>,
    /// Filesystem watcher; folders are added/removed as the tree expands so we
    /// never watch the huge `target/` dir (it is hidden and never expanded).
    watcher: Mutex<Option<RecommendedWatcher>>,
}

/// Locate the `firmware/` directory that holds the build skeleton.
///
/// Override with the `CRABDUINO_FIRMWARE` env var; otherwise default to
/// `../../firmware` relative to this crate (ide/src-tauri -> repo root).
fn firmware_dir() -> PathBuf {
    if let Ok(p) = std::env::var("CRABDUINO_FIRMWARE") {
        return PathBuf::from(p);
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let candidate = manifest.join("../../firmware");
    candidate.canonicalize().unwrap_or(candidate)
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

/// Canonical path of the `firmware/` directory, for seeding the file tree.
#[tauri::command]
fn firmware_root() -> Result<String, String> {
    firmware_dir()
        .canonicalize()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

/// List the immediate children of a directory (dirs first, then files; both
/// alphabetical). Hides `target/`, `.git`, and dotfiles to reduce clutter.
#[tauri::command]
fn list_dir(path: String) -> Result<Vec<Entry>, String> {
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
}

/// Read any file inside the firmware project.
#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(safe_path(&path)?).map_err(|e| e.to_string())
}

/// Write the editor buffer into any file inside the firmware project.
#[tauri::command]
fn save_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(safe_path(&path)?, content).map_err(|e| e.to_string())
}

// ---- file-browser operations ----------------------------------------------
// Every path is validated by `safe_path`, so these can only touch files inside
// the firmware project.

/// Create a new empty file. Errors if something already exists at `path`.
#[tauri::command]
fn create_file(path: String) -> Result<(), String> {
    let p = safe_path(&path)?;
    if p.exists() {
        return Err(format!("{} already exists", p.display()));
    }
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, "").map_err(|e| e.to_string())
}

/// Create a new directory (and any missing parents).
#[tauri::command]
fn create_dir(path: String) -> Result<(), String> {
    let p = safe_path(&path)?;
    if p.exists() {
        return Err(format!("{} already exists", p.display()));
    }
    std::fs::create_dir_all(&p).map_err(|e| e.to_string())
}

/// Rename or move an entry (used for inline rename, drag-and-drop, and cut/paste).
#[tauri::command]
fn rename_entry(from: String, to: String) -> Result<(), String> {
    let from = safe_path(&from)?;
    let to = safe_path(&to)?;
    if to.exists() {
        return Err(format!("{} already exists", to.display()));
    }
    std::fs::rename(&from, &to).map_err(|e| e.to_string())
}

/// Move an entry to the OS trash (recoverable).
#[tauri::command]
fn delete_entry(path: String) -> Result<(), String> {
    let p = safe_path(&path)?;
    trash::delete(&p).map_err(|e| e.to_string())
}

/// Copy a file or directory (recursive). Used for copy/paste and duplicate.
#[tauri::command]
fn copy_entry(from: String, to: String) -> Result<(), String> {
    let from = safe_path(&from)?;
    let to = safe_path(&to)?;
    if to.exists() {
        return Err(format!("{} already exists", to.display()));
    }
    copy_recursive(&from, &to).map_err(|e| e.to_string())
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

/// Reveal an entry in the OS file manager (Finder/Explorer/Files).
#[tauri::command]
fn reveal(app: AppHandle, path: String) -> Result<(), String> {
    let p = safe_path(&path)?;
    app.opener()
        .reveal_item_in_dir(p)
        .map_err(|e| e.to_string())
}

/// Start watching a directory (non-recursive) for external changes.
#[tauri::command]
fn watch_dir(path: String, state: State<AppState>) -> Result<(), String> {
    let dir = safe_path(&path)?;
    if let Some(w) = state.watcher.lock().unwrap().as_mut() {
        w.watch(&dir, RecursiveMode::NonRecursive)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Stop watching a directory (called when a folder is collapsed).
#[tauri::command]
fn unwatch_dir(path: String, state: State<AppState>) -> Result<(), String> {
    let dir = safe_path(&path)?;
    if let Some(w) = state.watcher.lock().unwrap().as_mut() {
        let _ = w.unwatch(&dir); // ignore "wasn't watched"
    }
    Ok(())
}

/// Spawn a child in firmware/, returning the child with stdout/stderr piped.
fn spawn_in_firmware(
    app: &AppHandle,
    task: &str,
    program: &str,
    args: &[&str],
) -> Result<Child, String> {
    let dir = firmware_dir();
    emit_line(
        app,
        task,
        "info",
        &format!("$ {} {}  (in {})", program, args.join(" "), dir.display()),
    );
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(&dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

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
        .map_err(|e| format!("failed to start `{program}`: {e}"))
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

/// Compile only: `cargo build --release`. Blocks until the build finishes and
/// returns the exit code.
#[tauri::command]
fn build(app: AppHandle) -> Result<i32, String> {
    let mut child = spawn_in_firmware(&app, "build", "cargo", &["build", "--release"])?;
    let (h_out, h_err) = pump_output(&app, "build", &mut child);
    let _ = h_out.join();
    let _ = h_err.join();
    let status = child.wait().map_err(|e| e.to_string())?;
    let exit = status.code().unwrap_or(-1);
    let _ = app.emit(
        "task-finished",
        Finished {
            task: "build".into(),
            code: exit,
        },
    );
    Ok(exit)
}

/// Compile + flash to a connected board: `cargo run --release` (ravedude).
/// Returns immediately; ravedude opens the serial console and keeps running
/// until the board disconnects or `stop_flash` is called. Output streams via
/// events.
#[tauri::command]
fn flash(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    // Stop any previous flash/console session first.
    if let Some(mut old) = state.flash_child.lock().unwrap().take() {
        let _ = old.kill();
    }

    let mut child = spawn_in_firmware(&app, "flash", "cargo", &["run", "--release"])?;
    let (h_out, h_err) = pump_output(&app, "flash", &mut child);

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
}

/// Stop a running flash/serial-console session.
#[tauri::command]
fn stop_flash(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    if let Some(mut child) = state.flash_child.lock().unwrap().take() {
        let _ = child.kill();
        emit_line(&app, "flash", "info", "— stopped —");
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .setup(|app| {
            // Build the fs watcher now that we have an AppHandle to emit from.
            // It forwards each changed path to the webview as `fs-changed`; the
            // frontend refreshes the affected folder if it is currently shown.
            let handle = app.handle().clone();
            let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
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
            firmware_root,
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
            stop_flash
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
