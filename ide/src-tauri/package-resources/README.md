# CrabDuino package resources

This directory is a staging area for Linux release assets.

Run `scripts/package-linux-deb.sh` from the repository root to populate it with
the firmware template, vendored crates, private toolchains, and release manifest
before `cargo tauri build --bundles deb` runs.
