# CrabDuino Linux Packaging

CrabDuino's first consumer package targets Debian/Ubuntu `amd64` as a `.deb`.

The user-facing flow is:

```bash
sudo apt install ./crabduino_0.1.0_amd64.deb
```

Then open CrabDuino, plug in an Arduino Uno, click Verify, and click Upload.
Users should not install Rust, Cargo, ravedude, `gcc-avr`, `avr-libc`, or
`avrdude` manually.

## What apt installs

The CrabDuino `.deb` contains the IDE plus private, app-owned build tools under
the Tauri resource directory:

- pinned Rust nightly with `rust-src`
- AVR GCC/binutils/libc toolchain
- ravedude
- avrdude plus a wrapper that points at the bundled `avrdude.conf`
- vendored Rust crates for the firmware project
- read-only firmware template copied to a writable user project on first launch

Apt may still install normal Linux desktop libraries declared by the package,
such as WebKitGTK, GTK, libudev, librsvg, and xdg-utils. Those are system GUI
runtime libraries, not CrabDuino-specific compiler tools.

## Build a release package

On the build machine, install the developer prerequisites once, then run:

```bash
scripts/package-linux-deb.sh
```

The script stages release assets in `ide/src-tauri/package-resources/` from the
constants at the top of the script, writes a runtime manifest and `SHA256SUMS`,
then runs:

```bash
cd ide
cargo tauri build --bundles deb
```

Use `CRABDUINO_STAGE_ONLY=1 scripts/package-linux-deb.sh` to populate and verify
package resources without building the `.deb`.

## Release checks

- Test in a clean Ubuntu/Debian VM with no Rust, ravedude, AVR packages, or
  avrdude installed.
- Verify the app builds a sketch while offline.
- Verify Upload flashes an Arduino Uno.
- Run File -> Environment Doctor and confirm packaged tools are reported as
  bundled, not host fallbacks.
- Confirm uninstall removes app files but leaves user projects under app data.

If Upload fails with serial permissions, the user fix remains:

```bash
sudo usermod -aG dialout "$USER"
```

Then log out and back in.
