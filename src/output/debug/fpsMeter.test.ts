import { describe, expect, it } from 'vitest'
import { FpsMeter, RollingAverage } from './fpsMeter'

describe('FpsMeter', () => {
  it('reports 0 before two frames', () => {
    const m = new FpsMeter()
    m.tick(0)
    expect(m.fps).toBe(0)
  })

  it('measures a steady 30 fps', () => {
    const m = new FpsMeter()
    for (let i = 0; i <= 60; i++) m.tick(i * (1000 / 30))
    expect(m.fps).toBeCloseTo(30, 1)
  })

  it('only counts the last second of frames', () => {
    const m = new FpsMeter()
    for (let i = 0; i <= 30; i++) m.tick(i * (1000 / 60)) // 0.5 s at 60 fps
    for (let i = 1; i <= 30; i++) m.tick(500 + i * (1000 / 15)) // 2 s at 15 fps
    expect(m.fps).toBeCloseTo(15, 1)
  })
})

describe('RollingAverage', () => {
  it('averages the last N samples', () => {
    const a = new RollingAverage(3)
    expect(a.value).toBe(0)
    for (const v of [100, 1, 2, 3]) a.push(v)
    expect(a.value).toBe(2)
  })
})
