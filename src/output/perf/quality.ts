/**
 * Adaptive quality: watches render interval, main-thread work per frame and perception-worker
 * load, and trades perception rates, mask size, particle counts and render rate for a steady
 * output. Stress is judged per 500 ms window; two stressed windows in a row step down one
 * level (≈1 s), six calm ones step back up (≈3 s, longer after a relapse). Main-thread work is
 * the early signal: it rises before frames are actually dropped. Segmentation gives way first
 * (L2), before the render rate is capped (L3).
 */
import type { Task } from '../perception/taskScheduler'

export interface QualityLevel {
  /** Track hands every Nth camera frame. */
  trackEvery: number
  /** Segment every Nth camera frame (at least the configured `segmentEvery`). */
  segmentEvery: number
  /** Segmentation mask size (the segmenter's input; its cost is mostly fixed, the mask upload isn't). */
  mask: { width: number; height: number }
  /** Detect faces every Nth camera frame (3 = 10 fps at 30 fps). */
  faceEvery: number
  /** Multiplier on particle counts and the live-particle cap. */
  particleScale: number
  /** Render rate cap. 30 still matches the camera (and what OBS sends the call). */
  maxRenderFps: number
}

const MASK_FULL = { width: 256, height: 144 }
export const QUALITY_LEVELS: readonly QualityLevel[] = [
  { trackEvery: 1, segmentEvery: 1, mask: MASK_FULL, faceEvery: 3, particleScale: 1, maxRenderFps: 60 },
  { trackEvery: 2, segmentEvery: 2, mask: MASK_FULL, faceEvery: 3, particleScale: 1, maxRenderFps: 60 },
  { trackEvery: 2, segmentEvery: 3, mask: MASK_FULL, faceEvery: 3, particleScale: 0.6, maxRenderFps: 60 },
  { trackEvery: 3, segmentEvery: 4, mask: { width: 192, height: 108 }, faceEvery: 4, particleScale: 0.4, maxRenderFps: 30 },
  { trackEvery: 4, segmentEvery: 6, mask: { width: 160, height: 90 }, faceEvery: 6, particleScale: 0.25, maxRenderFps: 30 }
]

export interface QualityConfig {
  /** Configured tracking stride: the best level allowed. */
  trackEvery: number
  adaptive: boolean
  segmentation?: boolean
  /** Configured segmentation stride: never run more often than this. */
  segmentEvery?: number
  faceDetection?: boolean
  /** 1 = all tasks share a worker; 2 = hands alone, segmentation + face in a second worker. */
  perceptionWorkers?: 1 | 2
}

/** Mean worker ms per run of each task, plus the frame copies per worker run. */
export type TaskLoad = Record<Task | 'prep', number>

/** Camera-frame strides per task for a level (0 = task off). */
export function strides(level: QualityLevel, config: QualityConfig): Record<Task, number> {
  return {
    hands: level.trackEvery,
    segment: config.segmentation ? Math.max(level.segmentEvery, config.segmentEvery ?? 1) : 0,
    face: config.faceDetection ? level.faceEvery : 0
  }
}

/**
 * Predicted busy share of the busiest perception worker at a level: each task's mean cost
 * divided by how many camera frames it has (its stride), plus the frame copies. Above 1 the
 * worker can't keep up and frames get skipped.
 */
export function workerShare(level: QualityLevel, config: QualityConfig, load: TaskLoad): number {
  const s = strides(level, config)
  const per = (t: Task): number => (s[t] > 0 ? load[t] / s[t] : 0)
  const minStride = (ts: Task[]): number => Math.min(...ts.map((t) => s[t] || Infinity))
  const share = (ts: Task[]): number => {
    const m = minStride(ts)
    return (ts.reduce((sum, t) => sum + per(t), 0) + (Number.isFinite(m) ? load.prep / m : 0)) / CAMERA_FRAME_MS
  }
  return config.perceptionWorkers === 2 ? Math.max(share(['hands']), share(['segment', 'face'])) : share(['hands', 'segment', 'face'])
}

/** Tunables. */
export const QUALITY_TUNING = {
  windowMs: 500,
  degradeAfter: 2,
  recoverAfter: 6,
  /** Recovery wait doubles after a relapse, up to this many windows. */
  maxRecoverAfter: 40,
  /** A stress step-down this soon after a recovery counts as a relapse. */
  relapseMs: 10_000,
  /** Render interval above target × this = stressed; at or below target × calmFrame = calm. */
  stressFrame: 1.15,
  calmFrame: 1.05,
  /** Main-thread ms per rendered frame. */
  stressWorkMs: 8,
  calmWorkMs: 5,
  /** Perception worker busy share (see workerShare). */
  stressTrack: 0.8,
  calmTrack: 0.5
}

