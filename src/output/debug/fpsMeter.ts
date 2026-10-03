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
}

/** Mean of the last `size` samples, e.g. per-stage timings in ms. */
export class RollingAverage {
  private samples: number[] = []

  constructor(private readonly size = 30) {}

  push(value: number): void {
    this.samples.push(value)
    if (this.samples.length > this.size) this.samples.shift()
  }

  get value(): number {
    if (this.samples.length === 0) return 0
    return this.samples.reduce((a, b) => a + b, 0) / this.samples.length
  }
}
