#!/usr/bin/env bash
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RESOURCES="$ROOT/ide/src-tauri/package-resources"

# Release constants. On the current build machine these defaults should be
# enough: install the developer prerequisites once, then run this script.
RUST_TOOLCHAIN="nightly-2025-04-27"
RUST_RESOURCE_DIR="rust-nightly-2025-04-27"
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
  --exclude='firmware/target' \
  --exclude='firmware/.git' \
  -cf - firmware |
  tar -C "$RESOURCES/firmware-template" --strip-components=1 -xf -

(cd "$ROOT/firmware" && cargo vendor --locked "$RESOURCES/vendor" > "$RESOURCES/vendor-config.toml")

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

if [[ "$STAGE_ONLY" == "1" ]]; then
  echo "Staged package resources in $RESOURCES"
  exit 0
fi

(cd "$ROOT/ide" && cargo tauri build --bundles deb)
