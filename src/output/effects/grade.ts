/** Colour grade applied to the camera (both camera layers), or to everything, plus a screen vignette. */
export interface Grade {
  /** Colour effects too (gradeScope "all"), not just the camera. */
  all: boolean
  /** 0 = black and white, 1 = unchanged, up to 2 = boosted. */
  saturation: number
  /** Tint colour, linear 0–1 RGB. */
  tint: [number, number, number]
  /** How much of the tint is mixed in (0 = none). */
  tintAmount: number
  /** 0 = none, 1 = edges almost black. */
  vignette: number
}

export interface ActiveGrade {
  /** gradeScope "all": this grade colours the effects too. */
  all?: boolean
  start: number
  durationMs: number
  fadeMs: number
  target: Omit<Grade, 'all'>
}

export const NEUTRAL_GRADE: Readonly<Grade> = Object.freeze({ all: false, saturation: 1, tint: [1, 1, 1] as [number, number, number], tintAmount: 0, vignette: 0 })

const smooth = (t: number): number => t * t * (3 - 2 * t)

/** 0→1 over the fade-in, 1 while held, 1→0 over the fade-out; 0 outside the effect. */
export function gradeEnvelope(g: ActiveGrade, now: number): number {
  const t = now - g.start
  if (t < 0 || t >= g.durationMs) return 0
  const fade = Math.min(g.fadeMs, g.durationMs / 2)
  if (fade <= 0) return 1
  return smooth(Math.min(1, t / fade, (g.durationMs - t) / fade))
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/**
 * Combines overlapping grades into `out` (no allocation per frame): the strongest saturation
 * change wins, the strongest vignette wins, the tint amount is the strongest one and its colour
 * is the mix of the active tints weighted by their current strength (no pop when one tint hands
 * over to another). Each grade's effect is scaled by its envelope, so it animates in and out.
 * If any active grade has scope "all", the combined grade colours everything.
 */
export function combineGrades(grades: readonly ActiveGrade[], now: number, out: Grade): Grade {
  out.all = false
  out.saturation = 1
  out.tintAmount = 0
  out.vignette = 0
  let r = 0
  let gr = 0
  let b = 0
  let weight = 0
  for (const g of grades) {
    const e = gradeEnvelope(g, now)
    if (e <= 0) continue
    if (g.all) out.all = true
    const s = 1 + (g.target.saturation - 1) * e
    if (Math.abs(s - 1) > Math.abs(out.saturation - 1)) out.saturation = s
    out.vignette = Math.max(out.vignette, g.target.vignette * e)
    const tint = g.target.tintAmount * e
    if (tint <= 0) continue
    out.tintAmount = Math.max(out.tintAmount, tint)
    r += g.target.tint[0] * tint
    gr += g.target.tint[1] * tint
    b += g.target.tint[2] * tint
    weight += tint
  }
  out.tint[0] = weight > 0 ? r / weight : 1
  out.tint[1] = weight > 0 ? gr / weight : 1
  out.tint[2] = weight > 0 ? b / weight : 1
  return out
}
