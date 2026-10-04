import { type AudioClock, matchWords, type VoskResult } from './speechParse'

export interface SpottedWord {
  word: string
  partial: boolean
  confidence: number
  /** Time from the end of the word to now; only known for final results. */
  latencyMs: number | null
  /** Final results only: a partial result already reported this occurrence. */
  seenInPartial: boolean
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
 * Reports trigger words from Vosk partial results (fast, ~0–300 ms after the word) and again from
 * the final result, flagging the final occurrences a partial already reported. Rules pick one:
 * `confirm: "partial"` rules use partials plus the finals no partial saw (so nothing fires twice for
 * one spoken word), `confirm: "final"` rules use only finals (slower, but a partial that Vosk later
 * retracts never fires them). Counting occurrences per utterance means "boom … boom" fires twice.
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
      for (let i = already; i < seen; i++) out.push({ word, partial: true, confidence: 1, latencyMs: null, seenInPartial: false })
      if (seen > already) this.fired.set(word, seen)
    }
    return out
  }

  final(result: VoskResult, clock: AudioClock, now: number): SpottedWord[] {
    const out: SpottedWord[] = []
    for (const word of this.words) {
      const seen = this.fired.get(word) ?? 0
      matchWords(result, [word], clock, now).forEach((h, i) =>
        out.push({ word, partial: false, confidence: h.confidence, latencyMs: h.latencyMs, seenInPartial: i < seen })
      )
    }
    this.fired.clear()
    return out
  }
}
