// Hand tracking off the render thread. Receives transferred VideoFrames, runs MediaPipe's
// GestureRecognizer, posts landmarks back. Every frame gets exactly one answer.
import { FilesetResolver, GestureRecognizer } from '@mediapipe/tasks-vision'
import type { Delegate, FromTracker, ToTracker, TrackedHandResult } from './trackerProtocol'

interface WorkerScope {
  postMessage(message: FromTracker): void
  onmessage: ((e: MessageEvent<ToTracker>) => void) | null
}
const scope = self as unknown as WorkerScope

let recognizer: GestureRecognizer | null = null
let lastAt = -Infinity

scope.onmessage = (e) => {
  const msg = e.data
  if (msg.type === 'init') void init(msg)
  else track(msg.frame, msg.at)
}

async function init(msg: Extract<ToTracker, { type: 'init' }>): Promise<void> {
  const t0 = performance.now()
  try {
    // useModule: the ES-module wasm loader, since this is a module worker.
    const fileset = await FilesetResolver.forVisionTasks(msg.wasmBase, true)
    const create = (delegate: Delegate) =>
      GestureRecognizer.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: msg.model, delegate },
        runningMode: 'VIDEO',
        numHands: 2
      })
    let delegate = msg.delegate
    try {
      recognizer = await create(delegate)
    } catch (err) {
      if (delegate === 'CPU') throw err
      console.warn(`[tracker] GPU delegate failed, falling back to CPU: ${String(err)}`)
      delegate = 'CPU'
      recognizer = await create(delegate)
    }
    scope.postMessage({ type: 'ready', delegate, initMs: performance.now() - t0 })
  } catch (err) {
    scope.postMessage({ type: 'error', message: `init failed: ${String(err)}`, fatal: true })
  }
}

function track(frame: VideoFrame, at: number): void {
  try {
    // VIDEO mode needs strictly increasing timestamps.
    if (!recognizer || at <= lastAt) {
      scope.postMessage({ type: 'result', at, ms: 0, hands: [] })
      return
    }
    lastAt = at
    const t0 = performance.now()
    const result = recognizer.recognizeForVideo(frame, at)
    const ms = performance.now() - t0
    const hands: TrackedHandResult[] = result.landmarks.map((landmarks, i) => {
      const top = result.gestures[i]?.[0]
      return {
        landmarks: landmarks.map(({ x, y, z }) => ({ x, y, z })),
        handedness: result.handedness[i]?.[0]?.categoryName ?? 'Right',
        builtin: top ? { name: top.categoryName, score: top.score } : null
      }
    })
    scope.postMessage({ type: 'result', at, ms, hands })
  } catch (err) {
    scope.postMessage({ type: 'error', message: String(err), at, fatal: false })
  } finally {
    frame.close()
  }
}
