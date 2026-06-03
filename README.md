# CrabDuino

A consumer IDE that lets you program Arduino using Rust.

---

## Layout

```
.
├── README.md            ← you are here (single source of truth)
├── blink.ino            ← reference input: a stock Arduino C++ sketch
├── blink.hex            ← reference output: compiled AVR firmware
└── firmware/            ← barebones Rust project. Target: Arduino Uno (atmega328p)
    ├── Cargo.toml
    ├── Ravedude.toml    ← controls flashing + serial console behavior
    ├── rust-toolchain.toml
    ├── .cargo/config.toml
    ├── .gitignore
    ├── LICENSE-APACHE   ← upstream license (code in src/main.rs is derived from avr-hal-template)
    ├── LICENSE-MIT
    └── src/main.rs      ← the file the IDE will overwrite per sketch
```

`firmware/` started life as a clone of [Rahix/avr-hal-template](https://github.com/Rahix/avr-hal-template) but all the `cargo-generate` templating (Liquid `{% case board %}` blocks, the post-hook script, the README template, the embedded `.git`) has been stripped out. It is now a plain, ready-to-build Rust project that compiles unmodified — no `cargo generate` step required.

---

## How the firmware project compiles

Four files together describe the build. They are all hardcoded for Uno. If you ever retarget another board, every one of them needs a matching change:

| File | What it controls | Uno value |
| --- | --- | --- |
| `firmware/Cargo.toml` | `arduino-hal` feature flag selecting the board's HAL | `features = ["arduino-uno"]` |
| `firmware/.cargo/config.toml` | LLVM `target-cpu` rustflag (the build target is always `avr-none`; only the CPU varies) | `target-cpu=atmega328p` |
| `firmware/Ravedude.toml` | `ravedude` board id, serial baud, auto-console behavior | `board = "uno"`, `57600` baud |
| `firmware/src/main.rs` | LED pin (and any board-specific peripheral wiring) | `pins.d13` |

The toolchain is pinned in `firmware/rust-toolchain.toml` to **`nightly-2025-04-27`** with the `rust-src` component. AVR support requires `-Zbuild-std=core` (set via `[unstable] build-std = ["core"]` in `.cargo/config.toml`), which is only available on nightly with `rust-src` present.

Profiles in `Cargo.toml` are tuned for tiny program memory (`lto = true`, `opt-level = "s"`, `panic = "abort"`, `codegen-units = 1` on release). Don't change these casually — AVRs have ~32 KB of flash and these settings are the difference between fitting and not fitting.

---

## Prerequisites (one-time, host machine)

You need an AVR toolchain on the host plus `ravedude` for flashing. On Ubuntu/Debian:

```bash
sudo apt install gcc-avr avr-libc avrdude
cargo install ravedude
rustup component add rust-src --toolchain nightly-2025-04-27
```

The `nightly-2025-04-27` toolchain itself will be installed automatically by `rustup` the first time you `cargo build` inside `firmware/`, because `rust-toolchain.toml` requests it.

---

## One-command workflows

All commands run **from inside `firmware/`**.

### Build only (produces ELF; no board needed)

```bash
cargo build --release
```

Output: `firmware/target/avr-none/release/firmware.elf`.

### Build + flash + open serial console (board must be connected)

```bash
cargo run --release
```

`cargo run` works because `.cargo/config.toml` sets `runner = "ravedude"` for `cfg(target_arch = "avr")`. Ravedude reads `Ravedude.toml`, picks up `board = "uno"`, detects the serial port, flashes via `avrdude`, then opens a 57600-baud console attached to stdout/stdin. One command, end to end.

If ravedude can't auto-detect the port, override it with the `RAVEDUDE_PORT` env var:

```bash
RAVEDUDE_PORT=/dev/ttyUSB0 cargo run --release
```

### Build to a flashable `.hex` (no flashing)

`cargo` produces an ELF; the Arduino bootloader wants Intel HEX. Convert with `avr-objcopy` (shipped with `gcc-avr`):

```bash
cargo build --release
avr-objcopy -O ihex -R .eeprom \
    target/avr-none/release/firmware.elf \
    firmware.hex
```

This is the path the IDE will use to produce a `.hex` artifact equivalent to `blink.hex` at the repo root.

---

## How the IDE plugs into this

The IDE's compile pipeline is just:

1. Translate the user's `.ino` source to Rust.
2. Overwrite `firmware/src/main.rs` with the translation.
3. Shell out to `cargo build --release` inside `firmware/` (or `cargo run --release` for flash).
4. Either grab `target/avr-none/release/firmware.elf` and convert to hex, or let ravedude handle flashing directly.

Nothing else in `firmware/` should need to change per sketch. Keep `src/main.rs` the only file the IDE writes; everything else (`Cargo.toml`, board configs, toolchain) is invariant for a given target board.

The `blink.ino` ↔ `firmware/src/main.rs` pair in this repo is the canonical before/after example to validate the translator against. `blink.hex` is the reference output (compiled by the Arduino IDE) for a sanity check that your Rust-produced hex behaves the same on hardware.

---

## Supporting other boards later

This skeleton is Uno-only by design — multi-board flexibility is the IDE's job, not this template's. When you do add another board, you have two choices:

- **Per-board firmware dir** (`firmware-uno/`, `firmware-mega/`, …) — simplest, each dir is fully hardcoded. Recommended for the consumer product because it's the most predictable.
- **Single dir, IDE rewrites the four files** — the IDE substitutes the four hardcoded values above before invoking cargo. Less disk, more moving parts.

For reference, the relevant values per board can be cribbed from the original templated files (see [avr-hal-template](https://github.com/Rahix/avr-hal-template) upstream). Key mapping:

| Board | `arduino-hal` feature | `target-cpu` | `ravedude` board |
| --- | --- | --- | --- |
| Arduino Uno | `arduino-uno` | `atmega328p` | `uno` |
| Arduino Nano | `arduino-nano` | `atmega328p` | `nano` |
| Arduino Nano (new bootloader) | `arduino-nano` | `atmega328p` | `nano-new` |
| Arduino Mega 2560 | `arduino-mega2560` | `atmega2560` | `mega2560` |
| Arduino Leonardo | `arduino-leonardo` | `atmega32u4` | `leonardo` |
| Arduino Micro | `arduino-micro` | `atmega32u4` | `micro` |
| SparkFun ProMicro | `sparkfun-promicro` | `atmega32u4` | `promicro` |
| Adafruit Trinket | `trinket` | `attiny85` | `trinket` |

Leonardo/Micro/ProMicro emulate the serial console over USB, which `avr-hal` doesn't yet support — set `open-console = false` in `Ravedude.toml` for those.

---

## License

Code under `firmware/src/` and the build config are derived from [Rahix/avr-hal-template](https://github.com/Rahix/avr-hal-template) and remain under MIT OR Apache-2.0 (see `firmware/LICENSE-APACHE` and `firmware/LICENSE-MIT`). The IDE you build around this repo can be licensed however you choose, but the firmware skeleton itself carries upstream attribution.
