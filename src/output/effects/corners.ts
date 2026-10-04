/**
 * Corner reactions: which corner a card goes to and where every card sits. Cards stack away from
 * their corner (top corners downward, bottom corners upward) in the order they arrived; the two
 * corners on one side share that column's height, so stacks never run into each other.
 */
import type { Point, ScreenBox } from '../../shared/types'

export type CornerName = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
export const CORNER_NAMES: readonly CornerName[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right']

export interface CornerCard {
  corner: CornerName
  width: number
  height: number
}

export interface CornerLayout {
  width: number
  height: number
  /** Distance from the frame edges. */
  margin: number
  /** Space between stacked cards. */
  gap: number
}

const isTop = (c: CornerName): boolean => c.startsWith('top')
const isLeft = (c: CornerName): boolean => c.endsWith('left')

/** Corners ordered from farthest to nearest the face (no face: top corners first, then bottom; right before left). */
export function cornersByDistance(face: ScreenBox | undefined, w: number, h: number): CornerName[] {
  if (!face) return ['top-right', 'top-left', 'bottom-right', 'bottom-left']
  const fx = face.x + face.width / 2
  const fy = face.y + face.height / 2
  const at = (c: CornerName): Point => ({ x: isLeft(c) ? 0 : w, y: isTop(c) ? 0 : h })
  return [...CORNER_NAMES].sort((a, b) => {
    const pa = at(a)
    const pb = at(b)
    return Math.hypot(pb.x - fx, pb.y - fy) - Math.hypot(pa.x - fx, pa.y - fy)
  })
}

/** Height a column (left or right side) already uses, including gaps. */
function columnHeight(cards: readonly CornerCard[], left: boolean, gap: number): number {
  let used = 0
  for (const c of cards) if (isLeft(c.corner) === left) used += c.height + gap
  return used
}

/**
 * The corner for a new card: the first of `preferred` whose column still has room for it.
 * Null = no room anywhere (the caller frees space by retiring the oldest card).
 */
export function chooseCorner(preferred: readonly CornerName[], cards: readonly CornerCard[], card: { height: number }, layout: CornerLayout): CornerName | null {
  const room = layout.height - 2 * layout.margin
  for (const corner of preferred) {
    if (columnHeight(cards, isLeft(corner), layout.gap) + card.height <= room) return corner
  }
  return null
}

/** Centre of every card (same order as `cards`). Reuses `out` (no per-frame allocation once sized). */
export function layoutCards(cards: readonly CornerCard[], layout: CornerLayout, out: Point[] = []): Point[] {
  const offset: Record<CornerName, number> = { 'top-left': 0, 'top-right': 0, 'bottom-left': 0, 'bottom-right': 0 }
  out.length = cards.length
  cards.forEach((c, i) => {
    const x = isLeft(c.corner) ? layout.margin + c.width / 2 : layout.width - layout.margin - c.width / 2
    const along = offset[c.corner] + c.height / 2
    const y = isTop(c.corner) ? layout.margin + along : layout.height - layout.margin - along
    offset[c.corner] += c.height + layout.gap
    const p = out[i] ?? { x: 0, y: 0 }
    p.x = x
    p.y = y
    out[i] = p
  })
  return out
}
