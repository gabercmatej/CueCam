/** Frames per second over a sliding 1 s window. */
export class FpsMeter {
  private times: number[] = []

  tick(now: number): void {
    this.times.push(now)
    const cutoff = now - 1000
    while (this.times.length > 2 && this.times[0]! < cutoff) this.times.shift()
  }

  get fps(): number {
    const n = this.times.length
    if (n < 2) return 0
    const span = this.times[n - 1]! - this.times[0]!
    return span > 0 ? ((n - 1) * 1000) / span : 0
  }

  /** The rate as of `now`: 0 once no tick arrived for a second (`fps` alone keeps the last rate forever). */
  fpsAt(now: number): number {
    const last = this.times[this.times.length - 1]
    return last === undefined || now - last > 1000 ? 0 : this.fps
  }
}

/** Mean of the last `size` samples, e.g. per-stage timings in ms. O(1) per sample, no allocations. */
export class RollingAverage {
  private readonly samples: Float64Array
  private next = 0
  private count = 0
  private sum = 0

  constructor(size = 30) {
    this.samples = new Float64Array(size)
  }

  push(value: number): void {
    if (this.count === this.samples.length) this.sum -= this.samples[this.next]!
    else this.count++
    this.samples[this.next] = value
    this.sum += value
    this.next = (this.next + 1) % this.samples.length
  }

  get value(): number {
    return this.count ? this.sum / this.count : 0
  }
}
