#!/usr/bin/env bash
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RESOURCES="$ROOT/ide/src-tauri/package-resources"

# Release constants. On the current build machine these defaults should be
# enough: install the developer prerequisites once, then run this script.
RUST_TOOLCHAIN="nightly-2025-04-27"
RUST_RESOURCE_DIR="rust-nightly-2025-04-27"
# Source of the firmware template that ships as `firmware-template/`.
FIRMWARE_DIR="firmware-test"
SYSTEM_AVR_BIN_DIR="/usr/bin"
SYSTEM_AVR_GCC_DIR="/usr/lib/gcc/avr"
SYSTEM_AVR_LIB_DIR="/usr/lib/avr"
AVRDUDE_BIN="/usr/bin/avrdude"
AVRDUDE_CONF="/etc/avrdude.conf"
RAVEDUDE_BIN="${HOME}/.cargo/bin/ravedude"

# Optional local overrides without editing the script:
RUST_TOOLCHAIN="${CRABDUINO_RUST_TOOLCHAIN:-$RUST_TOOLCHAIN}"
SYSTEM_AVR_BIN_DIR="${CRABDUINO_SYSTEM_AVR_BIN_DIR:-$SYSTEM_AVR_BIN_DIR}"
SYSTEM_AVR_GCC_DIR="${CRABDUINO_SYSTEM_AVR_GCC_DIR:-$SYSTEM_AVR_GCC_DIR}"
SYSTEM_AVR_LIB_DIR="${CRABDUINO_SYSTEM_AVR_LIB_DIR:-$SYSTEM_AVR_LIB_DIR}"
AVRDUDE_BIN="${CRABDUINO_AVRDUDE_BIN:-$AVRDUDE_BIN}"
AVRDUDE_CONF="${CRABDUINO_AVRDUDE_CONF:-$AVRDUDE_CONF}"
RAVEDUDE_BIN="${CRABDUINO_RAVEDUDE_BIN:-$RAVEDUDE_BIN}"
STAGE_ONLY="${CRABDUINO_STAGE_ONLY:-0}"

usage() {
  cat <<'USAGE'
Build the CrabDuino Debian package resources and .deb.

Default build-machine inputs:
  /usr/bin/avr-*
  /usr/lib/gcc/avr
  /usr/lib/avr
  /usr/bin/avrdude
  /etc/avrdude.conf
  ~/.cargo/bin/ravedude
  rustup toolchain nightly-2025-04-27 with rust-src

Optional overrides:
  CRABDUINO_SYSTEM_AVR_BIN_DIR=/usr/bin
  CRABDUINO_SYSTEM_AVR_GCC_DIR=/usr/lib/gcc/avr
  CRABDUINO_SYSTEM_AVR_LIB_DIR=/usr/lib/avr
  CRABDUINO_AVRDUDE_BIN=/usr/bin/avrdude
  CRABDUINO_AVRDUDE_CONF=/path/to/avrdude.conf
  CRABDUINO_RAVEDUDE_BIN=/path/to/ravedude
  CRABDUINO_RUST_TOOLCHAIN=nightly-2025-04-27
  CRABDUINO_STAGE_ONLY=1

Example:
  scripts/package-linux-deb.sh
USAGE
}

json_string() {
  local s="${1//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  printf '"%s"' "$s"
}

require_file() {
  if [[ ! -f "$1" ]]; then
    echo "missing file: $1" >&2
    exit 1
  fi
}

require_dir() {
  if [[ ! -d "$1" ]]; then
    echo "missing directory: $1" >&2
    exit 1
  fi
}

require_executable() {
  if [[ ! -x "$1" ]]; then
    echo "missing executable: $1" >&2
    exit 1
  fi
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ ! -x "$RAVEDUDE_BIN" ]]; then
  RAVEDUDE_BIN="$(command -v ravedude || true)"
fi
if [[ -z "${RAVEDUDE_BIN:-}" || ! -x "$RAVEDUDE_BIN" ]]; then
  echo "ravedude not found at ~/.cargo/bin/ravedude or PATH" >&2
  echo "Install it with: cargo install ravedude" >&2
  exit 1
fi

