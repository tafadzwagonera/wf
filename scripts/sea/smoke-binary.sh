#!/bin/sh
set -eu

BINARY="${1:?usage: smoke-binary.sh <path-to-wf-binary>}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
BINARY="$(cd "$(dirname "$BINARY")" && pwd)/$(basename "$BINARY")"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
cd "$WORK_DIR"

run_clean() {
  env -i PATH=/usr/bin:/bin HOME="$WORK_DIR" "$BINARY" "$@"
}

run_clean --help > help.out
diff -u "$ROOT_DIR/scripts/sea/golden/help.txt" help.out
echo "ok: --help matches golden output"

EXPECTED_VERSION="$(node -p "require('$ROOT_DIR/package.json').version")"
run_clean issue:cowsay 2>/dev/null | grep -F "wf v$EXPECTED_VERSION is installed and working!" > /dev/null
echo "ok: issue:cowsay reports v$EXPECTED_VERSION"

file "$BINARY"
if [ "$(uname -s)" = "Darwin" ]; then
  codesign -v "$BINARY"
  echo "ok: codesign verified"
fi
