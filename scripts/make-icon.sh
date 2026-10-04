#!/usr/bin/env bash
# build/icon.svg → build/icon.png (1024) → build/icon.iconset (all macOS sizes) → build/icon.icns
set -euo pipefail
cd "$(dirname "$0")/.."
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/make-icon.mjs
rm -rf build/icon.iconset && mkdir build/icon.iconset
for size in 16 32 128 256 512; do
  sips -z $size $size build/icon.png --out build/icon.iconset/icon_${size}x${size}.png >/dev/null
  sips -z $((size * 2)) $((size * 2)) build/icon.png --out build/icon.iconset/icon_${size}x${size}@2x.png >/dev/null
done
iconutil -c icns build/icon.iconset -o build/icon.icns
echo "build/icon.icns"
