import { describe, expect, it } from 'vitest'
import { type ActiveGrade, combineGrades, type Grade, gradeEnvelope, hexToRgb, NEUTRAL_GRADE } from './grade'

const fresh = (): Grade => ({ ...NEUTRAL_GRADE, tint: [1, 1, 1] })
const bw: ActiveGrade = { start: 0, durationMs: 1500, fadeMs: 250, target: { saturation: 0, tint: [1, 1, 1], tintAmount: 0, vignette: 0.7 } }
const gold: ActiveGrade = { start: 0, durationMs: 3000, fadeMs: 400, target: { saturation: 1.1, tint: hexToRgb('#ffb340'), tintAmount: 0.5, vignette: 0.4 } }

describe('gradeEnvelope', () => {
  it('fades in, holds, fades out, and is off outside the effect', () => {
    expect(gradeEnvelope(bw, -1)).toBe(0)
    expect(gradeEnvelope(bw, 0)).toBe(0)
    expect(gradeEnvelope(bw, 125)).toBeCloseTo(0.5)
    expect(gradeEnvelope(bw, 250)).toBe(1)
    expect(gradeEnvelope(bw, 1000)).toBe(1)
    expect(gradeEnvelope(bw, 1375)).toBeCloseTo(0.5)
    expect(gradeEnvelope(bw, 1500)).toBe(0)
  })

  it('shortens the fades when the effect is shorter than both together', () => {
    const short = { ...bw, durationMs: 200 }
    expect(gradeEnvelope(short, 100)).toBe(1)
  })
})

describe('combineGrades', () => {
  it('colours everything while any active grade has scope "all"', () => {
    expect(combineGrades([bw, { ...gold, all: true }], 1000, fresh()).all).toBe(true)
    expect(combineGrades([bw, { ...gold, all: true, durationMs: 900 }], 1000, fresh()).all).toBe(false)
  })

  it('is neutral with nothing active', () => {
    expect(combineGrades([], 0, fresh())).toEqual(NEUTRAL_GRADE)
  })

  it('animates saturation and vignette with the envelope', () => {
    const half = combineGrades([bw], 125, fresh())
    expect(half.saturation).toBeCloseTo(0.5)
    expect(half.vignette).toBeCloseTo(0.35)
    expect(combineGrades([bw], 600, fresh())).toMatchObject({ saturation: 0, vignette: 0.7 })
  })

  it('combines overlapping grades: strongest saturation change, strongest vignette, strongest tint', () => {
    const g = combineGrades([bw, gold], 1000, fresh())
    expect(g.saturation).toBe(0)
    expect(g.vignette).toBeCloseTo(0.7)
    expect(g.tintAmount).toBeCloseTo(0.5)
    expect(g.tint).toEqual(hexToRgb('#ffb340'))
  })

  it('blends overlapping tints by strength instead of switching colours abruptly', () => {
    const blue: ActiveGrade = { start: 0, durationMs: 3000, fadeMs: 400, target: { saturation: 1, tint: [0, 0, 1], tintAmount: 0.5, vignette: 0 } }
    const red: ActiveGrade = { ...blue, target: { ...blue.target, tint: [1, 0, 0] } }
    const g = combineGrades([red, blue], 1000, fresh())
    expect(g.tint).toEqual([0.5, 0, 0.5])
    expect(g.tintAmount).toBeCloseTo(0.5)
    // As red fades out, its share of the colour shrinks smoothly.
    const later = combineGrades([{ ...red, durationMs: 1200 }, blue], 1100, fresh())
    expect(later.tint[0]).toBeGreaterThan(0)
    expect(later.tint[0]).toBeLessThan(0.5)
  })

  it('writes into the given object (no per-frame allocation)', () => {
    const out = fresh()
    expect(combineGrades([gold], 1000, out)).toBe(out)
  })
})
