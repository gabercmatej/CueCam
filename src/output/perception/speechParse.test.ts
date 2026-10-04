import { describe, expect, it } from 'vitest'
import { AudioClock, buildGrammar, matchWords } from './speechParse'

describe('buildGrammar', () => {
  it('lowercases, dedupes, and appends [unk]', () => {
    expect(JSON.parse(buildGrammar(['Boom', 'fire', ' boom ', 'bye']))).toEqual(['boom', 'fire', 'bye', '[unk]'])
  })

  it('adds decoys after the triggers', () => {
    expect(JSON.parse(buildGrammar(['boom'], ['room', 'Boom', 'the']))).toEqual(['boom', 'room', 'the', '[unk]'])
  })
})

describe('AudioClock', () => {
  it('maps stream time to the wall time that audio became available', () => {
    const clock = new AudioClock(16000)
    clock.push(1600, 1100) // samples 0..1600 (0.0–0.1 s) arrived at wall 1100
    clock.push(1600, 1200) // 0.1–0.2 s arrived at wall 1200
    // 0.15 s is 800 samples before the end of the second chunk → 50 ms earlier
    expect(clock.wallTimeAt(0.15)).toBeCloseTo(1150)
    expect(clock.wallTimeAt(0.1)).toBeCloseTo(1100)
  })

  it('extrapolates past the last chunk and before the oldest kept chunk', () => {
    const clock = new AudioClock(16000, 2)
    clock.push(1600, 100)
    clock.push(1600, 200)
    clock.push(1600, 300) // first chunk evicted
    expect(clock.wallTimeAt(0.35)).toBeCloseTo(350)
    expect(clock.wallTimeAt(0.05)).toBeCloseTo(50)
  })
})

describe('matchWords', () => {
  const clock = new AudioClock(16000)
  clock.push(16000 * 2, 2000) // 2 s of audio, fully available at wall 2000 → stream t maps to wall t*1000

  it('returns single-word matches with confidence and latency', () => {
    const hits = matchWords(
      { text: 'boom', result: [{ word: 'boom', conf: 0.93, start: 1.2, end: 1.5 }] },
      ['boom', 'fire'],
      clock,
      2100
    )
    expect(hits).toEqual([{ word: 'boom', confidence: 0.93, latencyMs: 600, gapAfterMs: Infinity }])
  })

  it('matches multi-word phrases on consecutive tokens, using min confidence and last end', () => {
    const hits = matchWords(
      {
        text: "let's go",
        result: [
          { word: "let's", conf: 0.8, start: 0.5, end: 0.7 },
          { word: 'go', conf: 0.95, start: 0.7, end: 1.0 }
        ]
      },
      ["let's go"],
      clock,
      1400
    )
    expect(hits).toEqual([{ word: "let's go", confidence: 0.8, latencyMs: 400, gapAfterMs: Infinity }])
  })

  it('ignores [unk] and words outside the list', () => {
    const hits = matchWords(
      {
        text: '[unk] fire',
        result: [
          { word: '[unk]', conf: 1, start: 0, end: 0.2 },
          { word: 'fire', conf: 1, start: 0.3, end: 0.6 }
        ]
      },
      ['boom'],
      clock,
      1000
    )
    expect(hits).toEqual([])
  })

  it('reports the silence after a match: to the next token ([unk] counts as speech), or Infinity when last', () => {
    const result = {
      text: 'bye [unk] bye',
      result: [
        { word: 'bye', conf: 1, start: 0.1, end: 0.3 },
        { word: '[unk]', conf: 1, start: 0.35, end: 0.6 },
        { word: 'bye', conf: 1, start: 1.4, end: 1.6 }
      ]
    }
    expect(matchWords(result, ['bye'], clock, 2000).map((h) => h.gapAfterMs)).toEqual([expect.closeTo(50, 5), Infinity])
  })

  it('handles results without word timings', () => {
    expect(matchWords({ text: '' }, ['boom'], clock, 0)).toEqual([])
  })
})
