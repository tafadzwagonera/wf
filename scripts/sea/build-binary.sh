#!/bin/sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

BINARY="dist-bundle/wf"
SENTINEL_FUSE="NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"

node --experimental-sea-config scripts/sea/sea-config.json
cp "$(node -p 'process.execPath')" "$BINARY"

if [ "$(uname -s)" = "Darwin" ]; then
  codesign --remove-signature "$BINARY"
  yarn postject "$BINARY" NODE_SEA_BLOB dist-bundle/wf.blob --sentinel-fuse "$SENTINEL_FUSE" --macho-segment-name NODE_SEA
  codesign --sign - "$BINARY"
else
  yarn postject "$BINARY" NODE_SEA_BLOB dist-bundle/wf.blob --sentinel-fuse "$SENTINEL_FUSE"
fi

chmod +x "$BINARY"
echo "Built $BINARY"
