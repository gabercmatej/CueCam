import { describe, expect, it } from 'vitest'
import { MaskSmoother } from './maskSmoother'

const mask = (...v: number[]) => Float32Array.from(v)

describe('MaskSmoother', () => {
  it('passes the first mask through, quantized and clamped to bytes', () => {
    const s = new MaskSmoother(0.5)
    expect([...s.push(mask(0, 0.5, 1, 1.2, -0.1), 5, 1, 0)]).toEqual([0, 128, 255, 255, 0])
  })

  it('blends each new mask into the running one (anti-flicker)', () => {
    const s = new MaskSmoother(0.5)
    s.push(mask(0, 1), 2, 1, 0)
    expect([...s.push(mask(1, 0), 2, 1, 33)]).toEqual([128, 128])
    expect([...s.push(mask(1, 0), 2, 1, 66)]).toEqual([191, 64])
  })

  it('starts over after a gap or a size change instead of blending a stale mask', () => {
    const s = new MaskSmoother(0.5, 400)
    s.push(mask(0, 0), 2, 1, 0)
    expect([...s.push(mask(1, 1), 2, 1, 1000)]).toEqual([255, 255])
    expect([...s.push(mask(0, 1, 0), 3, 1, 1033)]).toEqual([0, 255, 0])
  })

  it('returns a fresh buffer each time (the previous one was transferred)', () => {
    const s = new MaskSmoother()
    const a = s.push(mask(1), 1, 1, 0)
    expect(s.push(mask(1), 1, 1, 33)).not.toBe(a)
  })
})
