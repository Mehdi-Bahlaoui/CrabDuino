<img width="1260" height="324" alt="Image" src="https://github.com/user-attachments/assets/892236d5-834b-4a2d-b2ca-e22e5c78519d" />

A desktop IDE for programming the **Arduino Uno in Rust**.

You write real Rust code - **no `.ino` file or no C++ translation**.
CrabDuino creates or opens a folder for you, then lets you build and flashe it to your Arduino Uno with one click.

The IDE itself is also written in Rust!
The backend uses [`arduino-hal`](https://github.com/rahix/avr-hal).
The frontend is a [Tauri v2](https://tauri.app) app with HTML/CSS/JS for styling and positioning.

> Working on CrabDuino itself? See **[DEVELOPER.md](DEVELOPER.md)** for how the
> build pipeline and backend actually work. This file is just how to run it.

---

## Prerequisites

**To launch the IDE window** you need a Rust toolchain and the Tauri CLI:

```bash
# Rust (if you don't have it): https://rustup.rs
cargo install tauri-cli --version "^2"   # provides the `cargo tauri` command
```

On Linux, building the app also needs libudev (for USB board detection):

```bash
sudo apt install libudev-dev        # Debian/Ubuntu
```

**To actually Verify (build) or Upload (flash)** a sketch, you also need the AVR
toolchain on your machine, because those shell out to cargo + ravedude. On
Ubuntu/Debian:

```bash
sudo apt install gcc-avr avr-libc avrdude
cargo install ravedude
rustup component add rust-src --toolchain nightly-2025-04-27
```

The pinned `nightly-2025-04-27` toolchain installs itself automatically the first
time the firmware project builds (it's requested by `firmware/rust-toolchain.toml`).

---

## Run

```bash
cd ide
cargo tauri dev
```

This opens the CrabDuino window with hot-reload of the Rust backend. The frontend
is static files served from `ide/ui/` — edit them and refresh.

### Build a distributable app

```bash
cd ide
cargo tauri build
```

Bundles (`.deb`/`.AppImage`/`.dmg`/`.msi`, depending on your OS) land in
`ide/src-tauri/target/release/bundle/`.

For the consumer Debian/Ubuntu package with CrabDuino's private Rust/AVR build
stack, use `scripts/package-linux-deb.sh` from the repo root. See
**[PACKAGING.md](PACKAGING.md)**.

---

## Using the app

| Control          | What it does                                                        |
| ---------------- | ------------------------------------------------------------------- |
| **File ▸ New sketch** | Create a new project with the board config and an empty `src/main.rs`. |
| **File ▸ Open folder** | Switch the IDE to an existing Cargo/CrabDuino project folder.       |
| **File explorer** | VS Code-style sidebar over the active project. Open a file to edit it. |
| **Verify**        | `cargo build --release` for `src/main.rs`, or `cargo build --release --bin <name>` for `src/bin/<name>.rs`. |
| **Upload**        | `cargo run --release` for `src/main.rs`, or `cargo run --release --bin <name>` for `src/bin/<name>.rs`; flashes to the **detected** Uno and opens the console. |
| **Stop**          | Kill the running flash/console session.                             |
| **Board**         | Shows your Arduino Uno (and its port) only while it's plugged in and detected. |
| **Output panel**  | Live cargo/ravedude output streamed from the backend.              |
| **Ctrl + S**      | Save the active file. `Ctrl +`/`-`/`0` and `Ctrl+scroll` zoom.      |

New sketches start with an empty `src/main.rs`. Example sketches live under
`src/bin/` (e.g. `blink.rs`, `button.rs`) and build as named binaries.
Verify/Upload always act on the file currently open in the editor.

Typical loop: create or open a project → edit `src/main.rs` or a sketch under
`src/bin/` → **Verify** to compile → plug in an Uno → **Upload** to flash it
and watch the serial console.

By default CrabDuino edits the `firmware/` directory next to the app. Use
**File ▸ Open folder** to switch projects from the UI, or point the default at a
different firmware project with the `CRABDUINO_FIRMWARE` environment variable:

```bash
CRABDUINO_FIRMWARE=/path/to/firmware cargo tauri dev
```

---

## Repo layout

```
.
├── README.md      ← you are here (how to run the app)
├── DEVELOPER.md   ← how it works under the hood
├── ide/           ← the Tauri app (Rust backend + buildless web frontend)
├── firmware/      ← the Rust skeleton the IDE compiles (target: Arduino Uno)
└── website/       ← marketing site (static)
```
