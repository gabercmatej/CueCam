import { describe, expect, it } from 'vitest'
import { SpeechGate } from './speechGate'

/** Pushes chunks named by index with the given peaks; returns which got fed, per push. */
const feed = (g: SpeechGate<number>, peaks: number[], from = 0) => peaks.map((p, i) => g.push(from + i, p))

describe('SpeechGate', () => {
  const quiet = (n: number) => Array.from({ length: n }, () => 0.004)

  it('feeds nothing while the room is quiet', () => {
    const g = new SpeechGate<number>()
    expect(feed(g, quiet(20)).flat()).toEqual([])
    expect(g.open).toBe(false)
  })

  it('opens on speech and replays the pre-roll first, so word onsets are not cut', () => {
    const g = new SpeechGate<number>({ preRoll: 3 })
    feed(g, quiet(10))
    expect(g.push(10, 0.3)).toEqual([7, 8, 9, 10])
    expect(g.open).toBe(true)
  })

  it('keeps feeding through the hangover after speech so Vosk can finish the utterance, then closes', () => {
    const g = new SpeechGate<number>({ hangover: 4 })
    feed(g, quiet(10))
    g.push(10, 0.3)
    const tail = feed(g, quiet(6), 11)
    expect(tail.map((t) => t.length)).toEqual([1, 1, 1, 1, 0, 0])
    expect(g.open).toBe(false)
  })

  it('stays open through short pauses between words', () => {
    const g = new SpeechGate<number>({ hangover: 4 })
    feed(g, quiet(10))
    const fed = feed(g, [0.3, 0.004, 0.004, 0.3, 0.004, 0.2], 10)
    expect(fed.every((f) => f.length >= 1)).toBe(true)
  })

  it('adapts to a noisier room instead of staying open on background noise', () => {
    const g = new SpeechGate<number>()
    // A fan at 0.05: opens at first, then the noise floor catches up and the gate closes.
    feed(g, Array.from({ length: 300 }, () => 0.05))
    expect(g.open).toBe(false)
    expect(g.push(1000, 0.4).length).toBeGreaterThan(0)
  })

  it('never stops feeding when disabled', () => {
    const g = new SpeechGate<number>({ enabled: false })
    expect(feed(g, quiet(5)).flat()).toEqual([0, 1, 2, 3, 4])
  })
})
