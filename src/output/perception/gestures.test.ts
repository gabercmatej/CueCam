import { describe, expect, it } from 'vitest'
import { makeHand, POSES } from './__fixtures__/hands'
import { analyzeHand, type Landmark } from './handGeometry'
import { assignSides, classifyHand, detectHeart, GestureTracker, PalmPushDetector, PinchLatch, Stabilizer, type RawHand } from './gestures'
import type { View } from '../view'

const ASPECT = 16 / 9
const geo = (lm: Landmark[]) => analyzeHand(lm, ASPECT)

describe('classifyHand', () => {
  it('maps MediaPipe built-in labels to our names', () => {
    const fist = geo(makeHand(POSES.fist))
    expect(classifyHand(fist, { name: 'Closed_Fist', score: 0.9 })).toBe('Fist')
    expect(classifyHand(fist, { name: 'Thumb_Up', score: 0.9 })).toBe('ThumbUp')
    expect(classifyHand(fist, { name: 'Pointing_Up', score: 0.9 })).toBe('PointingUp')
  })

  it('ignores built-in labels scoring below 0.6', () => {
    expect(classifyHand(geo(makeHand(POSES.fist)), { name: 'Closed_Fist', score: 0.5 })).toBeNull()
  })

  it('calls a rock sign Rock even when MediaPipe says ILoveYou', () => {
    expect(classifyHand(geo(makeHand(POSES.rock)), { name: 'ILoveYou', score: 0.95 })).toBe('Rock')
  })

  it('calls index + pinky + extended thumb ILoveYou, from geometry', () => {
    expect(classifyHand(geo(makeHand(POSES.iLoveYou)), null)).toBe('ILoveYou')
  })

  it('never passes the built-in ILoveYou label through on its own', () => {
    expect(classifyHand(geo(makeHand(POSES.fist)), { name: 'ILoveYou', score: 0.95 })).toBeNull()
  })

  it('recognizes a finger gun held sideways with the thumb up', () => {
    expect(classifyHand(geo(makeHand(POSES.fingerGun, { rotate: 90 })), { name: 'Pointing_Up', score: 0.8 })).toBe('FingerGun')
  })

  it('does not call it a finger gun when the thumb points down', () => {
    expect(classifyHand(geo(makeHand(POSES.fingerGun, { rotate: 180 })), null)).not.toBe('FingerGun')
  })

  it('does not call plain pointing a finger gun', () => {
    expect(classifyHand(geo(makeHand(POSES.pointing, { rotate: 90 })), null)).not.toBe('FingerGun')
  })
})

describe('Stabilizer', () => {
  const FRAME = 1000 / 30
  /** One sample per `stride` camera frames at 30 fps, starting at frame `from`. */
  const run = (s: Stabilizer, frames: string[][], stride = 1, from = 0) =>
    frames.map((f, i) => s.update(new Set(f), (from + i * stride) * FRAME))

  it('fires once after 5 consecutive frames', () => {
    const fired = run(new Stabilizer(), [['a'], ['a'], ['a'], ['a'], ['a'], ['a'], ['a']])
    expect(fired.map((f) => f.length)).toEqual([0, 0, 0, 0, 1, 0, 0])
  })

  it('needs at least 3 detections even when samples are far apart (stride 4 under load)', () => {
    expect(run(new Stabilizer(), [['a'], ['a'], ['a']], 4).map((f) => f.length)).toEqual([0, 0, 1])
  })

  it('does not treat a gap in tracking as the gesture being held', () => {
    const s = new Stabilizer()
    s.update(new Set(['a']), 0)
    s.update(new Set(['a']), 1000)
    expect(s.update(new Set(['a']), 1033)).toEqual([])
  })

  it('takes the same time to fire when tracking runs every 2nd or 3rd frame', () => {
    // 5 frames at 30 fps ≈ 133 ms: 3 samples at stride 2, 2 samples at stride 3 (0 → 100 → 200 ms).
    expect(run(new Stabilizer(), [['a'], ['a'], ['a'], ['a']], 2).map((f) => f.length)).toEqual([0, 0, 1, 0])
    expect(run(new Stabilizer(), [['a'], ['a'], ['a']], 3).map((f) => f.length)).toEqual([0, 0, 1])
    // …and at stride 3 that is also the 3-detection minimum.
  })

  it('restarts the hold count if the gesture flickers out', () => {
    const fired = run(new Stabilizer(), [['a'], ['a'], ['a'], ['a'], [], ['a'], ['a'], ['a'], ['a']])
    expect(fired.flat()).toEqual([])
  })

  it('needs 10 frames of absence before it can fire again', () => {
    const s = new Stabilizer()
    run(s, Array.from({ length: 5 }, () => ['a']))
    expect(run(s, [...Array.from({ length: 9 }, () => []), ...Array.from({ length: 5 }, () => ['a'])], 1, 5).flat()).toEqual([])
    run(s, Array.from({ length: 10 }, () => []), 1, 19)
    expect(run(s, Array.from({ length: 5 }, () => ['a']), 1, 29).flat()).toEqual(['a'])
  })

  it('measures absence in time, not samples, at a tracking stride', () => {
    const s = new Stabilizer()
    run(s, [['a'], ['a'], ['a']], 2)
    // 5 empty samples at stride 2 = 10 frames of absence.
    run(s, Array.from({ length: 5 }, () => []), 2, 6)
    expect(run(s, [['a'], ['a'], ['a']], 2, 16).flat()).toEqual(['a'])
  })

  it('supports a per-key hold', () => {
    const s = new Stabilizer(5, 10, (k) => (k.startsWith('PalmPush') ? 1 : 5))
    expect(s.update(new Set(['PalmPush:Left']), 0)).toEqual(['PalmPush:Left'])
  })
})

