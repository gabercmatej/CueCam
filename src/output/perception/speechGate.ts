/**
 * Skips Vosk decoding while nobody is speaking. Vosk decodes every chunk it gets, and that
 * CPU competes with hand tracking; during silence there is nothing to recognize. The gate
 * opens when the mic peak rises clearly above the room's noise floor, replays a short
 * pre-roll so the start of the word isn't lost, and keeps feeding for a hangover after
 * speech so Vosk can close the utterance. Failure mode is "open" (feeds everything).
 */
export interface SpeechGateOptions {
  enabled: boolean
  /** Chunks kept while closed and replayed on open (~100 ms each). */
  preRoll: number
  /** Quiet chunks still fed after the last loud one. */
  hangover: number
  /** Open when the peak exceeds the noise floor × this… */
  openFactor: number
  /** …and at least this absolute peak. */
  minOpen: number
}

const DEFAULTS: SpeechGateOptions = { enabled: true, preRoll: 4, hangover: 10, openFactor: 2.5, minOpen: 0.02 }

export class SpeechGate<T> {
  private readonly opts: SpeechGateOptions
  private readonly ring: T[] = []
  private floor: number | null = null
  private hangoverLeft = -1

  constructor(opts: Partial<SpeechGateOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts }
  }

  get open(): boolean {
    return this.hangoverLeft >= 0
  }

  /** Returns the chunks to feed now, oldest first (empty while closed). */
  push(chunk: T, peak: number): T[] {
    if (!this.opts.enabled) return [chunk]
    this.trackFloor(peak)
    const loud = peak >= Math.max(this.opts.minOpen, this.floor! * this.opts.openFactor)

    if (loud) {
      const out = this.open ? [chunk] : [...this.ring, chunk]
      this.ring.length = 0
      this.hangoverLeft = this.opts.hangover
      return out
    }
    if (this.open) {
      this.hangoverLeft--
      if (this.hangoverLeft >= 0) return [chunk]
    }
    this.ring.push(chunk)
    if (this.ring.length > this.opts.preRoll) this.ring.shift()
    return []
  }

  /** Noise floor: drops fast to quieter peaks, rises slowly (faster while closed). */
  private trackFloor(peak: number): void {
    if (this.floor === null || peak < this.floor) {
      this.floor = this.floor === null ? peak : this.floor + (peak - this.floor) * 0.5
      return
    }
    this.floor += (peak - this.floor) * (this.open ? 0.003 : 0.05)
  }
}
