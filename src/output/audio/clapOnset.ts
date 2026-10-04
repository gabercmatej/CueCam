/**
 * Clap sound detector: finds sharp, short, broadband transients in raw mic audio. Pure DSP, no Web
 * Audio types, so the AudioWorklet (clapOnset.worklet.ts) and the tests run the same code.
 *
 * Works per block (one render quantum, 128 samples ≈ 2.7 ms at 48 kHz) on two bands: the full signal
 * and a 2 kHz high-pass ("bright" band, where a clap carries most of its energy and voice little).
 *   1. Onset: the bright band jumps `minRiseDb` above its mean over the previous ~30 ms, in one block.
 *   2. Loud: the bright band's peak reaches `minLevelDb` (dBFS). Touching hands or hair stays quiet.
 *   3. Broadband: bright energy ÷ full energy at the peak ≥ `minBrightness` (voice is mostly below 2 kHz).
 *   4. Short: the bright band falls `decayDb` below its peak within `maxDurationMs` (a clap is over in
 *      tens of ms; a hiss, a sibilant or a door rumble lasts longer).
 * An onset that passes all four is reported with the time of its first block; one that fails is
 * reported with the reason, so the Control window can show why a sound didn't count.
 */

export interface ClapOnsetSettings {
  /** Rise of the bright band over the previous ~30 ms, in dB, within one block. */
  minRiseDb: number
  /** Bright-band peak level, dBFS (block RMS). */
  minLevelDb: number
  /** Bright ÷ full energy at the peak (0–1). */
  minBrightness: number
  /** The bright band must drop `decayDb` below its peak within this long. */
  maxDurationMs: number
  decayDb: number
}

export const CLAP_ONSET_DEFAULTS: ClapOnsetSettings = {
  minRiseDb: 15,
  minLevelDb: -38,
  minBrightness: 0.3,
  maxDurationMs: 80,
  decayDb: 12
}

export type OnsetVerdict = 'clap' | 'quiet' | 'dull' | 'long'

export interface Onset {
  verdict: OnsetVerdict
  /** Sample index (since start) of the onset's first block. */
  frame: number
  riseDb: number
  peakDb: number
  brightness: number
  durationMs: number
}

/** History for the rise reference: ~30 ms of blocks (at 48 kHz / 128). */
const HISTORY = 12
/** After the onset block, the peak may still grow for this many blocks (~8 ms). */
const PEAK_BLOCKS = 3
/** Ignore new onsets this long after one (a clap's own reverb). */
const REFRACTORY_MS = 120
const EPS = 1e-12

const db = (energy: number): number => 10 * Math.log10(energy + EPS)

/** RBJ biquad high-pass, transposed direct form II. */
class HighPass {
  private readonly b0: number
  private readonly b1: number
  private readonly b2: number
  private readonly a1: number
  private readonly a2: number
  private z1 = 0
  private z2 = 0

  constructor(sampleRate: number, cutoff: number, q = Math.SQRT1_2) {
    const w = (2 * Math.PI * cutoff) / sampleRate
    const alpha = Math.sin(w) / (2 * q)
    const cos = Math.cos(w)
    const a0 = 1 + alpha
    this.b0 = (1 + cos) / 2 / a0
    this.b1 = -(1 + cos) / a0
    this.b2 = (1 + cos) / 2 / a0
    this.a1 = (-2 * cos) / a0
    this.a2 = (1 - alpha) / a0
  }

  step(x: number): number {
    const y = this.b0 * x + this.z1
    this.z1 = this.b1 * x - this.a1 * y + this.z2
    this.z2 = this.b2 * x - this.a2 * y
    return y
  }
}

export class ClapOnsetDetector {
  settings: ClapOnsetSettings
  private readonly hp: HighPass
  private readonly history = new Float64Array(HISTORY)
  private historyFill = 0
  private historyAt = 0
  private frame = 0
  /** The onset being measured, or null. */
  private candidate: { frame: number; riseDb: number; peak: number; peakFull: number; blocks: number } | null = null
  private quietUntil = 0
  /** Latest block levels, dBFS, for meters. */
  brightDb = -120
  /** Mean bright level over the history (the reference a rise is measured from), dBFS. */
  floorDb = -120

  constructor(
    private readonly sampleRate: number,
    settings: Partial<ClapOnsetSettings> = {}
  ) {
    this.settings = { ...CLAP_ONSET_DEFAULTS, ...settings }
    this.hp = new HighPass(sampleRate, 2000)
  }

  /** Samples processed so far (the clock `Onset.frame` is on). */
  get position(): number {
    return this.frame
  }

  /** Processes one block of mono samples. Returns a finished onset (clap or rejected) or null. */
  process(block: Float32Array): Onset | null {
    let full = 0
    let bright = 0
    for (let i = 0; i < block.length; i++) {
      const x = block[i]!
      const y = this.hp.step(x)
      full += x * x
      bright += y * y
    }
    full /= block.length
    bright /= block.length
    const start = this.frame
    this.frame += block.length
    this.brightDb = db(bright)

    const result = this.candidate ? this.measure(bright, full) : this.detect(bright, full, start)
    // Only quiet-ish blocks feed the reference, so a clap's own body doesn't raise it.
    if (!this.candidate) this.remember(bright)
    return result
  }

  private detect(bright: number, full: number, start: number): Onset | null {
    if (this.historyFill < HISTORY || start < this.quietUntil) return null
    const riseDb = this.brightDb - this.floorDb
    if (riseDb < this.settings.minRiseDb) return null
    this.candidate = { frame: start, riseDb, peak: bright, peakFull: full, blocks: 1 }
    return null
  }

  private measure(bright: number, full: number): Onset | null {
    const c = this.candidate!
    c.blocks++
    if (c.blocks <= PEAK_BLOCKS && bright > c.peak) {
      c.peak = bright
      c.peakFull = full
    }
    const durationMs = ((this.frame - c.frame) / this.sampleRate) * 1000
    const decayed = db(bright) <= db(c.peak) - this.settings.decayDb
    if (!decayed && durationMs <= this.settings.maxDurationMs) return null

    this.candidate = null
    this.quietUntil = this.frame + (REFRACTORY_MS / 1000) * this.sampleRate
    const peakDb = db(c.peak)
    const brightness = c.peak / (c.peakFull + EPS)
    const s = this.settings
    const verdict: OnsetVerdict = !decayed ? 'long' : peakDb < s.minLevelDb ? 'quiet' : brightness < s.minBrightness ? 'dull' : 'clap'
    return { verdict, frame: c.frame, riseDb: c.riseDb, peakDb, brightness: Math.min(brightness, 1), durationMs }
  }

  private remember(bright: number): void {
    this.history[this.historyAt] = bright
    this.historyAt = (this.historyAt + 1) % HISTORY
    if (this.historyFill < HISTORY) this.historyFill++
    let sum = 0
    for (let i = 0; i < this.historyFill; i++) sum += this.history[i]!
    this.floorDb = db(sum / this.historyFill)
  }
}