const CAMERA_FRAME_MS = 1000 / 30

class WindowAverage {
  sum = 0
  n = 0
  push(v: number): void {
    this.sum += v
    this.n++
  }
  get mean(): number {
    return this.n ? this.sum / this.n : 0
  }
  clear(): void {
    this.sum = 0
    this.n = 0
  }
}

export class QualityController {
  private current = 0
  private floor = 0
  private adaptive = true
  private windowStart: number | null = null
  private readonly frameMs = new WindowAverage()
  private readonly workMs = new WindowAverage()
  private readonly load: Record<keyof TaskLoad, WindowAverage> = {
    hands: new WindowAverage(),
    segment: new WindowAverage(),
    face: new WindowAverage(),
    prep: new WindowAverage()
  }
  private readonly loadMeans: TaskLoad = { hands: 0, segment: 0, face: 0, prep: 0 }
  private config: QualityConfig = { trackEvery: 2, adaptive: true }
  private stressed = 0
  private calm = 0
  private recoverAfter = QUALITY_TUNING.recoverAfter
  private lastRecovery = -Infinity

  constructor(config: QualityConfig) {
    this.configure(config)
    this.current = this.floor
  }

  get level(): number {
    return this.current
  }

  get settings(): QualityLevel {
    return QUALITY_LEVELS[this.current]!
  }

  /** Camera-frame strides per perception task at the current level (0 = off). */
  get strides(): Record<Task, number> {
    return strides(this.settings, this.config)
  }

  configure(config: QualityConfig): void {
    this.config = config
    const i = QUALITY_LEVELS.findIndex((l) => l.trackEvery >= config.trackEvery)
    this.floor = i < 0 ? QUALITY_LEVELS.length - 1 : i
    this.adaptive = config.adaptive
    if (!this.adaptive || this.current < this.floor) this.setLevel(this.floor)
  }

  /** Once per rendered frame: time since the previous frame and main-thread work this frame. */
  frame(now: number, frameMs: number, workMs: number): void {
    this.frameMs.push(frameMs)
    this.workMs.push(workMs)
    this.windowStart ??= now
    if (now - this.windowStart < QUALITY_TUNING.windowMs) return
    this.evaluate(now)
    this.windowStart = now
  }

  /** Once per worker result: ms per task that ran, and the frame copies. */
  worked(ms: Partial<TaskLoad>): void {
    if (ms.hands !== undefined) this.load.hands.push(ms.hands)
    if (ms.segment !== undefined) this.load.segment.push(ms.segment)
    if (ms.face !== undefined) this.load.face.push(ms.face)
    if (ms.prep !== undefined) this.load.prep.push(ms.prep)
  }

  private evaluate(now: number): void {
    const T = QUALITY_TUNING
    const level = this.settings
    const targetFrame = 1000 / level.maxRenderFps
    const better = QUALITY_LEVELS[this.current - 1]
    let hasLoad = false
    for (const k of ['hands', 'segment', 'face', 'prep'] as const) {
      hasLoad ||= this.load[k].n > 0
      this.loadMeans[k] = this.load[k].mean
      this.load[k].clear()
    }

    const stressed =
      this.frameMs.mean > targetFrame * T.stressFrame ||
      this.workMs.mean > T.stressWorkMs ||
      (hasLoad && workerShare(level, this.config, this.loadMeans) > T.stressTrack)
    const calm =
      this.frameMs.mean <= targetFrame * T.calmFrame &&
      this.workMs.mean < T.calmWorkMs &&
      (!hasLoad || !better || workerShare(better, this.config, this.loadMeans) < T.calmTrack)
    this.frameMs.clear()
    this.workMs.clear()
    if (!this.adaptive) return

    this.stressed = stressed ? this.stressed + 1 : 0
    this.calm = calm ? this.calm + 1 : 0
    if (this.stressed >= T.degradeAfter && this.current < QUALITY_LEVELS.length - 1) {
      if (now - this.lastRecovery < T.relapseMs) this.recoverAfter = Math.min(this.recoverAfter * 2, T.maxRecoverAfter)
      this.setLevel(this.current + 1)
    } else if (this.calm >= this.recoverAfter && this.current > this.floor) {
      this.lastRecovery = now
      this.setLevel(this.current - 1)
    } else if (this.calm >= T.maxRecoverAfter) {
      // Long stable stretch: forgive past relapses.
      this.recoverAfter = T.recoverAfter
    }
  }

  private setLevel(level: number): void {
    this.current = level
    this.stressed = 0
    this.calm = 0
  }
}
