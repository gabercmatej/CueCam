/**
 * Maps the audio clock (context time) to performance.now. Each worklet message carries the context
 * time it was posted at; it arrives some delivery delay later (one hop, more while the main thread is
 * busy). The smallest observed `arrival − contextTime` is the offset with the least delay in it, so a
 * running minimum filters the delivery jitter out. The minimum creeps up slowly to follow clock drift;
 * a jump far beyond any delivery delay (the context was suspended and resumed) resets it.
 */
const JUMP_MS = 500

export class ClockOffset {
  private offset: number | null = null
  private lastAt = 0

  constructor(
    /** How fast the minimum may rise, ms per second (follows drift; must exceed it). */
    private readonly creepMsPerS = 2
  ) {}

  /** A message posted at audio time `contextTime` (s) arrived at `arrival` (performance.now, ms). */
  observe(contextTime: number, arrival: number): void {
    const sample = arrival - contextTime * 1000
    if (this.offset === null || sample > this.offset + JUMP_MS) this.offset = sample
    else this.offset = Math.min(sample, this.offset + ((arrival - this.lastAt) / 1000) * this.creepMsPerS)
    this.lastAt = arrival
  }

  /** Audio time (ms) → performance.now (ms). */
  toPerformance(contextMs: number): number {
    return contextMs + (this.offset ?? 0)
  }
}
