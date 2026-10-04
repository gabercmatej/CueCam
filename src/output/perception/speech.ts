import { type KaldiRecognizer, Model } from 'vosk-browser'
import micWorkletUrl from './micCapture.worklet.ts?worker&url'
import type { MicCaptureOptions } from './micCapture.worklet'
import { waitForModelLoad } from './modelLoad'
import { SpeechGate } from './speechGate'
import { AudioClock, buildGrammar, type VoskResult } from './speechParse'
import { type SpottedWord, WordSpotter } from './wordSpotter'

// vosk-browser runs recognition in its own Web Worker (created from an inline blob),
// so decoding stays off the render thread without a worker of ours.
// The worker fetches the model itself, so the URL must be absolute.
const MODEL_URL = new URL('../vosk/vosk-model-small-en-us-0.15.tar.gz', document.baseURI).href
const SAMPLE_RATE = 16000

export interface SpeechEvents {
  onWord(word: SpottedWord, at: number): void
  /** Peak level (0–1) of each ~100 ms chunk, for the mic meter. */
  onLevel(peak: number): void
  /** Each final transcript (decoys and [unk] included): what the recognizer heard. */
  onText?(text: string): void
}

interface Listener {
  recognizer: KaldiRecognizer
  spotter: WordSpotter
  /** Vosk word times restart at 0 for each recognizer, so each gets its own clock. */
  clock: AudioClock
}

/** Mic → AudioWorklet → Vosk keyword spotting. One model and mic; the grammar can be swapped live. */
export class SpeechInput {
  private listener: Listener | null = null
  /** Silence isn't sent to Vosk (see SpeechGate); chunks keep their capture time for the clock. */
  private readonly gate = new SpeechGate<{ chunk: Float32Array; at: number }>()
  /** Chunks sent to / skipped from Vosk since the last stats read. */
  private fed = 0
  private skipped = 0
  /** Dev: a recording is being fed instead of the mic (see feed). */
  private feeding = false

  private constructor(
    private readonly model: Model,
    private readonly stream: MediaStream,
    private readonly ctx: AudioContext,
    private readonly events: SpeechEvents
  ) {}

  static async start(events: SpeechEvents): Promise<SpeechInput> {
    const loadStart = performance.now()
    const model = new Model(MODEL_URL)
    let stream: MediaStream | undefined
    let ctx: AudioContext | undefined
    try {
      ;[, stream] = await Promise.all([
        withTimeout(waitForModelLoad(model), 60_000, 'Vosk model load timed out'),
        navigator.mediaDevices.getUserMedia({
          video: false,
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        })
      ])
      console.log(`[speech] model ready in ${Math.round(performance.now() - loadStart)} ms`)

      ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
      await ctx.audioWorklet.addModule(micWorkletUrl)
      const node = new AudioWorkletNode(ctx, 'mic-capture', {
        processorOptions: { chunkSize: Math.round(ctx.sampleRate / 10) } satisfies MicCaptureOptions // ~100 ms
      })
      const input = new SpeechInput(model, stream, ctx, events)
      node.port.onmessage = (e: MessageEvent<Float32Array>) => {
        if (!input.feeding) input.onChunk(e.data)
      }
      ctx.createMediaStreamSource(stream).connect(node)
      return input
    } catch (err) {
      // Never leave the mic open (and the macOS mic indicator on) after a failed start.
      stream?.getTracks().forEach((t) => t.stop())
      void ctx?.close()
      model.terminate()
      throw err
    }
  }

  /**
   * Restricts recognition to these words/phrases, plus decoys and [unk] (see decoys.ts); only the
   * words are ever reported. Safe to call again on config reload.
   */
  setWords(words: string[], decoys: readonly string[] = []): void {
    this.listener?.recognizer.remove()
    const spotter = new WordSpotter(words)
    const grammar = buildGrammar(spotter.words, decoys)
    const recognizer = new this.model.KaldiRecognizer(SAMPLE_RATE, grammar)
    recognizer.setWords(true)
    const listener: Listener = { recognizer, spotter, clock: new AudioClock(SAMPLE_RATE) }

    recognizer.on('partialresult', (message) => {
      if (!('result' in message) || !('partial' in message.result)) return
      const now = performance.now()
      for (const w of spotter.partial(message.result.partial, now)) this.events.onWord(w, now)
    })
    recognizer.on('result', (message) => {
      if (!('result' in message) || !('text' in message.result)) return
      const now = performance.now()
      if (message.result.text) {
        if (import.meta.env.DEV) console.log(`[speech] heard "${message.result.text}"`)
        this.events.onText?.(message.result.text)
      }
      for (const w of spotter.final(message.result as VoskResult, listener.clock, now)) this.events.onWord(w, now)
    })

    this.listener = listener
    console.log(`[speech] listening for ${JSON.stringify(spotter.words)} + ${decoys.length} decoys`)
  }

  stop(): void {
    this.listener?.recognizer.remove()
    this.listener = null
    this.stream.getTracks().forEach((t) => t.stop())
    void this.ctx.close()
    this.model.terminate()
  }

  /** Share of mic chunks Vosk decoded since the last call (1 = no silence skipped). */
  takeDecodeShare(): number {
    const total = this.fed + this.skipped
    const share = total ? this.fed / total : 1
    this.fed = this.skipped = 0
    return share
  }

  /**
   * Dev: replaces the mic with a 16 kHz mono recording, fed in ~100 ms chunks at `speed`× real time,
   * then 2 s of silence so the last utterance closes. Silent: nothing is played.
   */
  async feed(samples: Float32Array, speed = 4): Promise<void> {
    this.feeding = true
    const size = SAMPLE_RATE / 10
    const silence = new Float32Array(SAMPLE_RATE * 2)
    const all = new Float32Array(samples.length + silence.length)
    all.set(samples)
    try {
      for (let i = 0; i < all.length; i += size) {
        this.onChunk(all.slice(i, i + size))
        await new Promise((r) => setTimeout(r, 100 / speed))
      }
    } finally {
      this.feeding = false
    }
  }

  private onChunk(chunk: Float32Array): void {
    let peak = 0
    for (let i = 0; i < chunk.length; i++) {
      const v = Math.abs(chunk[i]!)
      if (v > peak) peak = v
    }
    this.events.onLevel(peak)
    if (!this.listener) return
    const ready = this.gate.push({ chunk, at: performance.now() }, peak)
    if (ready.length === 0) this.skipped++
    for (const { chunk: c, at } of ready) {
      this.fed++
      this.listener.clock.push(c.length, at)
      this.listener.recognizer.acceptWaveformFloat(c, SAMPLE_RATE)
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)))
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
