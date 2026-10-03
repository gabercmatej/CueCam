import TrackerWorker from './tracker.worker?worker'
import type { Delegate, FromTracker, ToTracker } from './trackerProtocol'

// Paths are relative to the output page; assets/ is served at the renderer root.
const WASM_BASE = new URL('../mediapipe/wasm', document.baseURI).href
const MODEL = new URL('../mediapipe/gesture_recognizer.task', document.baseURI).href

export type TrackerMessage = Exclude<FromTracker, { type: 'ready' }>

/**
 * Renderer side of the tracker worker. `send` grabs the current camera frame as a
 * VideoFrame (no pixel copy) and transfers it; results arrive through `onMessage`.
 */
export class HandTracker {
  private constructor(
    private readonly worker: Worker,
    readonly delegate: Delegate
  ) {}

  static start(onMessage: (msg: TrackerMessage) => void, delegate: Delegate = 'GPU'): Promise<HandTracker> {
    const worker = new TrackerWorker()
    return new Promise((resolve, reject) => {
      worker.onerror = (e) => reject(new Error(`tracker worker failed: ${e.message}`))
      worker.onmessage = (e: MessageEvent<FromTracker>) => {
        const msg = e.data
        if (msg.type === 'ready') {
          console.log(`[hands] tracker worker ready (${msg.delegate}, ${Math.round(msg.initMs)} ms)`)
          resolve(new HandTracker(worker, msg.delegate))
          worker.onerror = (err) => onMessage({ type: 'error', message: err.message, fatal: true })
        } else if (msg.type === 'error' && msg.fatal && msg.at === undefined) {
          worker.terminate()
          reject(new Error(msg.message))
        } else {
          onMessage(msg)
        }
      }
      const init: ToTracker = { type: 'init', wasmBase: WASM_BASE, model: MODEL, delegate }
      worker.postMessage(init)
    })
  }

  /** Transfers the video's current frame to the worker. Returns false if no frame could be grabbed. */
  send(video: HTMLVideoElement, at: number): boolean {
    let frame: VideoFrame
    try {
      frame = new VideoFrame(video, { timestamp: Math.round(at * 1000) })
    } catch {
      return false
    }
    const msg: ToTracker = { type: 'frame', frame, at }
    try {
      this.worker.postMessage(msg, [frame])
    } catch {
      // Not transferred: the frame is still ours and holds a camera buffer until closed.
      frame.close()
      return false
    }
    return true
  }
}
