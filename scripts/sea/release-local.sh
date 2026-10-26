#!/bin/sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
INSTALL_DIR="${WF_INSTALL_DIR:-$HOME/.local/bin}"
cd "$ROOT_DIR"

yarn build:sea

mkdir -p "$INSTALL_DIR"
cp dist-bundle/wf "$INSTALL_DIR/wf"
"$INSTALL_DIR/wf" issue:cowsay

case ":$PATH:" in
  *":$INSTALL_DIR:"*)
    echo "Run 'hash -r' in your current shell so it picks up the new wf binary."
    ;;
  *)
    echo "Note: $INSTALL_DIR is not on your PATH."
    ;;
esac