describe('PinchLatch', () => {
  it('enters below 0.25 and only exits above 0.35', () => {
    const p = new PinchLatch()
    expect([0.3, 0.24, 0.3, 0.34, 0.36, 0.3].map((d) => p.update(d))).toEqual([false, true, true, true, false, false])
  })
})

describe('PalmPushDetector', () => {
  it('fires when an open palm grows by more than 25% within 300 ms', () => {
    const d = new PalmPushDetector()
    expect(d.update(true, 0.2, 0)).toBe(false)
    expect(d.update(true, 0.22, 100)).toBe(false)
    expect(d.update(true, 0.26, 250)).toBe(true)
  })

  it('ignores slow growth', () => {
    const d = new PalmPushDetector()
    expect([0, 200, 400, 600, 800].map((t, i) => d.update(true, 0.2 + i * 0.02, t))).not.toContain(true)
  })

  it('resets when the palm closes', () => {
    const d = new PalmPushDetector()
    d.update(true, 0.2, 0)
    d.update(false, 0.2, 50)
    expect(d.update(true, 0.26, 100)).toBe(false)
  })
})

describe('detectHeart', () => {
  // A finger heart: two hands mirrored, index tips touching on top, thumb tips touching below.
  function heartHands(gap = 0): [Landmark[], Landmark[]] {
    const left = makeHand(POSES.openPalm, { wrist: { x: 0.4, y: 0.7 } })
    const right = makeHand(POSES.openPalm, { wrist: { x: 0.6, y: 0.7 } })
    const meet = (a: Landmark, b: Landmark, y: number) => {
      a.x = 0.5 - gap
      b.x = 0.5 + gap
      a.y = b.y = y
      a.z = b.z = 0
    }
    meet(left[8]!, right[8]!, 0.45)
    meet(left[4]!, right[4]!, 0.6)
    return [left, right]
  }

  it('detects index tips and thumb tips touching, index above thumb', () => {
    const [a, b] = heartHands()
    expect(detectHeart(geo(a), geo(b))).toEqual({ x: 0.5, y: 0.525 })
  })

  it('rejects hands that are apart', () => {
    const [a, b] = heartHands(0.1)
    expect(detectHeart(geo(a), geo(b))).toBeNull()
  })

  it('rejects an upside-down heart (thumbs above index tips)', () => {
    const [a, b] = heartHands()
    for (const h of [a, b]) {
      const y8 = h[8]!.y
      h[8]!.y = h[4]!.y
      h[4]!.y = y8
    }
    expect(detectHeart(geo(a), geo(b))).toBeNull()
  })
})

describe('GestureTracker', () => {
  const view: View = { mirror: true, width: 1280, height: 720 }
  const hand = (lm: Landmark[], side: 'Left' | 'Right', builtin: RawHand['builtin'] = null): RawHand => ({ landmarks: lm, side, builtin })

  it('emits one stabilized event in mirrored screen space', () => {
    const t = new GestureTracker(view)
    const lm = makeHand(POSES.rock, { wrist: { x: 0.25, y: 0.75 } })
    const events = Array.from({ length: 6 }, (_, i) => t.update([hand(lm, 'Right')], i * 33).events).flat()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'gesture', gesture: 'Rock', hand: 'Right' })
    // Wrist at raw x = 0.25 → mirrored to the right half of the screen.
    expect(events[0]!.position.x).toBeGreaterThan(640)
  })

  it('reports the live (unstabilized) label per hand for the debug overlay', () => {
    const t = new GestureTracker(view)
    const { hands } = t.update([hand(makeHand(POSES.rock), 'Left')], 0)
    expect(hands[0]).toMatchObject({ side: 'Left', label: 'Rock', pinching: false })
    expect(hands[0]!.landmarks).toHaveLength(21)
  })
})

describe('assignSides (review fix: duplicate handedness labels)', () => {
  const hand = (wristX: number, side: 'Left' | 'Right'): RawHand => ({ landmarks: makeHand(POSES.openPalm, { wrist: { x: wristX, y: 0.7 } }), side, builtin: null })

  it('keeps distinct labels as they are', () => {
    expect(assignSides([hand(0.2, 'Left'), hand(0.8, 'Right')]).map((h) => h.side)).toEqual(['Left', 'Right'])
  })

  it('splits two same-labelled hands by position in the raw frame (your right hand is on the raw left)', () => {
    expect(assignSides([hand(0.8, 'Left'), hand(0.2, 'Left')]).map((h) => h.side)).toEqual(['Left', 'Right'])
    expect(assignSides([hand(0.2, 'Right'), hand(0.8, 'Right')]).map((h) => h.side)).toEqual(['Right', 'Left'])
  })

  it('stops two open palms of different sizes from faking a PalmPush', () => {
    const t = new GestureTracker({ mirror: true, width: 1280, height: 720 })
    const small = { landmarks: makeHand(POSES.openPalm, { wrist: { x: 0.2, y: 0.7 }, size: 0.2 }), side: 'Left' as const, builtin: { name: 'Open_Palm', score: 0.9 } }
    const big = { landmarks: makeHand(POSES.openPalm, { wrist: { x: 0.8, y: 0.7 }, size: 0.26 }), side: 'Left' as const, builtin: { name: 'Open_Palm', score: 0.9 } }
    expect(t.update([small, big], 0).events.filter((e) => e.gesture === 'PalmPush')).toEqual([])
  })
})
