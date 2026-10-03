/**
 * Our gesture vocabulary on top of MediaPipe: built-in labels are mapped to our names,
 * custom gestures come from landmark geometry, and everything is stabilized before it
 * becomes an event. Rules only ever see names from shared/types GESTURES.
 */
import type { GestureEvent, GestureName, HandSide, Point } from '../../shared/types'
import { toScreen, type View } from '../view'
import { analyzeHand, dist, type FingerStates, type HandGeometry, type Landmark } from './handGeometry'

/** Tunables (Phase 4 tuning lives here). */
export const GESTURE_TUNING = {
  builtinMinScore: 0.6,
  holdFrames: 5,
  releaseFrames: 10,
  pinchEnter: 0.25,
  pinchExit: 0.35,
  pushGrowth: 1.25,
  pushWindowMs: 300,
  /** Thumb tip this far (÷ s) above the thumb MCP counts as "thumb up" for FingerGun. */
  gunThumbUp: 0.25,
  /** Max distance (÷ mean hand scale) between the two thumb tips and the two index tips for Heart. */
  heartTouch: 0.4
}

const BUILTIN: Record<string, GestureName | null> = {
  Thumb_Up: 'ThumbUp',
  Thumb_Down: 'ThumbDown',
  Victory: 'Victory',
  Open_Palm: 'OpenPalm',
  Closed_Fist: 'Fist',
  Pointing_Up: 'PointingUp',
  // MediaPipe also fires this for a rock sign; our geometry decides between Rock and ILoveYou.
  ILoveYou: null,
  None: null
}

export interface BuiltinLabel {
  name: string
  score: number
}

/** One hand's static gesture this frame: geometry-defined gestures first, then mapped built-ins. */
export function classifyHand(g: HandGeometry, builtin: BuiltinLabel | null): GestureName | null {
  const f = g.fingers
  const hornsUp = f.index === 'ext' && f.pinky === 'ext' && f.middle === 'curl' && f.ring === 'curl'
  if (hornsUp && f.thumb === 'out') return 'ILoveYou'
  if (hornsUp && f.thumb !== 'out') return 'Rock'

  const gunGrip = f.index === 'ext' && f.middle === 'curl' && f.ring === 'curl' && f.pinky === 'curl'
  const thumbUp = (g.points[2]!.y - g.points[4]!.y) / g.scale > GESTURE_TUNING.gunThumbUp
  if (gunGrip && f.thumb === 'out' && thumbUp) return 'FingerGun'

  if (!builtin || builtin.score < GESTURE_TUNING.builtinMinScore) return null
  return BUILTIN[builtin.name] ?? null
}

/** Two-hand finger heart. Returns the heart's center (normalized raw camera coords) or null. */
export function detectHeart(a: HandGeometry, b: HandGeometry): { x: number; y: number } | null {
  const s = (a.scale + b.scale) / 2
  const pa = a.points
  const pb = b.points
  if (dist(pa[4]!, pb[4]!) / s > GESTURE_TUNING.heartTouch) return null
  if (dist(pa[8]!, pb[8]!) / s > GESTURE_TUNING.heartTouch) return null
  // Image y grows downward: index tips form the top of the heart, thumbs the point.
  if ((pa[8]!.y + pb[8]!.y) / 2 >= (pa[4]!.y + pb[4]!.y) / 2) return null
  const tips = [a.raw[4]!, b.raw[4]!, a.raw[8]!, b.raw[8]!]
  return { x: tips.reduce((n, p) => n + p.x, 0) / 4, y: tips.reduce((n, p) => n + p.y, 0) / 4 }
}

/**
 * Turns per-frame presence into one-shot firings: a key must be present for `hold`
 * consecutive frames to fire, then absent for `release` frames before it can fire again.
 */
export class Stabilizer {
  private state = new Map<string, { seen: number; absent: number; fired: boolean }>()
  private readonly holdFor: (key: string) => number

  constructor(
    hold = GESTURE_TUNING.holdFrames,
    private readonly release = GESTURE_TUNING.releaseFrames,
    holdFor?: (key: string) => number
  ) {
    this.holdFor = holdFor ?? (() => hold)
  }

  update(present: Set<string>): string[] {
    const fired: string[] = []
    for (const key of present) {
      const s = this.state.get(key) ?? { seen: 0, absent: 0, fired: false }
      s.seen++
      s.absent = 0
      if (!s.fired && s.seen >= this.holdFor(key)) {
        s.fired = true
        fired.push(key)
      }
      this.state.set(key, s)
    }
    for (const [key, s] of this.state) {
      if (present.has(key)) continue
      s.seen = 0
      s.absent++
      if (s.absent >= this.release) this.state.delete(key)
    }
    return fired
  }
}

