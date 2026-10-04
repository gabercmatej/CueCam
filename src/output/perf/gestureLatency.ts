/**
 * End-to-end gesture latency, split into the parts we can measure:
 *   camera   capture → frame callback (rVFC captureTime; the camera + capture pipeline)
 *   hold     first detection → the result that completed the stabilizer hold (deliberate)
 *   worker   frame callback → hands result applied on the main thread (frame grab + tracking + post)
 *   render   result applied → the frame with the effect rendered (waits for the next tick)
 *   display  rendered → on screen, estimated as one render interval (compositor + vsync)
 * Total = camera + hold + worker + render + display: "hand forms the gesture" → "effect visible".
 */
import { RollingAverage } from '../debug/fpsMeter'

export interface LatencySample {
  gesture: string
  camera: number
  hold: number
  worker: number
  render: number
  display: number
  total: number
}

const PARTS = ['camera', 'hold', 'worker', 'render', 'display', 'total'] as const
type Part = (typeof PARTS)[number]

interface Pending {
  gesture: string
  heldFrom: number
  at: number
  appliedAt: number
  camera: number
}

export class GestureLatency {
  /** The most recent measured gesture. */
  last: LatencySample | null = null
  readonly avg: Record<Part, RollingAverage> = {
    camera: new RollingAverage(20),
    hold: new RollingAverage(20),
    worker: new RollingAverage(20),
    render: new RollingAverage(20),
    display: new RollingAverage(20),
    total: new RollingAverage(20)
  }
  private pending: Pending[] = []
  count = 0

  /** A gesture event fired from a result applied at `appliedAt`; `camera` is the current capture → callback lag. */
  fired(gesture: string, heldFrom: number, at: number, appliedAt: number, camera: number): void {
    this.pending.push({ gesture, heldFrom, at, appliedAt, camera })
  }

  /** After each render: completes the pending measurements. */
  rendered(now: number, frameInterval: number): void {
    if (this.pending.length === 0) return
    for (const p of this.pending) {
      const s: LatencySample = {
        gesture: p.gesture,
        camera: p.camera,
        hold: p.at - p.heldFrom,
        worker: p.appliedAt - p.at,
        render: now - p.appliedAt,
        display: frameInterval,
        total: 0
      }
      s.total = s.camera + s.hold + s.worker + s.render + s.display
      for (const k of PARTS) this.avg[k].push(s[k])
      this.last = s
      this.count++
    }
    this.pending.length = 0
  }

  /** "ThumbUp 142 ms = camera 35 + hold 100 + …" for the Control window. */
  describe(s: LatencySample | null = this.last): string {
    if (!s) return 'no gesture yet'
    const r = (v: number): string => v.toFixed(0)
    return `${s.gesture} ${r(s.total)} ms = camera ${r(s.camera)} + hold ${r(s.hold)} + worker ${r(s.worker)} + render ${r(s.render)} + display ${r(s.display)}`
  }

  averages(): Record<Part, number> {
    return {
      camera: this.avg.camera.value,
      hold: this.avg.hold.value,
      worker: this.avg.worker.value,
      render: this.avg.render.value,
      display: this.avg.display.value,
      total: this.avg.total.value
    }
  }
}
