#!/usr/bin/env bash
# Renders each test text to a 16 kHz mono 16-bit WAV with macOS `say` (written to a file; nothing plays).
# Feed one into the running app (npm run dev -- --remoteDebuggingPort 9222):
#   node scripts/perf-probe.mjs feed <out>/by-small-talk.wav
set -euo pipefail
cd "$(dirname "$0")"
OUT="${1:-/tmp/skillcam-speech-test}"
mkdir -p "$OUT"
for txt in *.txt; do
  say -v Samantha -r 175 -f "$txt" -o "$OUT/${txt%.txt}.wav" --file-format=WAVE --data-format=LEI16@16000
  echo "wrote $OUT/${txt%.txt}.wav"
done
