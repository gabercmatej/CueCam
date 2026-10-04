/**
 * Temporal smoothing for the segmentation mask, run in the worker. The selfie model's
 * confidence flickers at the edges from frame to frame; an exponential moving average per
 * pixel calms it, and the result is quantized to bytes for a small transfer and an r8 texture.
 * Cost: one pass over ~37k pixels (256×144), well under 0.1 ms.
 */
export class MaskSmoother {
  private acc: Float32Array | null = null
  private width = 0
  private height = 0
  private lastAt = -Infinity

  constructor(
    /** Weight of the newest mask (1 = no smoothing). */
    public alpha = 0.6,
    /** After a gap this long the old mask is stale: start over instead of blending a ghost. */
    private readonly resetMs = 400
  ) {}

  /** Confidence 0–1 per pixel → smoothed bytes. Returns a new buffer each time (it is transferred). */
  push(confidence: Float32Array, width: number, height: number, at: number): Uint8Array {
    const n = width * height
    const fresh = !this.acc || width !== this.width || height !== this.height || at - this.lastAt > this.resetMs
    this.lastAt = at
    if (fresh) {
      this.acc = new Float32Array(n)
      this.acc.set(confidence.subarray(0, n))
      this.width = width
      this.height = height
    }
    const acc = this.acc!
    const out = new Uint8Array(n)
    const a = this.alpha
    for (let i = 0; i < n; i++) {
      const v = fresh ? acc[i]! : (acc[i] = acc[i]! + (confidence[i]! - acc[i]!) * a)
      out[i] = v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0
    }
    return out
  }
}