RUST_SYSROOT="$(rustc +"$RUST_TOOLCHAIN" --print sysroot)"
require_executable "$RUST_SYSROOT/bin/cargo"
require_executable "$RUST_SYSROOT/bin/rustc"
if [[ ! -d "$RUST_SYSROOT/lib/rustlib/src/rust/library" ]]; then
  echo "rust-src is missing for $RUST_TOOLCHAIN" >&2
  echo "Install it with: rustup component add rust-src --toolchain $RUST_TOOLCHAIN" >&2
  exit 1
fi

require_executable "$SYSTEM_AVR_BIN_DIR/avr-gcc"
require_executable "$SYSTEM_AVR_BIN_DIR/avr-objcopy"
require_dir "$SYSTEM_AVR_GCC_DIR"
require_file "$SYSTEM_AVR_LIB_DIR/include/avr/io.h"
require_executable "$AVRDUDE_BIN"
require_file "$AVRDUDE_CONF"
require_executable "$RAVEDUDE_BIN"

mkdir -p "$RESOURCES"
find "$RESOURCES" -mindepth 1 -maxdepth 1 \
  ! -name README.md \
  ! -name .gitignore \
  -exec rm -rf {} +

mkdir -p \
  "$RESOURCES/bin" \
  "$RESOURCES/firmware-template" \
  "$RESOURCES/licenses" \
  "$RESOURCES/toolchains" \
  "$RESOURCES/toolchains/avr/bin" \
  "$RESOURCES/toolchains/avr/lib/gcc" \
  "$RESOURCES/toolchains/avrdude/bin" \
  "$RESOURCES/toolchains/avrdude/etc"

tar -C "$ROOT" \
  --exclude="$FIRMWARE_DIR/target" \
  --exclude="$FIRMWARE_DIR/.git" \
  -cf - "$FIRMWARE_DIR" |
  tar -C "$RESOURCES/firmware-template" --strip-components=1 -xf -

# The firmware builds with `-Z build-std`, so cargo resolves the toolchain's own
# library workspace on top of the firmware's dependency graph. Vendoring only the
# firmware misses that half of the graph and the offline build then dies on the
# first sysroot-only crate (e.g. proc_macro's rustc-literal-escaper). `--sync`
# pulls the library workspace into the same vendor directory.
RUST_LIBRARY_MANIFEST="$RUST_SYSROOT/lib/rustlib/src/rust/library/Cargo.toml"
require_file "$RUST_LIBRARY_MANIFEST"
(cd "$ROOT/$FIRMWARE_DIR" && cargo vendor --locked --sync "$RUST_LIBRARY_MANIFEST" "$RESOURCES/vendor" > "$RESOURCES/vendor-config.toml")

cp -a "$RUST_SYSROOT" "$RESOURCES/toolchains/$RUST_RESOURCE_DIR"
find "$SYSTEM_AVR_BIN_DIR" -maxdepth 1 -name 'avr-*' -exec cp -a {} "$RESOURCES/toolchains/avr/bin/" \;
cp -a "$SYSTEM_AVR_GCC_DIR" "$RESOURCES/toolchains/avr/lib/gcc/avr"
cp -a "$SYSTEM_AVR_LIB_DIR" "$RESOURCES/toolchains/avr/lib/avr"
install -m 0755 "$AVRDUDE_BIN" "$RESOURCES/toolchains/avrdude/bin/avrdude"
install -m 0644 "$AVRDUDE_CONF" "$RESOURCES/toolchains/avrdude/etc/avrdude.conf"
install -m 0755 "$RAVEDUDE_BIN" "$RESOURCES/bin/ravedude"

cat > "$RESOURCES/bin/avrdude" <<'WRAPPER'
#!/usr/bin/env sh
set -eu
SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SELF_DIR/.." && pwd)
exec "$ROOT/toolchains/avrdude/bin/avrdude" -C "$ROOT/toolchains/avrdude/etc/avrdude.conf" "$@"
WRAPPER
chmod 0755 "$RESOURCES/bin/avrdude"

cat > "$RESOURCES/licenses/README.md" <<'LICENSES'
CrabDuino bundles third-party runtime tools for offline operation.

