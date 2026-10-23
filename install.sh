#!/bin/sh
set -eu

REPO="tafadzwagonera/wf"
INSTALL_DIR="${WF_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${WF_VERSION:-}"
LOCAL_DIR="${WF_LOCAL_ARTIFACT_DIR:-}"

fail() {
  echo "wf install: $1" >&2
  exit 1
}

detect_os() {
  case "$(uname -s)" in
    Darwin) echo darwin ;;
    Linux) echo linux ;;
    *) fail "unsupported operating system: $(uname -s). Supported: macOS, Linux." ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    arm64 | aarch64) echo arm64 ;;
    x86_64 | amd64) echo x64 ;;
    *) fail "unsupported architecture: $(uname -m). Supported: arm64, x64." ;;
  esac
}

resolve_latest_version() {
  url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")" ||
    fail "could not resolve the latest release of $REPO"
  echo "${url##*/}"
}

sha256_of() {
  if command -v sha256sum > /dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

fetch() {
  asset="$1"
  destination="$2"
  if [ -n "$LOCAL_DIR" ]; then
    cp "$LOCAL_DIR/$asset" "$destination" || fail "missing local artifact: $LOCAL_DIR/$asset"
    return
  fi
  curl -fsSL "https://github.com/$REPO/releases/download/$VERSION/$asset" -o "$destination" ||
    fail "download failed: $asset ($VERSION)"
}

OS="$(detect_os)"
ARCH="$(detect_arch)"

if [ -z "$VERSION" ]; then
  [ -z "$LOCAL_DIR" ] || fail "WF_VERSION is required with WF_LOCAL_ARTIFACT_DIR"
  VERSION="$(resolve_latest_version)"
fi

TARBALL="wf-$VERSION-$OS-$ARCH.tar.gz"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "wf install: $VERSION for $OS-$ARCH"
fetch "$TARBALL" "$WORK_DIR/$TARBALL"
fetch "SHA256SUMS" "$WORK_DIR/SHA256SUMS"

EXPECTED="$(grep " $TARBALL\$" "$WORK_DIR/SHA256SUMS" | cut -d ' ' -f 1)"
[ -n "$EXPECTED" ] || fail "no checksum listed for $TARBALL"
ACTUAL="$(sha256_of "$WORK_DIR/$TARBALL")"
[ "$EXPECTED" = "$ACTUAL" ] || fail "checksum mismatch for $TARBALL (expected $EXPECTED, got $ACTUAL)"

tar -xzf "$WORK_DIR/$TARBALL" -C "$WORK_DIR"
mkdir -p "$INSTALL_DIR"
cp "$WORK_DIR/wf" "$INSTALL_DIR/wf.tmp"
chmod 755 "$INSTALL_DIR/wf.tmp"
mv -f "$INSTALL_DIR/wf.tmp" "$INSTALL_DIR/wf"
echo "wf install: installed $INSTALL_DIR/wf"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "wf install: add $INSTALL_DIR to PATH, for example: export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
esac
