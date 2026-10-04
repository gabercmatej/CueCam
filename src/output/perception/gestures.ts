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
  /** How long a gesture must be seen before it fires (ms of camera time, whatever the tracking stride). */
  holdMs: 100,
  /** Per-gesture holds. Fist is the confetti trigger and must feel instant; OpenPalm only completes the fire
   * combo (a word follows anyway), so it waits long enough for a second hand to turn it into BothHandsUp. */
  holdMsBy: { Fist: 66, OpenPalm: 250, Pray: 500, PalmPush: 0, Clap: 0 } as Partial<Record<GestureName, number>>,
  /** A fired gesture must be gone this long before it can fire again. */
  releaseMs: 330,
  pinchEnter: 0.25,
  /** In a fist shape, only thumb and index tips closer than this (÷ s) count as a pinch. */
  fistPinchMax: 0.15,
  pinchExit: 0.35,
  pushGrowth: 1.25,
  pushWindowMs: 300,
  /** Thumb tip this far (÷ s) above the thumb MCP counts as "thumb up" for FingerGun. */
  gunThumbUp: 0.25,
  /** Max distance (÷ mean hand scale) between the two thumb tips and the two index tips for Heart. */
  heartTouch: 0.4,
  /** Pray: palm centres, index tips and middle tips within these distances (÷ s). */
  prayPalmGap: 1.0,
  prayTipGap: 0.7,
  /** Pray: middle fingertips at least this far (÷ s) above the wrists (fingers up). */
  prayFingersUp: 1.0,
  /** Pray: the hands' midpoint may drift at most this fast (÷ s per second, smoothed): "still". */
  prayMaxSpeed: 1.2,
  /** Pray is not a clap that stayed together: no Pray this soon after a Clap. */
  prayAfterClapMs: 1000,
  /** Clap: palms closing faster than this (÷ s per second) count as a clap approach… */
  clapSpeed: 4,
  /** …and meeting (palm gap ÷ s below this) within this long after the fast approach fires Clap. */
  clapContact: 1.1,
  clapWindowMs: 300,
  /** Clap: hands this close that then merge into one detection (occlusion at contact) also count. */
  clapMergeGap: 2,
  /** BothHandsUp: palm centres at least this far apart (÷ s). */
  handsUpMinGap: 1.5,
  /** Burst tracking: hands are tracked on every frame this long after a gesture starts pending. */
  burstMs: 150,
  /** Holds this long or longer don't burst: sampling them every stride costs little relative latency. */
  burstMaxHoldMs: 200
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

/** Camera frame interval at 30 fps: the timestamp jitter allowance and sample counts are based on it. */
const FRAME_MS = 1000 / 30
/** Timestamp jitter allowance. */
const JITTER_MS = FRAME_MS / 4
/** Detections a hold needs at most, however far apart samples are (stride 4 under load). */
const MIN_SAMPLES = 3
/** A longer gap between samples (tracker stall) breaks a hold: nobody saw the gesture in between. */
const MAX_GAP_MS = 250

/** Detections a hold of `holdMs` needs: one per frame of the hold at 30 fps, at most 3 (0 ms = one detection). */
export const samplesFor = (holdMs: number): number => (holdMs <= 0 ? 1 : Math.min(MIN_SAMPLES, 1 + Math.round(holdMs / FRAME_MS)))

/**
 * Turns presence samples into one-shot firings: a key must be present for `holdMs` of camera
 * time to fire, then absent for `releaseMs` before it can fire again. Measured in time, so the
 * tracking stride (every 2nd or 3rd frame, or every frame while bursting) doesn't change how long
 * you hold a gesture, only how finely the hold is sampled. A hold also needs a few detections
 * (`samplesFor`), so a sparse stride can't fire on a single misclassification.
 */
export class Stabilizer {
  private state = new Map<string, { since: number | null; samples: number; lastSeen: number; fired: boolean }>()
  private readonly holdFor: (key: string) => number
  /** A key that may request burst tracking was present but hasn't fired yet at the last update. */
  pending = false
  /** Which keys may request burst tracking (default: all). */
  burstable: (key: string) => boolean = () => true

  constructor(
    holdMs = GESTURE_TUNING.holdMs,
    private readonly releaseMs = GESTURE_TUNING.releaseMs,
    holdFor?: (key: string) => number
  ) {
    this.holdFor = holdFor ?? (() => holdMs)
  }

  /** When the current hold of `key` started (camera frame time), if it is being held. */
  startedAt(key: string): number | undefined {
    return this.state.get(key)?.since ?? undefined
  }

  /** Whether `key` has fired and is still being held. */
  isActive(key: string): boolean {
    return this.state.get(key)?.fired === true
  }

