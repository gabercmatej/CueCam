import { describe, expect, it } from 'vitest'
import { makeHand, POSES } from './__fixtures__/hands'
import { analyzeHand, dist } from './handGeometry'

describe('analyzeHand', () => {
  it('measures hand scale as dist(0, 9) in frame-height units', () => {
    const a = analyzeHand(makeHand(POSES.openPalm, { size: 0.3 }), 16 / 9)
    expect(a.scale).toBeCloseTo(0.3 * Math.hypot(0.1, 1), 2)
  })

  it('reads finger states for an open palm', () => {
    expect(analyzeHand(makeHand(POSES.openPalm), 16 / 9).fingers).toEqual({
      thumb: 'out',
      index: 'ext',
      middle: 'ext',
      ring: 'ext',
      pinky: 'ext'
    })
  })

  it('reads finger states for a rock sign, independent of size and rotation', () => {
    for (const at of [{}, { size: 0.12 }, { rotate: 35 }, { rotate: -60, size: 0.4 }]) {
      expect(analyzeHand(makeHand(POSES.rock, at), 16 / 9).fingers).toEqual({
        thumb: 'tucked',
        index: 'ext',
        middle: 'curl',
        ring: 'curl',
        pinky: 'ext'
      })
    }
  })

  it('tells an extended thumb from a tucked one', () => {
    expect(analyzeHand(makeHand(POSES.iLoveYou), 16 / 9).fingers.thumb).toBe('out')
    expect(analyzeHand(makeHand(POSES.fist), 16 / 9).fingers.thumb).toBe('tucked')
  })

  it('exposes scale-normalized pinch distance', () => {
    const a = analyzeHand(makeHand(POSES.openPalm), 16 / 9)
    expect(a.pinch).toBeGreaterThan(0.35)
  })
})

describe('dist', () => {
  it('is euclidean in 3D', () => {
    expect(dist({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 12 })).toBe(13)
  })
})
