#!/usr/bin/env bash
# Downloads model files into assets/ so the app runs fully offline.
# Idempotent: skips files that already exist.
set -euo pipefail
cd "$(dirname "$0")/.."

MP=assets/mediapipe
VOSK=assets/vosk
mkdir -p "$MP/wasm" "$VOSK"

fetch() { # url dest
  if [ -s "$2" ]; then echo "ok   $2"; else echo "get  $2"; curl -fL --retry 3 -o "$2.part" "$1" && mv "$2.part" "$2"; fi
}

fetch https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task \
  "$MP/gesture_recognizer.task"
fetch https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite \
  "$MP/blaze_face_short_range.tflite"
# Landscape selfie model: 256×144 input, matches the 16:9 camera (the square one wastes half its input on padding).
fetch https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/latest/selfie_segmenter_landscape.tflite \
  "$MP/selfie_segmenter_landscape.tflite"

# MediaPipe WASM runtime ships inside the npm package; copy it next to the models.
cp -R node_modules/@mediapipe/tasks-vision/wasm/. "$MP/wasm/"
echo "ok   $MP/wasm (copied from node_modules)"

# vosk-browser expects a .tar.gz with the model in a single top-level folder.
fetch https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz \
  "$VOSK/vosk-model-small-en-us-0.15.tar.gz"
