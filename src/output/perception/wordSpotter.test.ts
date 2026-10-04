import { describe, expect, it } from 'vitest'
import { AudioClock } from './speechParse'
import { countOccurrences, WordSpotter } from './wordSpotter'

const clock = new AudioClock(16000)
clock.push(16000 * 10, 10_000)

describe('countOccurrences', () => {
  it('counts whole-token occurrences of words and phrases', () => {
    expect(countOccurrences('boom boom [unk] boom', 'boom')).toBe(3)
    expect(countOccurrences("let's go let's go", "let's go")).toBe(2)
    expect(countOccurrences('booming', 'boom')).toBe(0)
  })

  it('matches multi-word phrases only completely and in order', () => {
    expect(countOccurrences('love you', 'i love you')).toBe(0)
    expect(countOccurrences('i [unk] love you', 'i love you')).toBe(0)
    expect(countOccurrences('you love i', 'i love you')).toBe(0)
    expect(countOccurrences('well i love you', 'i love you')).toBe(1)
    expect(countOccurrences("let's [unk]", "let's go")).toBe(0)
    expect(countOccurrences("go let's", "let's go")).toBe(0)
  })
})

describe('WordSpotter', () => {
  it('normalizes and dedupes the word list', () => {
    expect(new WordSpotter(['Boom', 'boom ', 'fire']).words).toEqual(['boom', 'fire'])
  })

  it('fires on a partial as soon as a word appears', () => {
    const s = new WordSpotter(['boom'])
    expect(s.partial('boom', 100)).toEqual([{ word: 'boom', partial: true, confidence: 1, latencyMs: null, seenInPartial: false }])
    expect(s.partial('boom', 150)).toEqual([])
  })

  it('fires again for a repeat within the same utterance', () => {
    const s = new WordSpotter(['boom'])
    s.partial('boom', 100)
    expect(s.partial('boom boom', 200)).toHaveLength(1)
  })

  it('reports every final occurrence, flagging the ones a partial already reported, then resets', () => {
    const s = new WordSpotter(['boom', 'fire'])
    s.partial('boom', 100)
    const final = s.final(
      {
        text: 'boom fire',
        result: [
          { word: 'boom', conf: 1, start: 1, end: 1.3 },
          { word: 'fire', conf: 0.9, start: 1.5, end: 1.9 }
        ]
      },
      clock,
      2500
    )
    expect(final).toEqual([
      { word: 'boom', partial: false, confidence: 1, latencyMs: 1200, seenInPartial: true },
      { word: 'fire', partial: false, confidence: 0.9, latencyMs: 600, seenInPartial: false }
    ])
    expect(s.partial('boom', 3000)).toHaveLength(1)
  })

  it('a partial phrase that the final retracts produces no final event', () => {
    const s = new WordSpotter(["let's go"])
    expect(s.partial("let's go", 100)).toHaveLength(1)
    const final = s.final({ text: "let's [unk]", result: [{ word: "let's", conf: 0.8, start: 1, end: 1.2 }, { word: '[unk]', conf: 0.5, start: 1.2, end: 1.5 }] }, clock, 2000)
    expect(final).toEqual([])
  })
})
