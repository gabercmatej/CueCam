import PerceptionWorker from './perception.worker?worker'
import type { Delegate, FrameTasks, FromWorker, ToWorker, WorkerModels } from './perceptionProtocol'
import type { Task } from './taskScheduler'
import { assetUrl } from '../urls'

// assets/ is served at the renderer root (the web demo sets its own base, see urls.ts).
const asset = (path: string): string => assetUrl(`mediapipe/${path}`)
const WASM_BASE = asset('wasm')
export const MODELS = {
  hands: asset('gesture_recognizer.task'),
  segment: asset('selfie_segmenter_landscape.tflite'),
  face: asset('blaze_face_short_range.tflite')
}

export type PerceptionMessage = Exclude<FromWorker, { type: 'ready' }>

/**
 * Renderer side of a perception worker. `send` grabs the current camera frame as a VideoFrame
 * (no pixel copy) and transfers it with the tasks to run; results arrive through `onMessage`.
 */
export class PerceptionClient {
  private constructor(
    private readonly worker: Worker,
    readonly tasks: readonly Task[],
    readonly delegates: Partial<Record<Task, Delegate>>
  ) {}

  static start(models: WorkerModels, onMessage: (msg: PerceptionMessage) => void): Promise<PerceptionClient> {
    const worker = new PerceptionWorker()
    return new Promise((resolve, reject) => {
      worker.onerror = (e) => reject(new Error(`perception worker failed: ${e.message}`))
      worker.onmessage = (e: MessageEvent<FromWorker>) => {
        const msg = e.data
        if (msg.type === 'ready') {
          const what = msg.tasks.map((t) => `${t} ${msg.delegates[t]}`).join(', ')
          console.log(`[perception] worker ready: ${what} (${Math.round(msg.initMs)} ms)`)
          resolve(new PerceptionClient(worker, msg.tasks, msg.delegates))
          worker.onerror = (err) => onMessage({ type: 'error', message: err.message, fatal: true })
        } else if (msg.type === 'error' && msg.fatal && msg.at === undefined) {
          worker.terminate()
          reject(new Error(msg.message))
        } else {
          onMessage(msg)
        }
      }
      const init: ToWorker = { type: 'init', wasmBase: WASM_BASE, models }
      worker.postMessage(init)
    })
  }

  /** Transfers the video's current frame to the worker. Returns false if no frame could be grabbed. */
  send(video: HTMLVideoElement, at: number, tasks: FrameTasks): boolean {
    let frame: VideoFrame
    try {
      frame = new VideoFrame(video, { timestamp: Math.round(at * 1000) })
    } catch {
      return false
    }
    const msg: ToWorker = { type: 'frame', frame, at, tasks }
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
