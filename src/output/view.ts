import type { HandSide, Point } from '../shared/types'

/**
 * How a window presents the camera. `mirror` is the single switch: it flips the camera
 * sprite and every landmark/effect coordinate together, so effects land on your hand.
 * Phase 2: the Output window uses mirror: false, the Control preview mirror: true.
 */
export interface View {
  mirror: boolean
  width: number
  height: number
}

export const OUTPUT_VIEW: View = { mirror: true, width: 1280, height: 720 }

/** Normalized camera coordinates (0–1, raw camera orientation) → screen pixels for this view. */
export function toScreen(view: View, p: { x: number; y: number }): Point {
  return { x: (view.mirror ? 1 - p.x : p.x) * view.width, y: p.y * view.height }
}

/**
 * MediaPipe labels handedness as if the input were a mirrored selfie image. We always feed
 * it the raw camera frame (mirroring is display-only), so its labels are swapped.
 */
export function correctHandedness(label: string): HandSide {
  return label === 'Left' ? 'Right' : 'Left'
}
