/** Messages between the renderer and the tracker worker. */
import type { BuiltinLabel } from './gestures'
import type { Landmark } from './handGeometry'

export type Delegate = 'GPU' | 'CPU'

export type ToTracker =
  | { type: 'init'; wasmBase: string; model: string; delegate: Delegate }
  /** Ownership of `frame` moves to the worker, which closes it. */
  | { type: 'frame'; frame: VideoFrame; at: number }

export interface TrackedHandResult {
  landmarks: Landmark[]
  /** MediaPipe's raw handedness label (assumes a mirrored input; corrected by the renderer). */
  handedness: string
  builtin: BuiltinLabel | null
}

export type FromTracker =
  | { type: 'ready'; delegate: Delegate; initMs: number }
  | { type: 'result'; at: number; ms: number; hands: TrackedHandResult[] }
  /** A frame that failed; `at` is set when it answers a frame (the renderer stops waiting). */
  | { type: 'error'; message: string; at?: number; fatal: boolean }
