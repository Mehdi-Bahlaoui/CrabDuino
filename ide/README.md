# CrabDuino (`ide/`)

A small [Tauri v2](https://tauri.app) desktop app for writing **Rust** for the
Arduino Uno, then building and flashing it. It is a thin wrapper around the
`../firmware/` build skeleton (see the repo-root README): the editor buffer is
written into `firmware/src/main.rs` and the backend shells out to cargo.

There is **no `.ino` translation** — users author Rust against `arduino-hal`
directly.

## Layout

```
ide/
├── ui/                      ← frontend: plain HTML/CSS/JS, no build step
│   ├── index.html
│   ├── app.js               ← uses window.__TAURI__ (withGlobalTauri)
│   ├── styles.css
│   └── vendor/codemirror/   ← vendored CodeMirror 5 (editor + Rust mode)
└── src-tauri/
    ├── src/lib.rs           ← commands: get_sketch, save_sketch, build, flash, stop_flash
    ├── tauri.conf.json      ← frontendDist points at ../ui
    └── Cargo.toml
```

The frontend is deliberately buildless — no npm, Node, Vite, or TypeScript.
CodeMirror is vendored as static files. Tauri's `withGlobalTauri` exposes
`invoke`/`listen` on `window.__TAURI__`, so `app.js` runs as-is.

## Run

```bash
cd ide
cargo tauri dev      # dev window with hot-reload of the Rust backend
```

Build a distributable bundle:

```bash
cargo tauri build
```

## What the buttons do

| Button         | Backend command | Shells out to (in `../firmware/`)        |
| -------------- | --------------- | ---------------------------------------- |
| Verify         | `build`         | `cargo build --release`                  |
| Upload         | `flash`         | `cargo run --release` (ravedude flashes) |
| Stop           | `stop_flash`    | kills the running flash/console child    |
| View Simulator | —               | placeholder panel (not implemented yet)  |

All child-process output streams to the console panel via `output` events; a
`task-finished` event carries the exit code.

## Notes / next steps

- **Firmware location** defaults to `../firmware` (resolved from the crate dir).
  Override with the `CRABDUINO_FIRMWARE` env var.
- **Prerequisites** are the host AVR toolchain from the repo-root README
  (`gcc-avr`, `avrdude`, `ravedude`, and `rust-src` for the pinned nightly).
- Upload keeps ravedude's serial console open (Uno default 57600 baud); use
  **Stop** to end it. A dedicated serial monitor and a real board simulator are
  natural follow-ups.
