// Perception off the render thread. Receives transferred VideoFrames with a list of tasks to run
// (hand tracking, person segmentation, face detection), runs them in order and posts one answer
// per frame. Each task gets a downscaled copy sized for its model, so a 1080p camera costs
// perception no more than 720p did.
import { FaceDetector, FilesetResolver, GestureRecognizer, ImageSegmenter } from '@mediapipe/tasks-vision'
import type { FaceBox } from './faceSmoother'
import { MaskSmoother } from './maskSmoother'
import type { Delegate, FrameResult, FrameTasks, FromWorker, ToWorker, TrackedHandResult, WorkerModels } from './perceptionProtocol'
import type { Task } from './taskScheduler'

interface WorkerScope {
  postMessage(message: FromWorker, transfer?: Transferable[]): void
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null
}
const scope = self as unknown as WorkerScope

/**
 * Input heights per task; widths follow the frame's aspect, so a 4:3 camera isn't squashed. Hands
 * keep 720p detail (what Phase 2 tracked at; small far-away hands still have enough pixels for
 * the landmark crop), and a frame at or below that goes in as is. The face detector's model input
 * is 128×128. Segmentation is sized by the renderer (its mask maps onto the camera quad by UV, so
 * any aspect lines up).
 */
const HANDS_HEIGHT = 720
const FACE_HEIGHT = 180

let recognizer: GestureRecognizer | null = null
let segmenter: ImageSegmenter | null = null
let detector: FaceDetector | null = null
const lastAt: Record<Task, number> = { hands: -Infinity, segment: -Infinity, face: -Infinity }
// Resets only after a real gap: at the slowest level (every 6th frame) a 15 fps camera gives masks 400 ms apart.
const maskSmoother = new MaskSmoother(0.6, 1000)

scope.onmessage = (e) => {
  const msg = e.data
  if (msg.type === 'init') void init(msg.wasmBase, msg.models)
  else void run(msg.frame, msg.at, msg.tasks)
}

/** Creates a task on the GPU, falling back to the CPU if the GPU delegate fails. */
async function withFallback<T>(name: string, preferred: Delegate, create: (d: Delegate) => Promise<T>): Promise<[T, Delegate]> {
  try {
    return [await create(preferred), preferred]
  } catch (err) {
    if (preferred === 'CPU') throw err
    console.warn(`[perception] ${name}: GPU delegate failed, falling back to CPU: ${String(err)}`)
    return [await create('CPU'), 'CPU']
  }
}

async function init(wasmBase: string, models: WorkerModels): Promise<void> {
  const t0 = performance.now()
  try {
    // useModule: the ES-module wasm loader, since this is a module worker.
    const fileset = await FilesetResolver.forVisionTasks(wasmBase, true)
    // MediaPipe reads the wasm factory from globalThis.ModuleFactory, which the loader sets when it
    // is first evaluated, and clears it after creating a task. A module import is cached, so the
    // second task in this worker would find no factory. Import it once and hand it back each time.
    const loader = (await import(/* @vite-ignore */ fileset.wasmLoaderPath)) as { default: unknown }
    const withFactory = <T>(create: () => Promise<T>): Promise<T> => {
      ;(globalThis as { ModuleFactory?: unknown }).ModuleFactory = loader.default
      return create()
    }
    const delegates: Partial<Record<Task, Delegate>> = {}
    // Each task loads on its own: a missing or broken segmentation/face model must not take hand
    // tracking down with it (e.g. assets fetched before the model was added). Failures are reported, not fatal.
    const load = async (task: Task, create: () => Promise<Delegate>): Promise<void> => {
      try {
        delegates[task] = await create()
      } catch (err) {
        scope.postMessage({ type: 'error', message: `${task} unavailable: ${String(err)}`, fatal: false })
      }
    }
    if (models.hands) {
      const m = models.hands
      await load('hands', async () => {
        let d: Delegate
        ;[recognizer, d] = await withFallback('hands', m.delegate, (delegate) =>
          withFactory(() => GestureRecognizer.createFromOptions(fileset, { baseOptions: { modelAssetPath: m.model, delegate }, runningMode: 'VIDEO', numHands: 2 }))
        )
        return d
      })
    }
    if (models.segment) {
      const m = models.segment
      await load('segment', async () => {
        let d: Delegate
        ;[segmenter, d] = await withFallback('segment', m.delegate, (delegate) =>
          withFactory(() =>
            ImageSegmenter.createFromOptions(fileset, {
              baseOptions: { modelAssetPath: m.model, delegate },
              runningMode: 'VIDEO',
              outputConfidenceMasks: true,
              outputCategoryMask: false
            })
          )
        )
        return d
      })
    }
    if (models.face) {
      const m = models.face
      await load('face', async () => {
        let d: Delegate
        ;[detector, d] = await withFallback('face', m.delegate, (delegate) =>
          withFactory(() =>
            FaceDetector.createFromOptions(fileset, { baseOptions: { modelAssetPath: m.model, delegate }, runningMode: 'VIDEO', minDetectionConfidence: 0.5 })
          )
        )
        return d
      })
    }
    const tasks = (Object.keys(delegates) as Task[]).filter((t) => delegates[t])
    if (tasks.length === 0) throw new Error('no perception task could be loaded')
    scope.postMessage({ type: 'ready', tasks, delegates, initMs: performance.now() - t0 })
  } catch (err) {
    scope.postMessage({ type: 'error', message: `init failed: ${String(err)}`, fatal: true })
  }
}

