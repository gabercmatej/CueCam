/**
 * Adaptive quality: watches render interval, main-thread work per frame and tracking time,
 * and trades tracking rate, particle counts and render rate for a steady output. Stress is
 * judged per 500 ms window; two stressed windows in a row step down one level (≈1 s), six
 * calm ones step back up (≈3 s, longer after a relapse). Main-thread work is the early
 * signal: it rises before frames are actually dropped.
 */

export interface QualityLevel {
  /** Track every Nth camera frame. */
  trackEvery: number
  /** Multiplier on particle counts and the live-particle cap. */
  particleScale: number
  /** Render rate cap. 30 still matches the camera (and what OBS sends the call). */
  maxRenderFps: number
}

export const QUALITY_LEVELS: readonly QualityLevel[] = [
  { trackEvery: 1, particleScale: 1, maxRenderFps: 60 },
  { trackEvery: 2, particleScale: 1, maxRenderFps: 60 },
  { trackEvery: 2, particleScale: 0.6, maxRenderFps: 60 },
  { trackEvery: 3, particleScale: 0.4, maxRenderFps: 30 },
  { trackEvery: 4, particleScale: 0.25, maxRenderFps: 30 }
]

export interface QualityConfig {
  /** Configured tracking stride: the best level allowed. */
  trackEvery: number
  adaptive: boolean
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
  /** Tracking ms as a share of the time between tracked frames. */
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
  private readonly trackMs = new WindowAverage()
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

  configure(config: QualityConfig): void {
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

  /** Once per tracking result: inference time in the worker. */
  tracked(ms: number): void {
    this.trackMs.push(ms)
  }

  private evaluate(now: number): void {
    const T = QUALITY_TUNING
    const level = this.settings
    const targetFrame = 1000 / level.maxRenderFps
    const trackBudget = level.trackEvery * CAMERA_FRAME_MS
    const better = QUALITY_LEVELS[this.current - 1]
    const hasTrack = this.trackMs.n > 0

    const stressed =
      this.frameMs.mean > targetFrame * T.stressFrame ||
      this.workMs.mean > T.stressWorkMs ||
      (hasTrack && this.trackMs.mean > trackBudget * T.stressTrack)
    const calm =
      this.frameMs.mean <= targetFrame * T.calmFrame &&
      this.workMs.mean < T.calmWorkMs &&
      (!hasTrack || !better || this.trackMs.mean < better.trackEvery * CAMERA_FRAME_MS * T.calmTrack)
    this.frameMs.clear()
    this.workMs.clear()
    this.trackMs.clear()
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
