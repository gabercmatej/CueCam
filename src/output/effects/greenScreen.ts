/**
 * Green-screen detection from a few small frame samples (RGBA bytes). A clip counts as green
 * screen when enough of its frame border is saturated green; the key colour is the mean of those
 * pixels, so a darker or yellower green screen is keyed by its own colour, not #00ff00.
 */

/** A pixel is "screen green" when green clearly dominates and is bright enough. */
function isScreenGreen(r: number, g: number, b: number): boolean {
  return g > 70 && g - Math.max(r, b) > 45 && g > 1.35 * Math.max(r, b)
}

/** Share of border pixels that must be screen green (curtains or a fireball may cover the rest). */
export const GREEN_BORDER_SHARE = 0.2

export interface GreenSample {
  data: Uint8ClampedArray
  width: number
  height: number
}

/** The key colour (#rrggbb) if the samples show a green screen, else null. */
export function detectGreenScreen(samples: readonly GreenSample[]): string | null {
  let r = 0
  let g = 0
  let b = 0
  let green = 0
  let best = 0
  for (const { data, width, height } of samples) {
    let border = 0
    let hits = 0
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // Two-pixel border, plus the whole frame for the colour estimate.
        const onBorder = x < 2 || y < 2 || x >= width - 2 || y >= height - 2
        const i = (y * width + x) * 4
        if (data[i + 3]! < 200) continue // transparent (alpha WebM): not a screen
        const pr = data[i]!
        const pg = data[i + 1]!
        const pb = data[i + 2]!
        if (!isScreenGreen(pr, pg, pb)) {
          if (onBorder) border++
          continue
        }
        r += pr
        g += pg
        b += pb
        green++
        if (onBorder) {
          border++
          hits++
        }
      }
    }
    if (border > 0) best = Math.max(best, hits / border)
  }
  if (best < GREEN_BORDER_SHARE || green === 0) return null
  const hex = (v: number): string => Math.round(v / green).toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}`
}

/** BT.709 chroma (Cb, Cr) distance of a #rrggbb colour from grey: how far the key sits from neutral colours. */
export function chromaMagnitude(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16)
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  return Math.hypot(-0.1146 * r - 0.3854 * g + 0.5 * b, 0.5 * r - 0.4542 * g - 0.0458 * b)
}

/**
 * Default key similarity for a key colour. Greys and whites have no chroma, so they sit at the
 * key's own chroma distance from it; the keyed band (similarity + the ~0.08 soft edge) must stop
 * short of that with a margin, or a fire's white-hot core keys out. A bright #00ff00 (chroma ≈ 0.6)
 * keeps the usual 0.4; a dark screen green like #018c22 (≈ 0.29) gets ≈ 0.16.
 */
export function autoSimilarity(keyColor: string): number {
  return Math.min(0.4, Math.max(0.05, chromaMagnitude(keyColor) - 0.13))
}
