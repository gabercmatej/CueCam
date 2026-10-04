import { describe, expect, it } from 'vitest'
import { DECOYS, decoysFor } from './decoys'

describe('decoysFor', () => {
  const triggers = ['I love you', 'fire', 'boom', "let's go", 'bye', 'no way']

  it("never contains a trigger's own words or their homophones", () => {
    const decoys = decoysFor(triggers)
    for (const banned of ['i', 'love', 'you', 'fire', 'boom', "let's", 'go', 'bye', 'by', 'buy', 'no', 'know', 'way', 'eye']) {
      expect(decoys).not.toContain(banned)
    }
  })

  it('keeps near-sounding words, so misheard speech has somewhere else to land', () => {
    const decoys = decoysFor(triggers)
    for (const near of ['room', 'five', 'goal', 'view', 'bike', 'away']) expect(decoys).toContain(near)
  })

  it('has no duplicates', () => {
    expect(new Set(DECOYS).size).toBe(DECOYS.length)
  })
})
