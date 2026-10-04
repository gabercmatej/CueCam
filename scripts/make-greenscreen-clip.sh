#!/usr/bin/env bash
# Renders a green-screen test clip: the placeholder fireball composited onto pure green (#00ff00)
# as H.264 MP4, like a stock green-screen effect. Its soft edges blend into the green, so it also
# exercises spill suppression. Needs ffmpeg with libvpx-vp9 and libx264.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=effects/clips/explosion.webm
OUT=${1:-effects/clips/explosion_greenscreen.mp4}
[ -s "$SRC" ] || bash scripts/make-placeholder-clip.sh "$SRC"

ffmpeg -hide_banner -loglevel error -y \
  -c:v libvpx-vp9 -i "$SRC" \
  -f lavfi -i "color=c=0x00ff00:s=512x512:r=30:d=1.6" \
  -filter_complex "[1:v][0:v]overlay=format=auto,format=yuv420p" \
  -c:v libx264 -crf 16 -movflags +faststart "$OUT"
echo "wrote $OUT"
