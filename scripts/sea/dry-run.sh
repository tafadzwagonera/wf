#!/bin/sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

VERSION=v0.0.0-dispatch

detect_os() {
  case "$(uname -s)" in
    Darwin) echo darwin ;;
    Linux) echo linux ;;
    *) echo "dry-run: unsupported operating system: $(uname -s)" >&2; exit 1 ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    arm64 | aarch64) echo arm64 ;;
    x86_64 | amd64) echo x64 ;;
    *) echo "dry-run: unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac
}

TARGET="$(detect_os)-$(detect_arch)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "== build job (target: $TARGET) =="
yarn test:ci
yarn typecheck
yarn lint
yarn build:sea
yarn smoke:binary

echo "== pack artifact =="
mkdir -p "$WORK/artifact"
tar -czf "$WORK/artifact/wf-$VERSION-$TARGET.tar.gz" -C dist-bundle wf
cp install.sh "$WORK/artifact/install.sh"
(cd "$WORK/artifact" && shasum -a 256 "wf-$VERSION-$TARGET.tar.gz" > SHA256SUMS)

echo "== verify-install job =="
export WF_VERSION="$VERSION" WF_LOCAL_ARTIFACT_DIR="$WORK/artifact" WF_INSTALL_DIR="$WORK/wf-bin"
sh "$WORK/artifact/install.sh"
"$WORK/wf-bin/wf" --help > /dev/null
"$WORK/wf-bin/wf" issue:cowsay | grep -F "is installed and working!"
sh "$WORK/artifact/install.sh"
"$WORK/wf-bin/wf" --help > /dev/null
echo "ok: installer is idempotent"

mkdir -p "$WORK/bad"
cp "$WORK/artifact"/* "$WORK/bad/"
echo "0000  wf-$VERSION-$TARGET.tar.gz" > "$WORK/bad/SHA256SUMS"
if WF_LOCAL_ARTIFACT_DIR="$WORK/bad" WF_INSTALL_DIR="$WORK/wf-bad" sh "$WORK/artifact/install.sh"; then
  echo "dry-run: installer accepted a bad checksum" >&2
  exit 1
fi
test ! -e "$WORK/wf-bad/wf"
echo "ok: checksum mismatch aborts"

mkdir -p "$WORK/fakebin"
printf '#!/bin/sh\nif [ "$1" = "-m" ]; then echo riscv64; else /usr/bin/uname "$@"; fi\n' > "$WORK/fakebin/uname"
chmod +x "$WORK/fakebin/uname"
if PATH="$WORK/fakebin:$PATH" WF_VERSION="$VERSION" WF_INSTALL_DIR="$WORK/wf-badarch" sh "$WORK/artifact/install.sh" 2> "$WORK/err.txt"; then
  echo "dry-run: installer accepted an unsupported architecture" >&2
  exit 1
fi
grep -F "unsupported architecture" "$WORK/err.txt" > /dev/null
echo "ok: unsupported architecture gives a clear error"

echo "== dry run passed for $TARGET =="
echo "Not covered: the other three OS/arch targets, and the bare ubuntu:22.04 container check (CI only)."