  update(present: Set<string>, at: number): string[] {
    const fired: string[] = []
    this.pending = false
    for (const key of present) {
      let s = this.state.get(key)
      if (!s) this.state.set(key, (s = { since: null, samples: 0, lastSeen: at, fired: false }))
      if (at - s.lastSeen > MAX_GAP_MS) s.since = null
      if (s.since === null) {
        s.since = at
        s.samples = 0
      }
      s.samples++
      s.lastSeen = at
      const holdMs = this.holdFor(key)
      if (!s.fired && at - s.since >= holdMs - JITTER_MS && s.samples >= samplesFor(holdMs)) {
        s.fired = true
        fired.push(key)
      }
      if (!s.fired && this.burstable(key)) this.pending = true
    }
    for (const [key, s] of this.state) {
      if (present.has(key)) continue
      s.since = null
      if (at - s.lastSeen >= this.releaseMs - JITTER_MS) this.state.delete(key)
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

/** Both palms pressed together with the fingers up (the pose only; stillness is checked over time). */
export function isPrayPose(a: HandGeometry, b: HandGeometry): boolean {
  const s = (a.scale + b.scale) / 2
  const pa = a.points
  const pb = b.points
  const palm = (g: HandGeometry): { x: number; y: number } => {
    let x = 0
    let y = 0
    for (const i of [0, 5, 9, 13, 17]) {
      x += g.points[i]!.x
      y += g.points[i]!.y
    }
    return { x: x / 5, y: y / 5 }
  }
  const ca = palm(a)
  const cb = palm(b)
  if (Math.hypot(ca.x - cb.x, ca.y - cb.y) / s > GESTURE_TUNING.prayPalmGap) return false
  if (dist(pa[8]!, pb[8]!) / s > GESTURE_TUNING.prayTipGap) return false
  if (dist(pa[12]!, pb[12]!) / s > GESTURE_TUNING.prayTipGap) return false
  // Image y grows downward: fingertips well above the wrists.
  return (pa[0]!.y - pa[12]!.y) / s > GESTURE_TUNING.prayFingersUp && (pb[0]!.y - pb[12]!.y) / s > GESTURE_TUNING.prayFingersUp
}

/** Palm gap between two hands in mean hand scales (aspect-corrected). */
function palmGap(a: HandGeometry, b: HandGeometry, aspect: number): number {
  const s = (a.scale + b.scale) / 2
  return Math.hypot((a.palm.x - b.palm.x) * aspect, a.palm.y - b.palm.y) / s
}

/**
 * Clap: palms closing fast, then meeting (or merging into one detection, as MediaPipe often loses
 * one hand at contact). Fires once per contact. Distinct from Pray, which needs the hands still.
 */
export class ClapDetector {
  private lastGap: number | null = null
  private lastAt = 0
  private lastMid: { x: number; y: number } | null = null
  /** A fast approach was seen; contact before this time is a clap. */
  approachUntil = -Infinity
  private clapped = false

  /** Two hands this sample: their palm gap (÷ s) and midpoint (normalized raw). Returns the clap point on contact. */
  update(gap: number | null, midpoint: { x: number; y: number } | null, at: number): { x: number; y: number } | null {
    if (gap === null || !midpoint) {
      // Hands merged into one detection right after a fast approach while already close: contact.
      const merged = this.lastGap !== null && this.lastGap < GESTURE_TUNING.clapMergeGap && at <= this.approachUntil && !this.clapped
      const point = merged ? this.lastMid : null
      if (merged) this.clapped = true
      this.lastGap = null
      return point
    }
    if (this.lastGap !== null && at > this.lastAt) {
      const speed = ((this.lastGap - gap) * 1000) / (at - this.lastAt)
      if (speed > GESTURE_TUNING.clapSpeed) this.approachUntil = at + GESTURE_TUNING.clapWindowMs
    }
    this.lastGap = gap
    this.lastAt = at
    this.lastMid = midpoint
    if (gap > GESTURE_TUNING.clapContact * 1.5) this.clapped = false
    if (gap < GESTURE_TUNING.clapContact && at <= this.approachUntil && !this.clapped) {
      this.clapped = true
      return midpoint
    }
    return null
  }

  /** Hands are approaching fast: a contact may be imminent (track every frame). */
  approaching(at: number): boolean {
    return at <= this.approachUntil && !this.clapped
  }
}

/** Smoothed speed of the two hands' midpoint (÷ s per second), for Pray's stillness. */
class Stillness {
  private last: { x: number; y: number; at: number } | null = null
  speed = Infinity

  update(p: { x: number; y: number } | null, scale: number, aspect: number, at: number): number {
    if (!p) {
      this.last = null
      this.speed = Infinity
      return this.speed
    }
    if (this.last && at > this.last.at) {
      const v = (Math.hypot((p.x - this.last.x) * aspect, p.y - this.last.y) / scale / (at - this.last.at)) * 1000
      this.speed = Number.isFinite(this.speed) ? this.speed + (v - this.speed) * 0.5 : v
    }
    this.last = { x: p.x, y: p.y, at }
    return this.speed
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

const holdFor = (key: string): number => {
  const gesture = key.slice(0, key.indexOf(':')) as GestureName
  return GESTURE_TUNING.holdMsBy[gesture] ?? GESTURE_TUNING.holdMs
}

export interface GestureUpdate {
  hands: HandState[]
  /** Gestures that fired on this result. */
  events: GestureEvent[]
  /** Gestures that fired earlier and are still held (a word can complete a combo with them). */
  active: GestureEvent[]
  /** A gesture is about to fire (pending hold or a fast clap approach): track every frame for a moment. */
  burst: boolean
}

export class GestureTracker {
  private readonly stabilizer = new Stabilizer(GESTURE_TUNING.holdMs, GESTURE_TUNING.releaseMs, holdFor)
  private readonly pinch = { Left: new PinchLatch(), Right: new PinchLatch() }
  private readonly push = { Left: new PalmPushDetector(), Right: new PalmPushDetector() }
  private readonly clap = new ClapDetector()
  private readonly still = new Stillness()
  private lastClapAt = -Infinity
  private readonly aspect: number
  /** Gestures some rule uses: only those burst (label flicker on unused gestures must not keep the worker at full rate). */
  private used: ReadonlySet<GestureName> | null = null

  constructor(private readonly view: View) {
    this.aspect = view.width / view.height
    this.stabilizer.burstable = (key) => {
      const gesture = key.slice(0, key.indexOf(':')) as GestureName
      return holdFor(key) < GESTURE_TUNING.burstMaxHoldMs && (this.used === null || this.used.has(gesture))
    }
  }

  /** The gestures the config's rules use (null = all). */
  setUsedGestures(used: ReadonlySet<GestureName> | null): void {
    this.used = used
  }

  update(input: RawHand[], at: number): GestureUpdate {
    const raw = assignSides(input)
    const present = new Set<string>()
    const where = new Map<string, Point>()
    const mark = (key: string, p: Point): void => {
      present.add(key)
      where.set(key, p)
    }

    const geometries: HandGeometry[] = []
    const labels: (GestureName | null)[] = []
    const hands = raw.map((h): HandState => {
      const g = analyzeHand(h.landmarks, this.aspect)
      geometries.push(g)
      const label = classifyHand(g, h.builtin)
      labels.push(label)
      const palm = toScreen(this.view, g.palm)
      // A fist's thumb rests on the curled index finger, about pinch distance (≈0.27): a loose
      // contact in a fist shape isn't a pinch. A pen grip (index folded onto the thumb tip, other
      // fingers folded) also looks fist-shaped, so tight tip-to-tip contact still counts.
      const fistShaped = g.fingers.index === 'curl' && g.fingers.middle === 'curl' && g.fingers.ring === 'curl'
      const pinching = this.pinch[h.side].update(fistShaped && g.pinch > GESTURE_TUNING.fistPinchMax ? Infinity : g.pinch)
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

    // Two-hand gestures. They decide what the single-hand labels may still mean.
    let bothUp = false
    let praying = false
    const [ga, gb] = geometries
    if (ga && gb) {
      const s = (ga.scale + gb.scale) / 2
      const gap = palmGap(ga, gb, this.aspect)
      const midpoint = { x: (ga.palm.x + gb.palm.x) / 2, y: (ga.palm.y + gb.palm.y) / 2 }
      const clapAt = this.clap.update(gap, midpoint, at)
      if (clapAt) {
        this.lastClapAt = at
        mark('Clap:Both', toScreen(this.view, clapAt))
      }
      const speed = this.still.update(midpoint, s, this.aspect, at)
      praying = isPrayPose(ga, gb)
      if (praying && speed < GESTURE_TUNING.prayMaxSpeed && at - this.lastClapAt > GESTURE_TUNING.prayAfterClapMs) {
        mark('Pray:Both', toScreen(this.view, midpoint))
      }
      bothUp = labels[0] === 'OpenPalm' && labels[1] === 'OpenPalm' && gap > GESTURE_TUNING.handsUpMinGap
      if (bothUp) mark('BothHandsUp:Both', toScreen(this.view, midpoint))
      // Palms pressed together also look like a finger heart (index tips and thumbs touching).
      const heart = praying ? null : detectHeart(ga, gb)
      if (heart) mark('Heart:Both', toScreen(this.view, heart))
    } else {
      const clapAt = this.clap.update(null, null, at)
      if (clapAt) {
        this.lastClapAt = at
        mark('Clap:Both', toScreen(this.view, clapAt))
      }
      this.still.update(null, 1, this.aspect, at)
    }

    raw.forEach((h, i) => {
      const label = labels[i]
      // Two open palms are BothHandsUp, never a one-hand OpenPalm (which would start the fire combo).
      if (label && !(bothUp && label === 'OpenPalm')) mark(`${label}:${h.side}`, hands[i]!.palm)
    })

    const event = (key: string, fresh: boolean): GestureEvent => {
      const [gesture, hand] = key.split(':') as [GestureName, HandSide | 'Both']
      const e: GestureEvent = { type: 'gesture', gesture, hand, position: where.get(key)!, at }
      if (fresh) e.heldFrom = this.stabilizer.startedAt(key) ?? at
      return e
    }
    const fired = this.stabilizer.update(present, at)
    const events = fired.map((key) => event(key, true))
    const active: GestureEvent[] = []
    for (const key of present) if (this.stabilizer.isActive(key) && !fired.includes(key)) active.push(event(key, false))
    return { hands, events, active, burst: this.stabilizer.pending || this.clap.approaching(at) }
  }
}
