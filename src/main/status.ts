/** What main knows that the renderer can't: model files on disk, macOS permissions, the global hotkey. */
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Files the app can't run fully without, relative to assets/ (`npm run fetch-assets` puts them there). */
export const REQUIRED_ASSETS: readonly { file: string; for: 'tracking' | 'speech' }[] = [
  { file: 'mediapipe/gesture_recognizer.task', for: 'tracking' },
  { file: 'mediapipe/selfie_segmenter_landscape.tflite', for: 'tracking' },
  { file: 'mediapipe/blaze_face_short_range.tflite', for: 'tracking' },
  { file: 'mediapipe/wasm/vision_wasm_module_internal.js', for: 'tracking' },
  { file: 'mediapipe/wasm/vision_wasm_module_internal.wasm', for: 'tracking' },
  { file: 'vosk/vosk-model-small-en-us-0.15.tar.gz', for: 'speech' }
]

/** Required asset files that are missing or empty, as paths relative to assets/. */
export function missingAssets(assetsDir: string): string[] {
  return REQUIRED_ASSETS.filter(({ file }) => {
    const path = join(assetsDir, file)
    try {
      return !existsSync(path) || statSync(path).size === 0
    } catch {
      return true
    }
  }).map((a) => a.file)
}
