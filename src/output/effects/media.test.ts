import { describe, expect, it } from 'vitest'
import { chooseCorner, cornersByDistance, layoutCards, type CornerCard } from './corners'
import { autoSimilarity, detectGreenScreen } from './greenScreen'
import { pickVariant } from './variants'

describe('pickVariant', () => {
  it('never picks the same file twice in a row', () => {
    const files = ['a', 'b', 'c']
    let last: string | undefined
    let seed = 1
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (let i = 0; i < 300; i++) {
      const next = pickVariant(files, last, rand)
      expect(next).not.toBe(last)
      last = next
    }
  })

  it('uses every variant', () => {
    const seen = new Set<string>()
    let last: string | undefined
    for (let i = 0; i < 60; i++) seen.add((last = pickVariant(['a', 'b', 'c'], last, Math.random))!)
    expect(seen.size).toBe(3)
  })

  it('repeats the only file, and returns nothing for none', () => {
    expect(pickVariant(['a'], 'a', Math.random)).toBe('a')
    expect(pickVariant([], undefined, Math.random)).toBeUndefined()
  })

  it('picks among the others when rand is at its extremes', () => {
    expect(pickVariant(['a', 'b', 'c'], 'a', () => 0)).toBe('b')
    expect(pickVariant(['a', 'b', 'c'], 'c', () => 0.999)).toBe('b')
    expect(pickVariant(['a', 'b', 'c'], 'b', () => 0.999)).toBe('c')
  })
})

describe('corners', () => {
  const layout = { width: 1280, height: 720, margin: 20, gap: 12 }

  it('orders corners farthest from the face first', () => {
    // Face in the top right: bottom left is farthest.
    expect(cornersByDistance({ x: 900, y: 50, width: 200, height: 200 }, 1280, 720)[0]).toBe('bottom-left')
    expect(cornersByDistance({ x: 100, y: 400, width: 200, height: 200 }, 1280, 720)[0]).toBe('top-right')
  })

  it('stacks cards away from their corner without overlap', () => {
    const cards: CornerCard[] = [
      { corner: 'top-right', width: 200, height: 150 },
      { corner: 'top-right', width: 100, height: 200 },
      { corner: 'bottom-left', width: 180, height: 120 }
    ]
    const [a, b, c] = layoutCards(cards, layout)
    expect(a).toEqual({ x: 1280 - 20 - 100, y: 20 + 75 })
    expect(b).toEqual({ x: 1280 - 20 - 50, y: 20 + 150 + 12 + 100 })
    expect(c).toEqual({ x: 20 + 90, y: 720 - 20 - 60 })
  })

  it('moves to the next corner when a column is full, and reports no room at all', () => {
    const tall = { height: 400 }
    const order = cornersByDistance(undefined, 1280, 720)
    const cards: CornerCard[] = [{ corner: 'top-right', width: 100, height: 400 }]
    expect(chooseCorner(order, cards, tall, layout)).toBe('top-left')
    cards.push({ corner: 'top-left', width: 100, height: 400 })
    expect(chooseCorner(order, cards, tall, layout)).toBeNull()
    expect(chooseCorner(order, cards, { height: 200 }, layout)).toBe('top-right')
  })
})

describe('detectGreenScreen', () => {
  const frame = (w: number, h: number, px: (x: number, y: number) => [number, number, number, number]) => {
    const data = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(px(x, y), (y * w + x) * 4)
    return { data, width: w, height: h }
  }

  it('detects a green screen and takes its own colour as the key', () => {
    const f = frame(32, 18, (x, y) => (x > 10 && x < 20 && y > 5 && y < 12 ? [200, 120, 40, 255] : [28, 154, 60, 255]))
    expect(detectGreenScreen([f])).toBe('#1c9a3c')
  })

  it('ignores ordinary footage and transparent (alpha) frames', () => {
    expect(detectGreenScreen([frame(32, 18, () => [120, 110, 100, 255])])).toBeNull()
    expect(detectGreenScreen([frame(32, 18, () => [0, 0, 0, 0])])).toBeNull()
  })

  it('finds the screen in any sample (first frame covered by curtains)', () => {
    const covered = frame(32, 18, () => [150, 20, 20, 255])
    const open = frame(32, 18, (x) => (x < 8 ? [150, 20, 20, 255] : [0, 255, 0, 255]))
    expect(detectGreenScreen([covered, open])).toBe('#00ff00')
  })
})

describe('autoSimilarity', () => {
  it('keeps 0.4 for a bright green and tightens it for a dark one (so whites survive)', () => {
    expect(autoSimilarity('#00ff00')).toBe(0.4)
    const dark = autoSimilarity('#018c22')
    expect(dark).toBeLessThan(0.2)
    expect(dark).toBeGreaterThan(0.1)
  })
})
