import { Model } from 'vosk-browser'
import { waitForModelLoad } from './modelLoad'
import micWorkletUrl from './micCapture.worklet.ts?worker&url'
import type { MicCaptureOptions } from './micCapture.worklet'
import { AudioClock, buildGrammar, matchWords, partialContains, type VoskResult, type WordHit } from './speechParse'

// vosk-browser runs recognition in its own Web Worker (created from an inline blob),
// so decoding stays off the render thread without a worker of ours.
// The worker fetches the model itself, so the URL must be absolute.
const MODEL_URL = new URL('../vosk/vosk-model-small-en-us-0.15.tar.gz', document.baseURI).href
const SAMPLE_RATE = 16000

export interface SpeechEvents {
  onWord(hit: WordHit): void
  onPartial(word: string, at: number): void
  /** Peak level (0–1) of each ~100 ms chunk, for the mic meter. */
  onLevel(peak: number): void
}

export async function startSpeech(words: string[], events: SpeechEvents): Promise<void> {
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

    const recognizer = new model.KaldiRecognizer(SAMPLE_RATE, buildGrammar(words))
    recognizer.setWords(true)

    const clock = new AudioClock(SAMPLE_RATE)
    const seenInUtterance = new Set<string>()

    recognizer.on('partialresult', (message) => {
      if (!('result' in message) || !('partial' in message.result)) return
      const partial = message.result.partial
      for (const word of words) {
        if (!seenInUtterance.has(word) && partialContains(partial, word)) {
          seenInUtterance.add(word)
          events.onPartial(word, performance.now())
        }
      }
    })

    recognizer.on('result', (message) => {
      if (!('result' in message) || !('text' in message.result)) return
      seenInUtterance.clear()
      for (const hit of matchWords(message.result as VoskResult, words, clock, performance.now())) events.onWord(hit)
    })

    ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
    await ctx.audioWorklet.addModule(micWorkletUrl)
    const node = new AudioWorkletNode(ctx, 'mic-capture', {
      processorOptions: { chunkSize: Math.round(ctx.sampleRate / 10) } satisfies MicCaptureOptions // ~100 ms
    })
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      clock.push(e.data.length, performance.now())
      let peak = 0
      for (const v of e.data) peak = Math.max(peak, Math.abs(v))
      events.onLevel(peak)
      recognizer.acceptWaveformFloat(e.data, SAMPLE_RATE)
    }
    ctx.createMediaStreamSource(stream).connect(node)
    console.log(`[speech] listening at ${ctx.sampleRate} Hz for ${buildGrammar(words)}`)
  } catch (err) {
    // Never leave the mic open (and the macOS mic indicator on) after a failed start.
    stream?.getTracks().forEach((t) => t.stop())
    void ctx?.close()
    model.terminate()
    throw err
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)))
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
