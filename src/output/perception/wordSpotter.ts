import { type AudioClock, matchWords, type VoskResult } from './speechParse'

export interface SpottedWord {
  word: string
  partial: boolean
  confidence: number
  /** Time from the end of the word to now; only known for final results. */
  latencyMs: number | null
}

const normalize = (w: string): string => w.trim().toLowerCase().replace(/\s+/g, ' ')

/** Whole-token occurrences of a word or phrase in a transcript. */
export function countOccurrences(text: string, phrase: string): number {
  const tokens = normalize(text).split(' ').filter(Boolean)
  const parts = normalize(phrase).split(' ')
  let n = 0
  for (let i = 0; i + parts.length <= tokens.length; i++) {
    if (parts.every((p, k) => tokens[i + k] === p)) n++
  }
  return n
}

/**
 * Fires trigger words from Vosk partial results (fast, ~0–300 ms after the word) and uses
 * the final result only to add occurrences the partials missed. Counting occurrences per
 * utterance means "boom … boom" fires twice, and nothing fires twice for one spoken word.
 * A partial that later gets retracted has already fired; that is the price of low latency.
 */
export class WordSpotter {
  readonly words: string[]
  private fired = new Map<string, number>()

  constructor(words: string[]) {
    this.words = [...new Set(words.map(normalize).filter(Boolean))]
  }

  partial(text: string, _now: number): SpottedWord[] {
    const out: SpottedWord[] = []
    for (const word of this.words) {
      const seen = countOccurrences(text, word)
      const already = this.fired.get(word) ?? 0
      for (let i = already; i < seen; i++) out.push({ word, partial: true, confidence: 1, latencyMs: null })
      if (seen > already) this.fired.set(word, seen)
    }
    return out
  }

  final(result: VoskResult, clock: AudioClock, now: number): SpottedWord[] {
    const out: SpottedWord[] = []
    for (const word of this.words) {
      const hits = matchWords(result, [word], clock, now)
      const missed = hits.slice(this.fired.get(word) ?? 0)
      for (const h of missed) out.push({ word, partial: false, confidence: h.confidence, latencyMs: h.latencyMs })
    }
    this.fired.clear()
    return out
  }
}
