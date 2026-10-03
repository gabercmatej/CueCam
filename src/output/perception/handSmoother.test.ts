import { describe, expect, it } from 'vitest'
import type { HandSide } from '../../shared/types'
import type { Landmark } from './handGeometry'
import { HandSmoother } from './handSmoother'

/** A 21-point hand with every landmark at (x, y). */
const hand = (side: HandSide, x: number, y = 0.5) => ({
  side,
  landmarks: Array.from({ length: 21 }, (): Landmark => ({ x, y, z: 0 }))
})
const xOf = (hands: { side: HandSide; landmarks: Landmark[] }[], side: HandSide) => hands.find((h) => h.side === side)?.landmarks[0]!.x

describe('HandSmoother', () => {
  it('returns the observed hand when there is nothing to extrapolate from', () => {
    const s = new HandSmoother()
    s.observe([hand('Right', 0.3)], 0)
    expect(xOf(s.predict(0), 'Right')).toBeCloseTo(0.3)
    expect(xOf(s.predict(33), 'Right')).toBeCloseTo(0.3)
  })

  it('predicts constant motion between tracking results', () => {
    const s = new HandSmoother()
    s.observe([hand('Right', 0.1)], 0)
    s.observe([hand('Right', 0.2)], 66)
    expect(xOf(s.predict(66), 'Right')).toBeCloseTo(0.2)
    expect(xOf(s.predict(99), 'Right')).toBeCloseTo(0.25)
  })

  it('never extrapolates further than maxAheadMs', () => {
    const s = new HandSmoother({ maxAheadMs: 50, expireMs: 5000 })
    s.observe([hand('Right', 0.1)], 0)
    s.observe([hand('Right', 0.2)], 100)
    expect(xOf(s.predict(1000), 'Right')).toBeCloseTo(0.25)
  })

  it('does not predict backwards in time', () => {
    const s = new HandSmoother()
    s.observe([hand('Right', 0.1)], 0)
    s.observe([hand('Right', 0.2)], 100)
    expect(xOf(s.predict(50), 'Right')).toBeCloseTo(0.2)
  })

  it('drops a hand as soon as tracking stops seeing it, and restarts it without a stale velocity', () => {
    const s = new HandSmoother()
    s.observe([hand('Left', 0.1), hand('Right', 0.8)], 0)
    s.observe([hand('Left', 0.2), hand('Right', 0.8)], 33)
    s.observe([hand('Right', 0.8)], 66)
    expect(xOf(s.predict(70), 'Left')).toBeUndefined()
    s.observe([hand('Left', 0.6), hand('Right', 0.8)], 99)
    expect(xOf(s.predict(132), 'Left')).toBeCloseTo(0.6)
  })

  it('keeps each side on its own track', () => {
    const s = new HandSmoother()
    s.observe([hand('Left', 0.1), hand('Right', 0.9)], 0)
    s.observe([hand('Left', 0.2), hand('Right', 0.8)], 50)
    const p = s.predict(100)
    expect(xOf(p, 'Left')).toBeCloseTo(0.3)
    expect(xOf(p, 'Right')).toBeCloseTo(0.7)
  })

  it('smooths velocity so one jittery sample does not fling the prediction', () => {
    const s = new HandSmoother({ velocitySmoothing: 0.5 })
    s.observe([hand('Right', 0.1)], 0)
    s.observe([hand('Right', 0.15)], 100) // v = 0.0005/ms
    s.observe([hand('Right', 0.25)], 200) // raw v = 0.001/ms, smoothed 0.00075/ms
    expect(xOf(s.predict(240), 'Right')).toBeCloseTo(0.25 + 0.00075 * 40)
  })

  it('forgets everything on reset', () => {
    const s = new HandSmoother()
    s.observe([hand('Right', 0.3)], 0)
    s.reset()
    expect(s.predict(10)).toEqual([])
  })

  it('does not fling a hand when tracking swaps two hands between results', () => {
    const s = new HandSmoother()
    s.observe([hand('Right', 0.3)], 0)
    s.observe([hand('Right', 0.31)], 66)
    s.observe([hand('Right', 0.7)], 133) // a jump of 0.4 in one result: a swap, not motion
    expect(xOf(s.predict(200), 'Right')).toBeCloseTo(0.7)
  })

  it('expires a hand when no result has arrived for a while (tracker stalled)', () => {
    const s = new HandSmoother({ expireMs: 500 })
    s.observe([hand('Right', 0.3)], 0)
    expect(s.predict(499)).toHaveLength(1)
    expect(s.predict(500)).toHaveLength(0)
  })
})
