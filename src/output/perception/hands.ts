import { FilesetResolver, GestureRecognizer, type GestureRecognizerResult } from '@mediapipe/tasks-vision'

// Paths are relative to the output page; assets/ is served at the renderer root.
const WASM_BASE = new URL('../mediapipe/wasm', document.baseURI).href
const MODEL = new URL('../mediapipe/gesture_recognizer.task', document.baseURI).href

export async function createHandTracker(): Promise<GestureRecognizer> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE)
  return GestureRecognizer.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numHands: 2
  })
}

export type HandResult = GestureRecognizerResult
