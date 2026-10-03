/**
 * Synthetic MediaPipe hand landmarks for tests. Poses are built upright in "hand units"
 * (wrist at origin, dist(0, 9) ≈ 1, y up = negative), then rotated, scaled and placed
 * in normalized camera coordinates for a 16:9 frame.
 */
import type { Landmark } from '../handGeometry'

export type FingerPose = 'ext' | 'curl'
export type ThumbPose = 'out' | 'tucked'

export interface HandPose {
  thumb: ThumbPose
  index: FingerPose
  middle: FingerPose
  ring: FingerPose
  pinky: FingerPose
}

export interface Placement {
  /** Wrist position, normalized (0–1). */
  wrist?: { x: number; y: number }
  /** dist(0, 9) as a fraction of frame height. */
  size?: number
  /** Clockwise rotation in degrees (90 = fingers point right in the raw camera image). */
  rotate?: number
}

const ASPECT = 16 / 9
const FINGER_X = { index: -0.3, middle: -0.1, ring: 0.1, pinky: 0.3 }
const MCP = { index: 5, middle: 9, ring: 13, pinky: 17 } as const

function finger(x: number, pose: FingerPose): [number, number, number][] {
  if (pose === 'ext') return [[x, -1, 0], [x, -1.4, 0], [x, -1.7, 0], [x, -1.95, 0]]
  // Curled: up to the PIP, then folded back down toward the palm (and toward the camera).
  return [[x, -1, 0], [x, -1.35, -0.1], [x, -1.1, -0.25], [x, -0.85, -0.15]]
}

function thumb(pose: ThumbPose): [number, number, number][] {
  if (pose === 'out') return [[-0.35, -0.25, 0], [-0.6, -0.45, 0], [-0.85, -0.65, 0], [-1.05, -0.85, 0]]
  // Tucked across the curled middle/ring fingers.
  return [[-0.35, -0.25, 0], [-0.6, -0.45, -0.1], [-0.4, -0.7, -0.2], [-0.05, -0.85, -0.25]]
}

export function makeHand(pose: HandPose, at: Placement = {}): Landmark[] {
  const pts: [number, number, number][] = new Array(21)
  pts[0] = [0, 0, 0]
  thumb(pose.thumb).forEach((p, i) => (pts[1 + i] = p))
  for (const name of ['index', 'middle', 'ring', 'pinky'] as const) {
    finger(FINGER_X[name], pose[name]).forEach((p, i) => (pts[MCP[name] + i] = p))
  }

  const { wrist = { x: 0.5, y: 0.75 }, size = 0.25, rotate = 0 } = at
  const r = (rotate * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  return pts.map(([hx, hy, hz]) => {
    const rx = hx * cos - hy * sin
    const ry = hx * sin + hy * cos
    return { x: wrist.x + (rx * size) / ASPECT, y: wrist.y + ry * size, z: (hz * size) / ASPECT }
  })
}

export const POSES = {
  rock: { thumb: 'tucked', index: 'ext', middle: 'curl', ring: 'curl', pinky: 'ext' },
  iLoveYou: { thumb: 'out', index: 'ext', middle: 'curl', ring: 'curl', pinky: 'ext' },
  fingerGun: { thumb: 'out', index: 'ext', middle: 'curl', ring: 'curl', pinky: 'curl' },
  pointing: { thumb: 'tucked', index: 'ext', middle: 'curl', ring: 'curl', pinky: 'curl' },
  openPalm: { thumb: 'out', index: 'ext', middle: 'ext', ring: 'ext', pinky: 'ext' },
  fist: { thumb: 'tucked', index: 'curl', middle: 'curl', ring: 'curl', pinky: 'curl' }
} satisfies Record<string, HandPose>