/** Pinch with hysteresis so a held pinch doesn't flicker (light painting needs unbroken lines). */
export class PinchLatch {
  private pinching = false

  update(pinchDistance: number): boolean {
    if (this.pinching && pinchDistance > GESTURE_TUNING.pinchExit) this.pinching = false
    else if (!this.pinching && pinchDistance < GESTURE_TUNING.pinchEnter) this.pinching = true
    return this.pinching
  }
}

/** Open palm moving toward the camera: hand scale grows by > 25% within 300 ms. */
export class PalmPushDetector {
  private history: { t: number; scale: number }[] = []

  update(openPalm: boolean, scale: number, now: number): boolean {
    if (!openPalm) {
      this.history = []
      return false
    }
    this.history.push({ t: now, scale })
    while (this.history.length && this.history[0]!.t < now - GESTURE_TUNING.pushWindowMs) this.history.shift()
    const smallest = Math.min(...this.history.map((h) => h.scale))
    return scale / smallest > GESTURE_TUNING.pushGrowth
  }
}

export interface RawHand {
  /** Normalized raw camera landmarks from MediaPipe. */
  landmarks: Landmark[]
  /** Corrected handedness (see view.correctHandedness). */
  side: HandSide
  builtin: BuiltinLabel | null
}

/** Per-hand state for overlays and effects, in screen space. */
export interface HandState {
  side: HandSide
  /** Live label this frame (not stabilized). */
  label: GestureName | null
  fingers: FingerStates
  pinching: boolean
  palm: Point
  landmarks: Point[]
}

/**
 * MediaPipe sometimes labels both hands the same side. Per-side state (pinch latch, push
 * history, stabilizer keys) would then mix the two hands, so split them by position: in the
 * raw (unmirrored) frame your right hand is the one further left.
 */
export function assignSides(hands: RawHand[]): RawHand[] {
  const [a, b] = hands
  if (hands.length !== 2 || !a || !b || a.side !== b.side) return hands
  const aIsRight = a.landmarks[0]!.x < b.landmarks[0]!.x
  return [
    { ...a, side: aIsRight ? 'Right' : 'Left' },
    { ...b, side: aIsRight ? 'Left' : 'Right' }
  ]
}

export class GestureTracker {
  private readonly stabilizer = new Stabilizer(GESTURE_TUNING.holdFrames, GESTURE_TUNING.releaseFrames, (key) =>
    key.startsWith('PalmPush') ? 1 : GESTURE_TUNING.holdFrames
  )
  private readonly pinch = { Left: new PinchLatch(), Right: new PinchLatch() }
  private readonly push = { Left: new PalmPushDetector(), Right: new PalmPushDetector() }
  private readonly aspect: number

  constructor(private readonly view: View) {
    this.aspect = view.width / view.height
  }

  update(input: RawHand[], at: number): { hands: HandState[]; events: GestureEvent[] } {
    const raw = assignSides(input)
    const present = new Set<string>()
    const where = new Map<string, Point>()
    const mark = (key: string, p: Point): void => {
      present.add(key)
      where.set(key, p)
    }

    const geometries: HandGeometry[] = []
    const hands = raw.map((h): HandState => {
      const g = analyzeHand(h.landmarks, this.aspect)
      geometries.push(g)
      const label = classifyHand(g, h.builtin)
      const palm = toScreen(this.view, g.palm)
      const pinching = this.pinch[h.side].update(g.pinch)
      if (label) mark(`${label}:${h.side}`, palm)
      if (pinching) {
        const tip = { x: (h.landmarks[4]!.x + h.landmarks[8]!.x) / 2, y: (h.landmarks[4]!.y + h.landmarks[8]!.y) / 2 }
        mark(`Pinch:${h.side}`, toScreen(this.view, tip))
      }
      if (this.push[h.side].update(label === 'OpenPalm', g.scale, at)) mark(`PalmPush:${h.side}`, palm)
      return { side: h.side, label, fingers: g.fingers, pinching, palm, landmarks: h.landmarks.map((p) => toScreen(this.view, p)) }
    })
    // A side that left the frame must not keep a stale pinch or push history.
    for (const side of ['Left', 'Right'] as const) {
      if (!raw.some((h) => h.side === side)) {
        this.pinch[side].update(Infinity)
        this.push[side].update(false, 0, at)
      }
    }

    if (geometries.length === 2) {
      const heart = detectHeart(geometries[0]!, geometries[1]!)
      if (heart) mark('Heart:Both', toScreen(this.view, heart))
    }

    const events = this.stabilizer.update(present).map((key): GestureEvent => {
      const [gesture, hand] = key.split(':') as [GestureName, HandSide | 'Both']
      return { type: 'gesture', gesture, hand, position: where.get(key)!, at }
    })
    return { hands, events }
  }
}
