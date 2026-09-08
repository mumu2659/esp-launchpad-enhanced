#!/bin/sh
# Works with macOS /bin/sh and Linux; no existing Python or Node required.
set -eu
helper_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
case "$(uname -s)" in
  Darwin) system=apple-darwin; cache_base="$HOME/Library/Caches" ;;
  Linux) system=unknown-linux-gnu; cache_base="${XDG_CACHE_HOME:-$HOME/.cache}" ;;
  *) fail 'Unsupported OS. On Windows double-click start-windows.cmd.' ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=aarch64 ;;
  x86_64|amd64) arch=x86_64 ;;
  *) fail 'Only x64 and ARM64 are supported.' ;;
esac
# Detect Apple Silicon even when started under Rosetta.
if [ "$system" = apple-darwin ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then arch=aarch64; fi
target="$arch-$system"
cache="${LAUNCHPAD_HELPER_CACHE:-$cache_base/esp-launchpad-enhanced}"
mkdir -p "$cache"
export UV_CACHE_DIR="$cache/uv-cache" UV_PYTHON_INSTALL_DIR="$cache/python"
export UV_PYTHON_INSTALL_BIN=0 UV_NO_CONFIG=1
export PYTHONUTF8=1 PYTHONNOUSERSITE=1
unset PYTHONHOME PYTHONPATH UV_PYTHON_PREFERENCE || true
version=0.12.10
checksum=$(awk -F '\t' -v t="$target" '$1==t {print $3}' "$helper_dir/uv-assets.tsv")
[ -n "$checksum" ] || fail "No verified download for $target"
archive="$cache/uv-$version-$target.tar.gz"
check_archive() {
  [ -f "$archive" ] || return 1
  if command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$archive" | awk '{print $1}');
  elif command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$archive" | awk '{print $1}');
  else fail 'SHA256 utility not found.'; fi
  [ "$actual" = "$checksum" ]
}
if ! check_archive; then
  echo "Preparing USB helper for $target (first launch requires internet)..."
  part=$(mktemp "$cache/download.XXXXXX")
  trap 'rm -f "$part"' EXIT HUP INT TERM
  curl --proto '=https' --tlsv1.2 --fail --location --retry 2 --connect-timeout 20 --max-time 300 \
    "https://github.com/astral-sh/uv/releases/download/$version/uv-$target.tar.gz" -o "$part"
  mv "$part" "$archive"
  check_archive || fail 'Download SHA256 mismatch. Please retry with a clean download.'
  trap - EXIT HUP INT TERM
fi
uv_dir="$cache/uv-$version-$target"
if [ ! -x "$uv_dir/uv" ]; then
  stage=$(mktemp -d "$cache/unpack.XXXXXX")
  tar -xzf "$archive" -C "$stage" --strip-components=1
  mkdir -p "$uv_dir"
  mv "$stage/uv" "$uv_dir/uv"
  rm -rf "$stage"
fi
export LAUNCHPAD_HELPER_CACHE="$cache" LAUNCHPAD_UV="$uv_dir/uv"
"$LAUNCHPAD_UV" run --no-project --no-config --managed-python --python 3.12.12 "$helper_dir/bootstrap_env.py" "$@"
