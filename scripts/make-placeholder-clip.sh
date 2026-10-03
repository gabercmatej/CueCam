#!/usr/bin/env bash
# Renders a procedural fireball as effects/clips/explosion.webm (VP9 + alpha), a stand-in
# until a real clip is dropped in. Needs ffmpeg with libvpx-vp9.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=${1:-effects/clips/explosion.webm}

A="atan2(Y-256\,X-256)"
DIST="hypot(X-256\,Y-256)/256"
RAD="(0.1+0.72*(1-exp(-5*T)))"
EDGE="($RAD*(1+0.13*sin(9*$A+11*T)+0.07*sin(23*$A-7*T)+0.04*sin(41*$A+5*T)))"
IN="clip(($EDGE-$DIST)/0.10\,0\,1)"
HEAT="clip(1-$DIST/$EDGE\,0\,1)"
COOL="clip(T/1.1\,0\,1)"
FADE="clip(1-(T-0.55)/1.0\,0\,1)"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "color=c=black:s=512x512:r=30:d=1.6,format=rgba,geq=\
r='255*$IN*clip(1.0-0.25*$COOL+0.2*$HEAT\,0\,1)':\
g='255*$IN*clip((0.25+0.9*$HEAT*$HEAT)*(1-0.6*$COOL)\,0\,1)':\
b='255*$IN*clip(0.7*pow($HEAT\,3)*(1-$COOL)\,0\,1)':\
a='255*$IN*$FADE*clip(0.55+0.7*$HEAT\,0\,1)'" \
  -c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 -b:v 1.2M "$OUT"
echo "wrote $OUT"
