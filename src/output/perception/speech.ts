import { type KaldiRecognizer, Model } from 'vosk-browser'
import micWorkletUrl from './micCapture.worklet.ts?worker&url'
import type { MicCaptureOptions } from './micCapture.worklet'
import { waitForModelLoad } from './modelLoad'
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
      node.port.onmessage = (e: MessageEvent<Float32Array>) => input.onChunk(e.data)
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

  /** Restricts recognition to these words/phrases (plus [unk]). Safe to call again on config reload. */
  setWords(words: string[]): void {
    this.listener?.recognizer.remove()
    const spotter = new WordSpotter(words)
    const recognizer = new this.model.KaldiRecognizer(SAMPLE_RATE, buildGrammar(spotter.words))
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
      if (import.meta.env.DEV && message.result.text) console.log(`[speech] heard "${message.result.text}"`)
      for (const w of spotter.final(message.result as VoskResult, listener.clock, now)) this.events.onWord(w, now)
    })

    this.listener = listener
    console.log(`[speech] listening for ${buildGrammar(spotter.words)}`)
  }

  stop(): void {
    this.listener?.recognizer.remove()
    this.listener = null
    this.stream.getTracks().forEach((t) => t.stop())
    void this.ctx.close()
    this.model.terminate()
  }

  private onChunk(chunk: Float32Array): void {
    let peak = 0
    for (const v of chunk) peak = Math.max(peak, Math.abs(v))
    this.events.onLevel(peak)
    if (!this.listener) return
    this.listener.clock.push(chunk.length, performance.now())
    this.listener.recognizer.acceptWaveformFloat(chunk, SAMPLE_RATE)
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)))
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
