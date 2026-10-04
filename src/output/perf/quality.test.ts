import { describe, expect, it } from 'vitest'
import { QUALITY_LEVELS, QualityController, strides, workerShare } from './quality'

interface Load {
  frameMs: number
  workMs: number
  trackMs: number
}

const NORMAL: Load = { frameMs: 16.7, workMs: 1, trackMs: 18 }
const IDLE: Load = { frameMs: 16.7, workMs: 1, trackMs: 8 }

/** Drives the controller like the app does: one frame() per rendered frame, one tracked() per tracking result. */
function run(q: QualityController, from: number, durationMs: number, load: Load): number {
  let t = from
  let nextTrack = from
  while (t < from + durationMs) {
    t += load.frameMs
    q.frame(t, load.frameMs, load.workMs)
    if (t >= nextTrack) {
      q.worked({ hands: load.trackMs, prep: 0 })
      nextTrack += (1000 / 30) * q.settings.trackEvery
    }
  }
  return t
}

describe('QualityController', () => {
  it('starts at the level matching the configured tracking stride', () => {
    expect(new QualityController({ trackEvery: 2, adaptive: true }).settings.trackEvery).toBe(2)
    expect(new QualityController({ trackEvery: 1, adaptive: true }).level).toBe(0)
  })

  it('holds its level under normal load', () => {
    const q = new QualityController({ trackEvery: 2, adaptive: true })
    run(q, 0, 10_000, NORMAL)
    expect(q.level).toBe(1)
  })

  it('degrades when the render interval stretches, but not on a single bad window', () => {
    const q = new QualityController({ trackEvery: 2, adaptive: true })
    let t = run(q, 0, 2000, NORMAL)
    t = run(q, t, 500, { ...NORMAL, frameMs: 25 })
    t = run(q, t, 2000, NORMAL)
    expect(q.level).toBe(1)
    run(q, t, 1100, { ...NORMAL, frameMs: 25 })
    expect(q.level).toBe(2)
  })

  it('degrades on rising main-thread work before the frame rate drops', () => {
    const q = new QualityController({ trackEvery: 2, adaptive: true })
    run(q, 0, 1100, { ...NORMAL, workMs: 10 })
    expect(q.level).toBe(2)
  })

  it('degrades when tracking cannot keep up with its stride', () => {
    const q = new QualityController({ trackEvery: 2, adaptive: true })
    run(q, 0, 1100, { ...NORMAL, trackMs: 60 })
    expect(q.level).toBe(2)
  })

  it('steps down one level per stressed second and stops at the last level', () => {
    const q = new QualityController({ trackEvery: 2, adaptive: true })
    run(q, 0, 20_000, { frameMs: 40, workMs: 12, trackMs: 200 })
    expect(q.level).toBe(QUALITY_LEVELS.length - 1)
    expect(q.settings).toMatchObject({ trackEvery: 4, maxRenderFps: 30 })
  })

  it('recovers one level at a time after sustained calm, never past the configured floor', () => {
    const q = new QualityController({ trackEvery: 2, adaptive: true })
    let t = run(q, 0, 2200, { frameMs: 25, workMs: 12, trackMs: 18 })
    expect(q.level).toBe(3)
    t = run(q, t, 2000, IDLE)
    expect(q.level).toBe(3)
    t = run(q, t, 1600, IDLE)
    expect(q.level).toBe(2)
    run(q, t, 30_000, IDLE)
    expect(q.level).toBe(1)
  })

  it('waits longer before recovering again after a relapse', () => {
    const q = new QualityController({ trackEvery: 2, adaptive: true })
    let t = run(q, 0, 1100, { ...NORMAL, workMs: 12 })
    expect(q.level).toBe(2)
    t = run(q, t, 3600, IDLE)
    expect(q.level).toBe(1)
    t = run(q, t, 1600, { ...NORMAL, workMs: 12 })
    expect(q.level).toBe(2)
    t = run(q, t, 3600, IDLE)
    expect(q.level).toBe(2)
    run(q, t, 3600, IDLE)
    expect(q.level).toBe(1)
  })

  it('never changes when adaptive quality is off', () => {
    const q = new QualityController({ trackEvery: 3, adaptive: false })
    const start = q.level
    run(q, 0, 10_000, { frameMs: 40, workMs: 12, trackMs: 200 })
    expect(q.level).toBe(start)
    expect(q.settings.trackEvery).toBe(3)
  })

  it('applies a new config without losing a degraded level', () => {
    const q = new QualityController({ trackEvery: 2, adaptive: true })
    run(q, 0, 2200, { frameMs: 25, workMs: 12, trackMs: 18 })
    q.configure({ trackEvery: 1, adaptive: true })
    expect(q.level).toBe(3)
    q.configure({ trackEvery: 4, adaptive: true })
    expect(q.level).toBe(4)
  })
})

describe('perception load in quality levels', () => {
  const seg = { trackEvery: 2, adaptive: true, segmentation: true, segmentEvery: 2, faceDetection: true } as const

  it('gives way on segmentation before capping the render rate', () => {
    const [, l1, l2, l3] = QUALITY_LEVELS
    expect(strides(l1!, seg)).toEqual({ hands: 2, segment: 2, face: 3 })
    expect(strides(l2!, seg).segment).toBeGreaterThan(2)
    expect(l2!.maxRenderFps).toBe(60)
    expect(l3!.mask.width).toBeLessThan(l2!.mask.width)
  })

  it('never segments more often than configured, and switches off tasks that are off', () => {
    expect(strides(QUALITY_LEVELS[0]!, { ...seg, segmentEvery: 4 }).segment).toBe(4)
    expect(strides(QUALITY_LEVELS[1]!, { trackEvery: 2, adaptive: true })).toEqual({ hands: 2, segment: 0, face: 0 })
  })

  it('predicts the busiest worker: one shared worker sums the tasks, two split them', () => {
    const load = { hands: 40, segment: 20, face: 3, prep: 1 }
    const l1 = QUALITY_LEVELS[1]!
    const one = workerShare(l1, seg, load)
    const two = workerShare(l1, { ...seg, perceptionWorkers: 2 }, load)
    expect(one).toBeCloseTo((40 / 2 + 20 / 2 + 3 / 3 + 1 / 2) / (1000 / 30))
    expect(two).toBeCloseTo((40 / 2 + 1 / 2) / (1000 / 30))
    expect(two).toBeLessThan(one)
  })

  it('degrades when segmentation pushes the shared worker over its budget', () => {
    const q = new QualityController(seg)
    let t = 0
    for (let i = 0; i < 70; i++) {
      t += 16.7
      q.frame(t, 16.7, 1)
      if (i % 2 === 0) q.worked({ hands: 30, segment: 25, prep: 1 })
    }
    expect(q.level).toBe(2)
    expect(q.strides.segment).toBe(3)
  })
})
