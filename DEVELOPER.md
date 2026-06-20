# CrabDuino — Developer Guide

How CrabDuino actually works under the hood. For "just run it," see
[README.md](README.md).

CrabDuino is two pieces glued by a simple contract:

1. **`firmware/`** — a plain, ready-to-build Rust project that targets the
   Arduino Uno (atmega328p). It compiles unmodified; no `cargo generate` step.
2. **`ide/`** — a [Tauri v2](https://tauri.app) desktop app that edits the files
   in `firmware/` and shells out to `cargo` to build and flash them.

There is **no `.ino` translation anywhere**. The user writes Rust against
`arduino-hal`; the IDE just compiles that Rust.

---

## 1. The firmware skeleton (`firmware/`)

`firmware/` began as a clone of
[Rahix/avr-hal-template](https://github.com/Rahix/avr-hal-template), but all the
`cargo-generate` machinery (Liquid `{% case board %}` blocks, the post-generate
hook, the README template, the embedded `.git`) has been stripped out. What's
left is a normal Cargo project that builds with `cargo build`.

### The four files that pin it to the Uno

The board target is described by four files. They are **all hardcoded for the
Uno**. Retargeting another board means changing every one of them in lockstep:

| File | Controls | Uno value |
| --- | --- | --- |
| `firmware/Cargo.toml` | `arduino-hal` feature flag for the board's HAL | `features = ["arduino-uno"]` |
| `firmware/.cargo/config.toml` | LLVM `target-cpu` rustflag (build target is always `avr-none`; only the CPU varies) | `target-cpu=atmega328p` |
| `firmware/Ravedude.toml` | ravedude board id, serial baud, auto-console | `board = "uno"`, `57600` baud |
| `firmware/src/main.rs`, `firmware/src/bin/*.rs` | the sketches themselves (pins/peripheral wiring) | `pins.d13`, … |

### Toolchain & build settings (don't touch casually)

- **Toolchain** is pinned in `firmware/rust-toolchain.toml` to
  **`nightly-2025-04-27`** with the `rust-src` component. AVR needs
  `-Zbuild-std=core` (declared as `[unstable] build-std = ["core"]` in
  `.cargo/config.toml`), which only works on nightly with `rust-src` present.
- **`arduino-hal`** is pinned to a specific git `rev` in `Cargo.toml` — avr-hal
  has no crates.io releases, so the revision is the version.
- **Profiles** are tuned for tiny flash: `lto = true`, `opt-level = "s"`,
  `panic = "abort"`, `codegen-units = 1` (release). The Uno has ~32 KB of flash;
  these settings are the difference between fitting and not fitting.

### Manual build commands

All run from inside `firmware/`:

```bash
# Compile only (produces an ELF; no board needed)
cargo build --release
# -> firmware/target/avr-none/release/firmware.elf

# Compile + flash + open serial console (board must be connected)
cargo run --release
```

`cargo run` flashes because `.cargo/config.toml` sets `runner = "ravedude"` for
`cfg(target_arch = "avr")`. Ravedude reads `Ravedude.toml`, picks `board = "uno"`,
auto-detects the serial port, flashes via `avrdude`, then opens a 57600-baud
console. If the port isn't auto-detected, override it:

```bash
RAVEDUDE_PORT=/dev/ttyUSB0 cargo run --release
```

To produce a flashable Intel HEX (the Arduino bootloader wants HEX, cargo emits
ELF):

```bash
cargo build --release
avr-objcopy -O ihex -R .eeprom \
    target/avr-none/release/firmware.elf firmware.hex
```

---

## 2. The IDE (`ide/`)

```
ide/
├── ui/                      ← frontend: plain HTML/CSS/JS, no build step
│   ├── index.html
│   ├── app.js               ← ~875 lines: editor, file tree, console, menus
│   ├── styles.css
│   ├── codemirror-github.css
│   └── vendor/
│       ├── codemirror/      ← vendored CodeMirror 5 (editor + Rust simple-mode)
│       └── fonts/           ← Source Code Pro
└── src-tauri/
    ├── src/lib.rs           ← all Tauri commands + the fs watcher
    ├── src/main.rs          ← entry point (calls crabduino_lib::run)
    ├── tauri.conf.json      ← frontendDist -> ../ui; frameless 1100×720 window
    ├── capabilities/        ← Tauri permission set
    └── Cargo.toml           ← tauri, tauri-plugin-opener, notify, trash, serde
```

### Backend (`src-tauri/src/lib.rs`)

The backend is deliberately thin. Every command is one of three kinds:

**Build / flash (shell out to cargo):**

| Command | Runs in `firmware/` | Notes |
| --- | --- | --- |
| `build` | `cargo build --release` | Blocks until done, returns exit code. |
| `flash` | `cargo run --release` | Takes the detected `port` and passes it as `RAVEDUDE_PORT`. Returns immediately; ravedude keeps the console open. Stored as a child so it can be killed. |
| `stop_flash` | — | Kills the running flash/console process group. |
| `reset_connection` | — | Force-kills any flash session + its tree to free a stuck serial port (File ▸ Reset connection). Safe when nothing runs. |

**Board detection:** `detect_board` enumerates USB serial ports (`serialport`
crate; needs `libudev` on Linux) and returns the first one whose VID/PID matches
a known Arduino Uno — the genuine Uno plus the common clone USB-serial chips
(CH340, FTDI). The frontend polls it every 2 s to populate the picker and to feed
the port to `flash`.

**File browser (sandboxed fs ops):**
`firmware_root`, `list_dir`, `read_file`, `save_file`, `create_file`,
`create_dir`, `rename_entry`, `copy_entry`, `delete_entry` (moves to OS trash via
the `trash` crate — recoverable), `reveal` (open in the OS file manager),
`watch_dir` / `unwatch_dir`.

**Streaming:** child stdout/stderr are pumped on background threads and emitted
to the webview as `output` events (`{task, stream, line}`); a `task-finished`
event carries the exit code. The fs watcher emits `fs-changed` with the path.

#### Three things worth knowing

- **`safe_path` sandbox.** The frontend hands the backend absolute paths, but
  every fs command runs them through `safe_path`, which canonicalizes and
  prefix-checks against the canonical `firmware/` root. A crafted path can't read
  or write outside the firmware project. For not-yet-created files it
  canonicalizes the *parent* so saving a new file still passes.

- **Toolchain env stripping (the subtle one).** When the IDE is itself launched
  with `cargo tauri dev` / `cargo run`, cargo exports its own toolchain pins
  (`RUSTUP_TOOLCHAIN`, `CARGO`, `RUSTC`, …) into the environment. If those leak
  into the child `cargo build` for the firmware, they override
  `firmware/rust-toolchain.toml` and force the **stable** toolchain — which
  ignores `[unstable] build-std` and fails with *"can't find crate for `core`"*.
  `spawn_in_firmware` `env_remove`s those vars so the rustup proxy re-reads the
  firmware's pinned nightly. If you ever see that error from inside the app but
  not from a terminal, this is why.

- **The watcher avoids `target/`.** The fs watcher only reacts to structural
  changes (create / remove / rename) and explicitly skips `/target/` and
  `/.git/`, so a `cargo build` rewriting thousands of artifact files doesn't
  churn the explorer. `target/`, `.git`, and dotfiles are also hidden from
  `list_dir`.

- **Killing the flash tree.** `flash` runs `cargo run`, which spawns ravedude,
  which spawns avrdude and then holds the serial console open. Killing only the
  cargo parent would orphan ravedude and leave the port busy. So on Unix the
  child is spawned in its own process group (`process_group(0)`) and
  `kill_child_tree` signals the whole group (`kill(-pgid)`). `stop_flash` and
  `reset_connection` both use it; `reset_connection` is the user-facing recovery
  for a stuck port.

#### Firmware location

`firmware_dir()` resolves to `../../firmware` relative to the crate
(`ide/src-tauri` → repo root). Override with the **`CRABDUINO_FIRMWARE`** env var
to point the IDE at any firmware project.

### Frontend (`ide/ui/`)

Buildless on purpose — no npm, Node, Vite, or TypeScript. CodeMirror 5 is
vendored as static files. Tauri's `withGlobalTauri` (set in `tauri.conf.json`)
exposes `invoke`/`listen` on `window.__TAURI__`, so `app.js` runs as-is.

- **Editor:** CodeMirror 5 with a Rust simple-mode and a GitHub theme. Font size
  is a shared `--editor-font` CSS variable (editor + console scale together),
  persisted in `localStorage`; zoom via `Ctrl +/-/0` and `Ctrl+scroll`.
- **Active-file model:** there are no tabs. Opening a file in the explorer loads
  it into the single editor buffer and remembers `currentPath`; `Ctrl+S`
  (`save_file`) writes that buffer back to `currentPath`. The starter snippet
  shown on launch isn't bound to a file until you open one.
- **File explorer:** lazy-expanding tree built from `firmware_root` + `list_dir`,
  with new file/folder, rename, cut/copy/paste (`rename_entry`/`copy_entry`),
  delete-to-trash, reveal-in-OS, and live refresh from `fs-changed` events.
- **Window:** frameless (`decorations: false`); the titlebar is a custom drag
  region with its own min/max/close buttons and File/Edit menus.

The **View Simulator** button is a placeholder panel — a real board simulator
isn't implemented yet.

---

## 3. The IDE ↔ firmware contract

CrabDuino supports two Cargo sketch shapes:

- `src/main.rs` is the package's default binary and builds/runs without
  `--bin`.
- `src/bin/<name>.rs` is auto-discovered by Cargo as a binary named `<name>`.

The bundled `firmware/` project ships examples under `src/bin/`; File ▸ New
sketch creates a fresh project with only the board config files and an empty
`src/main.rs`.

The whole compile pipeline is:

1. The user edits `src/main.rs` or a sketch under `src/bin/`; saving writes
   straight to disk via `save_file`.
2. The frontend derives the Cargo target from the open file path: `src/main.rs`
   uses no `--bin`, while `…/src/bin/<name>.rs` maps to `--bin <name>`. It
   disables Verify/Upload when the open file is not a runnable sketch.
3. **Verify** runs `cargo build --release` or
   `cargo build --release --bin <name>`.
4. **Upload** runs `cargo run --release` or
   `cargo run --release --bin <name>` with `RAVEDUDE_PORT` set to the detected
   board, letting ravedude flash and open the console.
5. Output streams back as events; the exit code arrives in `task-finished`.

Adding a sketch is either editing `src/main.rs` or dropping a new file in
`src/bin/` — no config changes. The board configuration (`Cargo.toml`,
`.cargo/config.toml`, `Ravedude.toml`, toolchain) is invariant for a given
target board.

---

## 4. Supporting other boards later

This skeleton is Uno-only by design — multi-board support is the IDE's job, not
the template's. Two viable approaches:

- **Per-board firmware dirs** (`firmware-uno/`, `firmware-mega/`, …): simplest,
  each fully hardcoded, most predictable for a consumer product.
- **One dir, IDE rewrites the four files** before invoking cargo: less disk, more
  moving parts.

Per-board values (cribbed from
[avr-hal-template](https://github.com/Rahix/avr-hal-template)):

| Board | `arduino-hal` feature | `target-cpu` | ravedude board |
| --- | --- | --- | --- |
| Arduino Uno | `arduino-uno` | `atmega328p` | `uno` |
| Arduino Nano | `arduino-nano` | `atmega328p` | `nano` |
| Arduino Nano (new bootloader) | `arduino-nano` | `atmega328p` | `nano-new` |
| Arduino Mega 2560 | `arduino-mega2560` | `atmega2560` | `mega2560` |
| Arduino Leonardo | `arduino-leonardo` | `atmega32u4` | `leonardo` |
| Arduino Micro | `arduino-micro` | `atmega32u4` | `micro` |
| SparkFun ProMicro | `sparkfun-promicro` | `atmega32u4` | `promicro` |
| Adafruit Trinket | `trinket` | `attiny85` | `trinket` |

Leonardo/Micro/ProMicro emulate the serial console over USB, which `avr-hal`
doesn't yet support — set `open-console = false` in `Ravedude.toml` for those.

---

## License

The firmware skeleton (`firmware/src/` and its build config) is derived from
[Rahix/avr-hal-template](https://github.com/Rahix/avr-hal-template) and carries
its upstream **MIT OR Apache-2.0** licensing. The IDE around it can be licensed
however you choose.
