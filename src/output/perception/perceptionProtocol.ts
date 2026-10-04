/** Messages between the renderer and a perception worker. */
import type { FaceBox } from './faceSmoother'
import type { BuiltinLabel } from './gestures'
import type { Landmark } from './handGeometry'
import type { Task } from './taskScheduler'

export type Delegate = 'GPU' | 'CPU'

export interface WorkerModels {
  hands?: { model: string; delegate: Delegate }
  segment?: { model: string; delegate: Delegate }
  face?: { model: string; delegate: Delegate }
}

/** Which tasks run on a frame. `segment` carries the mask size (smaller under load). */
export interface FrameTasks {
  hands: boolean
  segment: { width: number; height: number } | null
  face: boolean
}

export type ToWorker =
  | { type: 'init'; wasmBase: string; models: WorkerModels }
  /** Ownership of `frame` moves to the worker, which closes it. */
  | { type: 'frame'; frame: VideoFrame; at: number; tasks: FrameTasks }

export interface TrackedHandResult {
  landmarks: Landmark[]
  /** MediaPipe's raw handedness label (assumes a mirrored input; corrected by the renderer). */
  handedness: string
  builtin: BuiltinLabel | null
}

export interface SegmentMask {
  width: number
  height: number
  /** Person confidence 0–255 per pixel, row-major, raw camera orientation; temporally smoothed. */
  data: Uint8Array
}

/** Worker time per stage for one frame, ms. A task's field is set when it ran. */
export interface WorkerTimings {
  /** Downscaled copies of the frame for the tasks that ran. */
  prep: number
  hands?: number
  segment?: number
  face?: number
  /** Whole frame, receive → post. */
  total: number
}

export interface FrameResult {
  type: 'result'
  at: number
  ms: WorkerTimings
  mask?: SegmentMask
  /** Set when face detection ran: the most prominent face, or null. Normalized raw camera coordinates. */
  face?: FaceBox | null
}

/**
 * Hand results are posted the moment tracking finishes, before segmentation and face detection
 * run on the same frame, so the extra tasks add no latency to gestures. The frame's `result`
 * follows and ends it.
 */
export interface HandsResult {
  type: 'hands'
  at: number
  ms: number
  hands: TrackedHandResult[]
}

export type FromWorker =
  | { type: 'ready'; tasks: Task[]; delegates: Partial<Record<Task, Delegate>>; initMs: number }
  | HandsResult
  | FrameResult
  /** A frame that failed; `at` is set when it answers a frame (the renderer stops waiting). */
  | { type: 'error'; message: string; at?: number; fatal: boolean }
