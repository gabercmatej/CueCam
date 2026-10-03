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
})

describe('WordSpotter', () => {
  it('normalizes and dedupes the word list', () => {
    expect(new WordSpotter(['Boom', 'boom ', 'fire']).words).toEqual(['boom', 'fire'])
  })

  it('fires on a partial as soon as a word appears', () => {
    const s = new WordSpotter(['boom'])
    expect(s.partial('boom', 100)).toEqual([{ word: 'boom', partial: true, confidence: 1, latencyMs: null }])
    expect(s.partial('boom', 150)).toEqual([])
  })

  it('fires again for a repeat within the same utterance', () => {
    const s = new WordSpotter(['boom'])
    s.partial('boom', 100)
    expect(s.partial('boom boom', 200)).toHaveLength(1)
  })

  it('lets the final add only occurrences partials missed, then resets', () => {
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
    expect(final).toEqual([{ word: 'fire', partial: false, confidence: 0.9, latencyMs: 600 }])
    expect(s.partial('boom', 3000)).toHaveLength(1)
  })
})
