import { describe, expect, it } from 'vitest'
import { ClapOnsetDetector, type Onset } from './clapOnset'

const SR = 48000
const BLOCK = 128

/** Deterministic noise in [-1, 1]. */
function rng(seed = 1): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return (s / 2 ** 32) * 2 - 1
  }
}

/** Runs a signal through the detector block by block; returns every finished onset. */
function run(signal: Float32Array): Onset[] {
  const d = new ClapOnsetDetector(SR)
  const out: Onset[] = []
  for (let i = 0; i + BLOCK <= signal.length; i += BLOCK) {
    const o = d.process(signal.subarray(i, i + BLOCK))
    if (o) out.push(o)
  }
  return out
}

/** `ms` of room noise, then `event(t)` added from `at` ms on. */
function make(ms: number, event: (t: number, noise: () => number) => number, at = 200, roomRms = 0.001): Float32Array {
  const n = Math.round((ms / 1000) * SR)
  const noise = rng(7)
  const ev = rng(11)
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = (i / SR) * 1000 - at
    x[i] = noise() * roomRms * Math.sqrt(3) + (t >= 0 ? event(t, ev) : 0)
  }
  return x
}

/** A clap: a broadband noise burst with a fast exponential decay. */
const clap = (amp: number, tauMs = 8) => (t: number, n: () => number) => amp * n() * Math.exp(-t / tauMs)

describe('ClapOnsetDetector', () => {
  it('detects a loud, sharp, short broadband burst as a clap, stamped at its onset', () => {
    const onsets = run(make(600, clap(0.5)))
    expect(onsets).toHaveLength(1)
    const o = onsets[0]!
    expect(o.verdict).toBe('clap')
    expect(Math.abs((o.frame / SR) * 1000 - 200)).toBeLessThan(3)
    expect(o.durationMs).toBeLessThan(60)
  })

  it('still detects a clap during ongoing speech-level noise', () => {
    const onsets = run(make(600, clap(0.6), 300, 0.02))
    expect(onsets.map((o) => o.verdict)).toEqual(['clap'])
  })

  it('rejects a soft touch (sharp and short, but quiet)', () => {
    const onsets = run(make(600, clap(0.012)))
    expect(onsets.every((o) => o.verdict !== 'clap')).toBe(true)
    expect(onsets.map((o) => o.verdict)).toContain('quiet')
  })

  it('rejects a vowel (loud but mostly below 2 kHz)', () => {
    const vowel = (t: number) => {
      const env = Math.min(1, t / 3) * (t < 300 ? 1 : 0)
      let v = 0
      for (let h = 1; h <= 8; h++) v += Math.sin((2 * Math.PI * 180 * h * t) / 1000) / h
      return 0.2 * env * v
    }
    expect(run(make(700, vowel)).filter((o) => o.verdict === 'clap')).toHaveLength(0)
  })

  it('rejects a sustained hiss with a sharp start (too long)', () => {
    const hiss = (t: number, n: () => number) => (t < 400 ? 0.3 * n() : 0)
    const onsets = run(make(800, hiss))
    expect(onsets.filter((o) => o.verdict === 'clap')).toHaveLength(0)
    expect(onsets.map((o) => o.verdict)).toContain('long')
  })

  it('ignores a sibilant that fades in (no sharp onset)', () => {
    const s = (t: number, n: () => number) => (t < 250 ? 0.2 * Math.min(1, t / 60) * n() : 0)
    expect(run(make(600, s)).filter((o) => o.verdict === 'clap')).toHaveLength(0)
  })

  it('ignores a low thump (a door, a knock on the desk)', () => {
    const thump = (t: number) => 0.6 * Math.sin((2 * Math.PI * 80 * t) / 1000) * Math.exp(-t / 30)
    expect(run(make(600, thump)).filter((o) => o.verdict === 'clap')).toHaveLength(0)
  })

  it('counts two claps 300 ms apart as two, but not a clap and its own echo', () => {
    const two = (t: number, n: () => number) => clap(0.5)(t, n) + (t >= 300 ? clap(0.5)(t - 300, n) : 0)
    expect(run(make(900, two)).filter((o) => o.verdict === 'clap')).toHaveLength(2)
    const echo = (t: number, n: () => number) => clap(0.5)(t, n) + (t >= 40 ? clap(0.2)(t - 40, n) : 0)
    expect(run(make(600, echo)).filter((o) => o.verdict === 'clap')).toHaveLength(1)
  })
})
