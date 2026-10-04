// AudioWorklet: runs ClapOnsetDetector on the raw mic, off the main thread. Posts each finished onset
// (clap or rejected, with its age so the main thread can stamp it) and the bright-band level ~10×/s.
// Loaded via `?worker&url`, so it is bundled with its imports and runs in the AudioWorkletGlobalScope.
import { ClapOnsetDetector, type ClapOnsetSettings, type Onset } from './clapOnset'

declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: unknown)
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void
declare const sampleRate: number
/** Context time (s) of the current block's first sample. */
declare const currentTime: number

export type ClapWorkletIn = { type: 'settings'; settings: ClapOnsetSettings }
/** `contextTime`: the audio clock when posted (the main thread maps it to performance.now). */
export type ClapWorkletOut =
  | { type: 'onset'; onset: Onset; ageMs: number; contextTime: number }
  /**
   * Since the last level message: the raw mic's sample peak, the loudest bright-band block, and the
   * current rise reference (all dBFS).
   */
  | { type: 'level'; micDb: number; peakDb: number; floorDb: number; contextTime: number }

const LEVEL_EVERY_MS = 100

class ClapOnsetProcessor extends AudioWorkletProcessor {
  private readonly detector = new ClapOnsetDetector(sampleRate)
  private readonly levelEvery = Math.round((LEVEL_EVERY_MS / 1000) * sampleRate)
  private sinceLevel = 0
  private peakDb = -120
  private micPeak = 0

  constructor() {
    super()
    this.port.onmessage = (e: MessageEvent<ClapWorkletIn>) => {
      if (e.data.type === 'settings') this.detector.settings = { ...e.data.settings }
    }
  }

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0]
    if (!channel) return true
    const onset = this.detector.process(channel)
    if (onset) {
      const ageMs = ((this.detector.position - onset.frame) / sampleRate) * 1000
      // ageMs: from the onset's first sample to the end of this block.
      this.port.postMessage({ type: 'onset', onset, ageMs, contextTime: currentTime + channel.length / sampleRate } satisfies ClapWorkletOut)
    }
    if (this.detector.brightDb > this.peakDb) this.peakDb = this.detector.brightDb
    for (let i = 0; i < channel.length; i++) {
      const v = channel[i]! < 0 ? -channel[i]! : channel[i]!
      if (v > this.micPeak) this.micPeak = v
    }
    this.sinceLevel += channel.length
    if (this.sinceLevel >= this.levelEvery) {
      const micDb = this.micPeak > 0 ? 20 * Math.log10(this.micPeak) : -120
      this.port.postMessage({ type: 'level', micDb, peakDb: this.peakDb, floorDb: this.detector.floorDb, contextTime: currentTime + channel.length / sampleRate } satisfies ClapWorkletOut)
      this.sinceLevel = 0
      this.peakDb = -120
      this.micPeak = 0
    }
    return true
  }
}

registerProcessor('clap-onset', ClapOnsetProcessor)
