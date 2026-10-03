/**
 * Pure landmark geometry for one hand (MediaPipe's 21-point model:
 * 0 wrist · 1–4 thumb · 5–8 index · 9–12 middle · 13–16 ring · 17–20 pinky).
 * Distances are in frame-height units with x/z corrected for aspect, and normalized
 * by hand scale s = dist(0, 9) so thresholds hold near and far from the camera.
 */

export interface Landmark {
  x: number
  y: number
  z: number
}

export type FingerState = 'ext' | 'curl' | 'half'
export type ThumbState = 'out' | 'tucked' | 'half'

export interface FingerStates {
  thumb: ThumbState
  index: FingerState
  middle: FingerState
  ring: FingerState
  pinky: FingerState
}

export interface HandGeometry {
  /** dist(0, 9) in frame-height units. */
  scale: number
  fingers: FingerStates
  /** dist(thumb tip, index tip) / scale. */
  pinch: number
  /** Palm center in normalized raw camera coordinates. */
  palm: { x: number; y: number }
  /** Landmarks in frame-height units (aspect-corrected). */
  points: Landmark[]
  /** The input landmarks, normalized raw camera coordinates. */
  raw: Landmark[]
}

/** Tunables (Phase 4 tuning lives here). */
export const GEOMETRY = {
  /** Finger straightness dist(mcp, tip) / bone length above which a finger counts as extended. */
  extended: 0.8,
  /** …and below which it counts as curled. */
  curled: 0.6,
  /** Thumb tip within this distance (÷ s) of the middle/ring base = tucked. */
  thumbTucked: 0.5,
  /** Thumb tip at least this far (÷ s) from the index knuckle, and straight, = out. */
  thumbOut: 0.55
}

const FINGERS = { index: [5, 6, 7, 8], middle: [9, 10, 11, 12], ring: [13, 14, 15, 16], pinky: [17, 18, 19, 20] } as const

export function dist(a: Landmark, b: Landmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

const at = (pts: Landmark[], i: number): Landmark => pts[i]!

function fingerState(pts: Landmark[], [mcp, pip, dip, tip]: readonly [number, number, number, number]): FingerState {
  const bones = dist(at(pts, mcp), at(pts, pip)) + dist(at(pts, pip), at(pts, dip)) + dist(at(pts, dip), at(pts, tip))
  const straightness = dist(at(pts, mcp), at(pts, tip)) / bones
  const tipBeyondPip = dist(at(pts, 0), at(pts, tip)) > dist(at(pts, 0), at(pts, pip))
  if (straightness > GEOMETRY.extended && tipBeyondPip) return 'ext'
  if (straightness < GEOMETRY.curled || !tipBeyondPip) return 'curl'
  return 'half'
}

function thumbState(pts: Landmark[], s: number): ThumbState {
  const tip = at(pts, 4)
  const nearPalm = Math.min(...[9, 10, 13, 14].map((i) => dist(tip, at(pts, i)))) / s
  if (nearPalm < GEOMETRY.thumbTucked) return 'tucked'
  const straightness = dist(at(pts, 2), tip) / (dist(at(pts, 2), at(pts, 3)) + dist(at(pts, 3), tip))
  const away = dist(tip, at(pts, 5)) / s
  if (straightness > GEOMETRY.extended && away > GEOMETRY.thumbOut) return 'out'
  return 'half'
}

export function analyzeHand(landmarks: Landmark[], aspect: number): HandGeometry {
  const points = landmarks.map((p) => ({ x: p.x * aspect, y: p.y, z: p.z * aspect }))
  const scale = dist(at(points, 0), at(points, 9))
  const palmIdx = [0, 5, 9, 13, 17]
  return {
    scale,
    points,
    raw: landmarks,
    fingers: {
      thumb: thumbState(points, scale),
      index: fingerState(points, FINGERS.index),
      middle: fingerState(points, FINGERS.middle),
      ring: fingerState(points, FINGERS.ring),
      pinky: fingerState(points, FINGERS.pinky)
    },
    pinch: dist(at(points, 4), at(points, 8)) / scale,
    palm: {
      x: palmIdx.reduce((a, i) => a + landmarks[i]!.x, 0) / palmIdx.length,
      y: palmIdx.reduce((a, i) => a + landmarks[i]!.y, 0) / palmIdx.length
    }
  }
}
