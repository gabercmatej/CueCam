/** A face box in normalized raw camera coordinates (0–1, top-left origin, not mirrored). */
export interface FaceBox {
  x: number
  y: number
  width: number
  height: number
}

export interface FaceState {
  box: FaceBox
  /** False while the face is lost but the last box is still held (e.g. a hand covering it). */
  visible: boolean
  /** When the face was last actually detected. */
  seenAt: number
}

export const FACE_TUNING = {
  /** Smoothing time constant: the box covers ~63% of a move in this time. */
  tauMs: 90,
  /** Keep the last box this long after the face is lost (occlusion, e.g. facepalm). */
  holdMs: 1200,
  /** A centre jump over this share of the frame is a different face or a re-acquire: snap, don't glide. */
  jump: 0.25
}

/**
 * Smooths face detections (~10 per second) into a steady box and holds the last known box for
 * a while when the face disappears, because a hand in front of the face is exactly when an
 * effect wants to know where the face was.
 */
export class FaceSmoother {
  private state: FaceState | null = null
  private readonly box: FaceBox = { x: 0, y: 0, width: 0, height: 0 }
  private lastAt = -Infinity

  /** One detection result: the most prominent face, or null when none was found. */
  observe(face: FaceBox | null, at: number): void {
    const dt = at - this.lastAt
    this.lastAt = at
    if (!face) {
      if (this.state) this.state.visible = false
      return
    }
    const b = this.box
    const jumped =
      !this.state ||
      Math.hypot(face.x + face.width / 2 - (b.x + b.width / 2), face.y + face.height / 2 - (b.y + b.height / 2)) > FACE_TUNING.jump
    const k = jumped || !(this.state?.visible ?? false) ? 1 : 1 - Math.exp(-Math.max(0, dt) / FACE_TUNING.tauMs)
    b.x += (face.x - b.x) * k
    b.y += (face.y - b.y) * k
    b.width += (face.width - b.width) * k
    b.height += (face.height - b.height) * k
    this.state = { box: b, visible: true, seenAt: at }
  }

  /** The current face (held through short losses), or null once it has been gone too long. */
  get(now: number): FaceState | null {
    if (!this.state) return null
    if (!this.state.visible && now - this.state.seenAt > FACE_TUNING.holdMs) this.state = null
    return this.state
  }
}
