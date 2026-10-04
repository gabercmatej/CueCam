/** Pure helpers for Vosk keyword spotting: grammar, result matching, latency. */

export interface VoskWord {
  word: string
  conf: number
  start: number
  end: number
}

export interface VoskResult {
  text: string
  result?: VoskWord[]
}

export interface WordHit {
  word: string
  confidence: number
  latencyMs: number
}

const normalize = (w: string): string => w.trim().toLowerCase()

/**
 * The Vosk grammar: the trigger list, decoys (harmless words ordinary speech can land on instead of
 * a trigger) and `[unk]` for anything else.
 */
export function buildGrammar(words: string[], decoys: readonly string[] = []): string {
  return JSON.stringify([...new Set([...words.map(normalize), ...decoys.map(normalize)])].concat('[unk]'))
}

interface Chunk {
  endSample: number
  wall: number
}

/**
 * Maps a position in the audio stream (seconds since the first sample sent to
 * Vosk) to the wall-clock time (performance.now) that audio reached us.
 */
export class AudioClock {
  private chunks: Chunk[] = []
  private totalSamples = 0

  constructor(
    private readonly sampleRate: number,
    private readonly maxChunks = 2000
  ) {}

  push(sampleCount: number, wall: number): void {
    this.totalSamples += sampleCount
    this.chunks.push({ endSample: this.totalSamples, wall })
    if (this.chunks.length > this.maxChunks) this.chunks.shift()
  }

  wallTimeAt(streamSeconds: number): number {
    const sample = streamSeconds * this.sampleRate
    const chunk = this.chunks.find((c) => c.endSample >= sample) ?? this.chunks[this.chunks.length - 1]
    if (!chunk) return 0
    return chunk.wall - ((chunk.endSample - sample) / this.sampleRate) * 1000
  }
}

/**
 * Finds trigger words/phrases in a final Vosk result. Phrases match consecutive
 * tokens; confidence is the weakest token, latency runs from the end of the last token.
 */
export function matchWords(result: VoskResult, words: string[], clock: AudioClock, now: number): WordHit[] {
  const tokens = result.result ?? []
  const hits: WordHit[] = []
  for (const target of words) {
    const parts = normalize(target).split(/\s+/)
    for (let i = 0; i + parts.length <= tokens.length; i++) {
      const span = tokens.slice(i, i + parts.length)
      if (!span.every((t, k) => normalize(t.word) === parts[k])) continue
      hits.push({
        word: target,
        confidence: Math.min(...span.map((t) => t.conf)),
        latencyMs: now - clock.wallTimeAt(span[span.length - 1]!.end)
      })
    }
  }
  return hits
}
