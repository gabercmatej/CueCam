import { describe, expect, it } from 'vitest'
import { makeHand, POSES } from './__fixtures__/hands'
import { analyzeHand, type Landmark } from './handGeometry'
import { assignSides, ClapDetector, classifyHand, detectHeart, GestureTracker, isPrayPose, PalmPushDetector, PinchLatch, samplesFor, Stabilizer, type RawHand } from './gestures'
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
  const firedAt = (s: Stabilizer, stride: number) => {
    const fired = run(s, Array.from({ length: 12 }, () => ['a']), stride)
    const i = fired.findIndex((f) => f.length > 0)
    return Math.round(i * stride * FRAME)
  }

  it('fires once after the 100 ms hold (every frame: the 4th sample)', () => {
    const fired = run(new Stabilizer(100), [['a'], ['a'], ['a'], ['a'], ['a'], ['a']])
    expect(fired.map((f) => f.length)).toEqual([0, 0, 0, 1, 0, 0])
  })

  it('holds for time, not samples: 100 ms every frame, 133 ms at stride 2 (no burst), 200 ms at stride 3/4', () => {
    expect(firedAt(new Stabilizer(100), 1)).toBe(100)
    expect(firedAt(new Stabilizer(100), 2)).toBe(133)
    expect(firedAt(new Stabilizer(100), 3)).toBe(200)
    // Stride 4: 133 ms already passed at the 2nd sample, but a hold needs 3 detections.
    expect(firedAt(new Stabilizer(100), 4)).toBe(267)
  })

  it('a 66 ms hold (Fist) fires on the 3rd frame; a 0 ms hold on the first detection', () => {
    expect(firedAt(new Stabilizer(66), 1)).toBe(67)
    expect(new Stabilizer(0).update(new Set(['a']), 0)).toEqual(['a'])
  })

  it('needs at most 3 detections however long the hold', () => {
    expect(samplesFor(500)).toBe(3)
    expect(samplesFor(66)).toBe(3)
    expect(samplesFor(33)).toBe(2)
    expect(samplesFor(0)).toBe(1)
    expect(firedAt(new Stabilizer(500), 6)).toBe(600)
  })

  it('reports a pending hold (for burst tracking) until the key fires', () => {
    const s = new Stabilizer(100)
    s.update(new Set(['a']), 0)
    expect(s.pending).toBe(true)
    run(s, [['a'], ['a'], ['a']], 1, 1)
    expect(s.pending).toBe(false)
    expect(s.isActive('a')).toBe(true)
    expect(s.startedAt('a')).toBe(0)
  })

  it('does not treat a gap in tracking as the gesture being held', () => {
    const s = new Stabilizer()
    s.update(new Set(['a']), 0)
    s.update(new Set(['a']), 1000)
    expect(s.update(new Set(['a']), 1033)).toEqual([])
  })

  it('restarts the hold if the gesture flickers out', () => {
    const fired = run(new Stabilizer(100), [['a'], ['a'], ['a'], [], ['a'], ['a'], ['a']])
    expect(fired.flat()).toEqual([])
  })

  it('needs 330 ms of absence before it can fire again', () => {
    const s = new Stabilizer(100, 330)
    run(s, Array.from({ length: 4 }, () => ['a']))
    // 9 empty frames (300 ms): still latched.
    expect(run(s, [...Array.from({ length: 9 }, () => []), ...Array.from({ length: 4 }, () => ['a'])], 1, 4).flat()).toEqual([])
    run(s, Array.from({ length: 10 }, () => []), 1, 17)
    expect(run(s, Array.from({ length: 4 }, () => ['a']), 1, 27).flat()).toEqual(['a'])
  })

  it('supports a per-key hold', () => {
    const s = new Stabilizer(100, 330, (k) => (k.startsWith('PalmPush') ? 0 : 100))
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

describe('two-hand gestures', () => {
  const view: View = { mirror: false, width: 1280, height: 720 }
  const PALM = { name: 'Open_Palm', score: 0.9 }
  const FIST = { name: 'Closed_Fist', score: 0.9 }
  const palmAt = (x: number, side: 'Left' | 'Right', builtin: RawHand['builtin'] = PALM, size = 0.2): RawHand => ({
    landmarks: makeHand(POSES.openPalm, { wrist: { x, y: 0.85 }, size }),
    side,
    builtin
  })
  /** Feeds `frames` (pairs of wrist x for Right/Left hands, or null = one merged hand) every `step` ms. */
  const feed = (t: GestureTracker, frames: (readonly [number, number] | null)[], step = 33, from = 0) =>
    frames.flatMap((f, i) => t.update(f ? [palmAt(f[0], 'Right', null), palmAt(f[1], 'Left', null)] : [palmAt(0.5, 'Right', null)], from + i * step).events)

  it('Pray: palms pressed together, fingers up, held still for 500 ms', () => {
    const t = new GestureTracker(view)
    const events = feed(t, Array.from({ length: 18 }, () => [0.5, 0.505] as const))
    const pray = events.filter((e) => e.gesture === 'Pray')
    expect(pray).toHaveLength(1)
    expect(pray[0]!.at - pray[0]!.heldFrom!).toBeGreaterThanOrEqual(490)
    // Pressed palms also look like a finger heart: that must not fire.
    expect(events.some((e) => e.gesture === 'Heart')).toBe(false)
  })

  it('Pray needs the hands still', () => {
    const t = new GestureTracker(view)
    // Pressed together but sweeping across the frame.
    const events = feed(t, Array.from({ length: 18 }, (_, i) => [0.3 + i * 0.02, 0.305 + i * 0.02] as const))
    expect(events.some((e) => e.gesture === 'Pray')).toBe(false)
  })

  it('isPrayPose rejects hands apart', () => {
    const geo2 = (x: number) => analyzeHand(makeHand(POSES.openPalm, { wrist: { x, y: 0.85 }, size: 0.2 }), ASPECT)
    expect(isPrayPose(geo2(0.5), geo2(0.505))).toBe(true)
    expect(isPrayPose(geo2(0.3), geo2(0.7))).toBe(false)
  })

  it('Clap: hands meeting fast fire Clap at once, and no Pray right after', () => {
    const t = new GestureTracker(view)
    const approach = [[0.2, 0.8], [0.3, 0.7], [0.4, 0.6], [0.49, 0.51]] as const
    const still = Array.from({ length: 20 }, () => [0.49, 0.51] as const)
    const events = feed(t, [...approach, ...still])
    expect(events.filter((e) => e.gesture === 'Clap')).toHaveLength(1)
    expect(events.find((e) => e.gesture === 'Clap')!.at).toBe(3 * 33)
    expect(events.some((e) => e.gesture === 'Pray')).toBe(false)
  })

  it('Clap: contact that merges the hands into one detection still counts', () => {
    const t = new GestureTracker(view)
    const events = feed(t, [[0.2, 0.8], [0.32, 0.68], [0.44, 0.56], null])
    expect(events.filter((e) => e.gesture === 'Clap')).toHaveLength(1)
  })

  it('Clap: a slow approach is not a clap', () => {
    const t = new GestureTracker(view)
    const events = feed(t, Array.from({ length: 30 }, (_, i) => [0.3 + i * 0.0065, 0.7 - i * 0.0065] as const))
    expect(events.some((e) => e.gesture === 'Clap')).toBe(false)
  })

  it('ClapDetector asks for burst tracking during a fast approach', () => {
    const c = new ClapDetector()
    c.update(5, { x: 0.5, y: 0.5 }, 0)
    c.update(3, { x: 0.5, y: 0.5 }, 66)
    expect(c.approaching(66)).toBe(true)
    expect(c.approaching(1000)).toBe(false)
  })

  it('BothHandsUp: two open palms apart, and neither counts as OpenPalm', () => {
    const t = new GestureTracker(view)
    const events = Array.from({ length: 12 }, (_, i) => t.update([palmAt(0.25, 'Right'), palmAt(0.75, 'Left')], i * 33).events).flat()
    expect(events.map((e) => e.gesture)).toEqual(['BothHandsUp'])
  })

  it('one open palm is OpenPalm', () => {
    const t = new GestureTracker(view)
    const events = Array.from({ length: 12 }, (_, i) => t.update([palmAt(0.25, 'Right')], i * 33).events).flat()
    expect(events.map((e) => e.gesture)).toEqual(['OpenPalm'])
  })

  it('two fists fire one Fist per hand, within 66 ms', () => {
    const t = new GestureTracker(view)
    const fist = (x: number, side: 'Left' | 'Right'): RawHand => ({ landmarks: makeHand(POSES.fist, { wrist: { x, y: 0.8 } }), side, builtin: FIST })
    const events = Array.from({ length: 4 }, (_, i) => t.update([fist(0.25, 'Right'), fist(0.75, 'Left')], i * 33).events).flat()
    expect(events.map((e) => `${e.gesture}:${e.hand}@${e.at}`)).toEqual(['Fist:Right@66', 'Fist:Left@66'])
  })

  it('asks for burst tracking while a gesture is pending, and reports it active once fired', () => {
    const t = new GestureTracker(view)
    const fist = { landmarks: makeHand(POSES.fist), side: 'Right' as const, builtin: FIST }
    expect(t.update([fist], 0).burst).toBe(true)
    t.update([fist], 33)
    const fired = t.update([fist], 66)
    expect(fired.burst).toBe(false)
    expect(t.update([fist], 99).active.map((e) => e.gesture)).toEqual(['Fist'])
  })
})

describe('Pinch vs Fist', () => {
  it('a fist (thumb resting on the curled index) is never a pinch', () => {
    const t = new GestureTracker({ mirror: false, width: 1280, height: 720 })
    const fist: RawHand = { landmarks: makeHand(POSES.fist), side: 'Right', builtin: { name: 'Closed_Fist', score: 0.9 } }
    expect(geo(fist.landmarks).pinch).toBeLessThan(0.35)
    const events = Array.from({ length: 6 }, (_, i) => t.update([fist], i * 33).events).flat()
    expect(events.map((e) => e.gesture)).toEqual(['Fist'])
  })
})

describe('review fixes', () => {
  const view: View = { mirror: false, width: 1280, height: 720 }

  it('a pen grip (fist shape, thumb tip on the index tip) is a pinch', () => {
    const t = new GestureTracker(view)
    const lm = makeHand(POSES.fist)
    lm[4] = { ...lm[8]! }
    const { hands } = t.update([{ landmarks: lm, side: 'Right', builtin: null }], 0)
    expect(hands[0]!.pinching).toBe(true)
  })

  it('only gestures that a rule uses request burst tracking', () => {
    const t = new GestureTracker(view)
    t.setUsedGestures(new Set(['ThumbUp']))
    const fist = { landmarks: makeHand(POSES.fist), side: 'Right' as const, builtin: { name: 'Closed_Fist', score: 0.9 } }
    expect(t.update([fist], 0).burst).toBe(false)
    t.setUsedGestures(new Set(['Fist']))
    expect(t.update([fist], 33).burst).toBe(true)
  })

  it('long holds (Pray, OpenPalm) do not burst', () => {
    const t = new GestureTracker(view)
    const palm = { landmarks: makeHand(POSES.openPalm), side: 'Right' as const, builtin: { name: 'Open_Palm', score: 0.9 } }
    expect(t.update([palm], 0).burst).toBe(false)
  })
})
