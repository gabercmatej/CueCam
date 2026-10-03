/**
 * Predicts hand landmarks between tracking results, so hand-anchored effects and the
 * overlay move on every camera frame even when tracking runs every 2nd or 3rd frame or a
 * result arrives late. Constant-velocity model per landmark, velocity smoothed over results,
 * prediction clamped to a short horizon so a lost hand never flies off.
 */
import type { HandSide } from '../../shared/types'
import type { Landmark } from './handGeometry'

export interface TrackedHand {
  side: HandSide
  /** Normalized raw camera coordinates. */
  landmarks: Landmark[]
}

export interface SmootherOptions {
  /** Max extrapolation past the newest result. */
  maxAheadMs: number
  /** Weight of the newest velocity sample (1 = no smoothing). */
  velocitySmoothing: number
  /** A wrist jump larger than this (normalized) between results is a swap or re-detection, not motion. */
  maxJump: number
  /** A hand with no result for this long is dropped (tracker stalled or failed). */
  expireMs: number
}

const POINTS = 21

interface Track {
  at: number
  /** x, y, z per landmark. */
  pos: Float64Array
  vel: Float64Array
  hasVelocity: boolean
  /** Reused output (valid until the next predict). */
  out: TrackedHand
}

export class HandSmoother {
  private readonly tracks = new Map<HandSide, Track>()
  private readonly opts: SmootherOptions
  private readonly output: TrackedHand[] = []

  constructor(opts: Partial<SmootherOptions> = {}) {
    this.opts = { maxAheadMs: 100, velocitySmoothing: 0.6, maxJump: 0.15, expireMs: 500, ...opts }
  }

  observe(hands: TrackedHand[], at: number): void {
    for (const side of this.tracks.keys()) {
      if (!hands.some((h) => h.side === side)) this.tracks.delete(side)
    }
    for (const hand of hands) {
      const track = this.tracks.get(hand.side)
      if (!track) {
        this.tracks.set(hand.side, newTrack(hand, at))
        continue
      }
      const dt = at - track.at
      if (dt <= 0) continue
      const wrist = hand.landmarks[0]!
      if (Math.hypot(wrist.x - track.pos[0]!, wrist.y - track.pos[1]!) > this.opts.maxJump) {
        // Restart the track here instead of turning the jump into a velocity.
        this.tracks.set(hand.side, newTrack(hand, at))
        continue
      }
      const a = track.hasVelocity ? this.opts.velocitySmoothing : 1
      for (let i = 0; i < POINTS; i++) {
        const p = hand.landmarks[i]!
        writeAxis(track, i * 3, p.x, dt, a)
        writeAxis(track, i * 3 + 1, p.y, dt, a)
        writeAxis(track, i * 3 + 2, p.z, dt, a)
      }
      track.hasVelocity = true
      track.at = at
    }
  }

  /** Landmarks predicted for time `at`. The returned objects are reused by the next call. */
  predict(at: number): TrackedHand[] {
    this.output.length = 0
    for (const [side, track] of this.tracks) {
      if (at - track.at >= this.opts.expireMs) {
        this.tracks.delete(side)
        continue
      }
      const ahead = track.hasVelocity ? Math.min(Math.max(at - track.at, 0), this.opts.maxAheadMs) : 0
      const { pos, vel, out } = track
      for (let i = 0; i < POINTS; i++) {
        const lm = out.landmarks[i]!
        const k = i * 3
        lm.x = pos[k]! + vel[k]! * ahead
        lm.y = pos[k + 1]! + vel[k + 1]! * ahead
        lm.z = pos[k + 2]! + vel[k + 2]! * ahead
      }
      this.output.push(out)
    }
    return this.output
  }

  reset(): void {
    this.tracks.clear()
  }
}

function newTrack(hand: TrackedHand, at: number): Track {
  const pos = new Float64Array(POINTS * 3)
  hand.landmarks.forEach((p, i) => pos.set([p.x, p.y, p.z], i * 3))
  return {
    at,
    pos,
    vel: new Float64Array(POINTS * 3),
    hasVelocity: false,
    out: { side: hand.side, landmarks: Array.from({ length: POINTS }, () => ({ x: 0, y: 0, z: 0 })) }
  }
}

function writeAxis(track: Track, k: number, value: number, dt: number, a: number): void {
  const v = (value - track.pos[k]!) / dt
  track.vel[k] = track.vel[k]! + (v - track.vel[k]!) * a
  track.pos[k] = value
}