Before publishing a release, replace this placeholder with complete license and
source-offer notices for the staged Rust toolchain, AVR GCC/binutils/avr-libc,
AVRDUDE, ravedude, and vendored Rust crates.
LICENSES

RUST_VERSION="$("$RESOURCES/toolchains/$RUST_RESOURCE_DIR/bin/rustc" --version)"
CARGO_VERSION="$("$RESOURCES/toolchains/$RUST_RESOURCE_DIR/bin/cargo" --version)"
AVR_GCC_VERSION="$("$RESOURCES/toolchains/avr/bin/avr-gcc" --version | sed -n '1p')"
RAVEDUDE_VERSION="$("$RESOURCES/bin/ravedude" --version 2>&1 | sed -n '1p')"
AVRDUDE_VERSION="$("$RESOURCES/bin/avrdude" -? 2>&1 | sed -n '1p')"
GENERATED_AT="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

cat > "$RESOURCES/manifest.json" <<MANIFEST
{
  "generatedAt": $(json_string "$GENERATED_AT"),
  "rustToolchain": $(json_string "$RUST_TOOLCHAIN"),
  "rustc": $(json_string "$RUST_VERSION"),
  "cargo": $(json_string "$CARGO_VERSION"),
  "avrGcc": $(json_string "$AVR_GCC_VERSION"),
  "ravedude": $(json_string "$RAVEDUDE_VERSION"),
  "avrdude": $(json_string "$AVRDUDE_VERSION"),
  "firmwareTemplate": "firmware-template",
  "vendor": "vendor"
}
MANIFEST

(cd "$RESOURCES" && find bin firmware-template licenses toolchains vendor -type f -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)

"$RESOURCES/toolchains/$RUST_RESOURCE_DIR/bin/cargo" --version >/dev/null
"$RESOURCES/toolchains/$RUST_RESOURCE_DIR/bin/rustc" --version >/dev/null
"$RESOURCES/toolchains/avr/bin/avr-gcc" --version >/dev/null
"$RESOURCES/bin/ravedude" --version >/dev/null
"$RESOURCES/bin/avrdude" -? >/dev/null 2>&1

# Offline smoke build: compile the staged template with the staged toolchain and
# vendor directory, using only what a freshly installed .deb would have. This is
# what catches an incomplete vendor directory here rather than on a user's
# machine after Verify fails. The build runs on a throwaway copy so the staged
# template (and the SHA256SUMS written above) stay untouched.
SMOKE_DIR="$(mktemp -d)"
trap 'rm -rf "$SMOKE_DIR"' EXIT
cp -a "$RESOURCES/firmware-template" "$SMOKE_DIR/project"
mkdir -p "$SMOKE_DIR/cargo-home"
cat > "$SMOKE_DIR/cargo-home/config.toml" <<SMOKECONFIG
$(sed "s#^directory = .*#directory = \"$RESOURCES/vendor\"#" "$RESOURCES/vendor-config.toml")

[net]
offline = true
SMOKECONFIG

echo "Running offline smoke build of the staged template…"
# Run from inside the project: cargo reads `.cargo/config.toml` — which selects
# the AVR target and build-std — relative to the working directory, not the
# manifest path. Building from elsewhere silently targets the host instead.
if ! (cd "$SMOKE_DIR/project" && \
     CARGO_HOME="$SMOKE_DIR/cargo-home" \
     CARGO_NET_OFFLINE=true \
     RUSTC="$RESOURCES/toolchains/$RUST_RESOURCE_DIR/bin/rustc" \
     PATH="$RESOURCES/bin:$RESOURCES/toolchains/avr/bin:$PATH" \
     "$RESOURCES/toolchains/$RUST_RESOURCE_DIR/bin/cargo" build \
       --release --bin blink); then
  echo "offline smoke build failed: the staged resources cannot build a sketch" >&2
  echo "a missing crate here usually means the vendor directory is incomplete" >&2
  exit 1
fi
rm -rf "$SMOKE_DIR"
trap - EXIT

if [[ "$STAGE_ONLY" == "1" ]]; then
  echo "Staged package resources in $RESOURCES"
  exit 0
fi

(cd "$ROOT/ide" && cargo tauri build --bundles deb)