/** A downscaled copy of the frame (GPU-side resize where the platform supports it). */
function scaled(frame: VideoFrame, size: { width: number; height: number }): Promise<ImageBitmap> {
  return createImageBitmap(frame, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'low' })
}

/** The frame's size scaled to `height`, keeping its aspect (even width). */
function atHeight(frame: VideoFrame, height: number): { width: number; height: number } {
  return { width: Math.round((frame.displayWidth * height) / frame.displayHeight / 2) * 2, height }
}

/** VIDEO mode needs strictly increasing timestamps per task. */
function fresh(task: Task, at: number): boolean {
  if (at <= lastAt[task]) return false
  lastAt[task] = at
  return true
}

async function run(frame: VideoFrame, at: number, tasks: FrameTasks): Promise<void> {
  const t0 = performance.now()
  const result: FrameResult = { type: 'result', at, ms: { prep: 0, total: 0 } }
  const transfer: Transferable[] = []
  const bitmaps: ImageBitmap[] = []
  try {
    const wantHands = tasks.hands && recognizer && fresh('hands', at)
    const wantSegment = tasks.segment && segmenter && fresh('segment', at)
    const wantFace = tasks.face && detector && fresh('face', at)
    // All copies are made up front, in parallel (≈0.5 ms together), before any model runs. Each is
    // tracked as soon as it exists, so one failing copy can't leak the others.
    const copy = (size: { width: number; height: number }): Promise<ImageBitmap> =>
      scaled(frame, size).then((b) => (bitmaps.push(b), b))
    const faceSize = atHeight(frame, FACE_HEIGHT)
    const [handsInput, segInput, faceInput] = await Promise.all([
      wantHands && frame.displayHeight > HANDS_HEIGHT ? copy(atHeight(frame, HANDS_HEIGHT)) : null,
      wantSegment ? copy(tasks.segment!) : null,
      wantFace ? copy(faceSize) : null
    ])
    let t = performance.now()
    result.ms.prep = t - t0

    if (wantHands) {
      const r = recognizer!.recognizeForVideo(handsInput ?? frame, at)
      const hands = r.landmarks.map((landmarks, i): TrackedHandResult => {
        const top = r.gestures[i]?.[0]
        return {
          landmarks: landmarks.map(({ x, y, z }) => ({ x, y, z })),
          handedness: r.handedness[i]?.[0]?.categoryName ?? 'Right',
          builtin: top ? { name: top.categoryName, score: top.score } : null
        }
      })
      const now = performance.now()
      result.ms.hands = now - t
      // Gestures first: post hands now, before the slower tasks below.
      scope.postMessage({ type: 'hands', at, ms: result.ms.hands, hands })
      t = now
    }

    if (wantSegment) {
      // Callback form: the mask is only valid inside it, and nothing is left to close afterwards.
      segmenter!.segmentForVideo(segInput!, at, (r) => {
        const mask = r.confidenceMasks?.[0]
        if (!mask) return
        const data = maskSmoother.push(mask.getAsFloat32Array(), mask.width, mask.height, at)
        result.mask = { width: mask.width, height: mask.height, data }
        transfer.push(data.buffer)
      })
      const now = performance.now()
      result.ms.segment = now - t
      t = now
    }

    if (wantFace) {
      const r = detector!.detectForVideo(faceInput!, at)
      let best: FaceBox | null = null
      let bestArea = 0
      for (const d of r.detections) {
        const b = d.boundingBox
        if (!b) continue
        const box = { x: b.originX / faceSize.width, y: b.originY / faceSize.height, width: b.width / faceSize.width, height: b.height / faceSize.height }
        // The most prominent face: the largest (closest to the camera).
        if (box.width * box.height > bestArea) {
          best = box
          bestArea = box.width * box.height
        }
      }
      result.face = best
      result.ms.face = performance.now() - t
    }

    result.ms.total = performance.now() - t0
    scope.postMessage(result, transfer)
  } catch (err) {
    scope.postMessage({ type: 'error', message: String(err), at, fatal: false })
  } finally {
    for (const b of bitmaps) b.close()
    frame.close()
  }
}
