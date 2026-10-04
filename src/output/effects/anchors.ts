import type { Anchor } from '../../shared/config'
import type { EffectContext } from '../../shared/types'

/** A spawn point in screen space, with the direction effects should travel (radians, y down). */
export interface AnchorPoint {
  x: number
  y: number
  angle: number
}

const UP = -Math.PI / 2

/**
 * Where an effect appears for a given anchor. Hand and face anchors are already in screen space;
 * hands fall back to visible hands, then the center; the face falls back to the center. Screen-fixed anchors ("bottom-left", …) are
 * defined in Output space, what the call sees; a mirrored view flips them.
 */
export function resolveAnchors(anchor: Anchor, ctx: EffectContext, w: number, h: number, mirror = false): AnchorPoint[] {
  if (mirror && anchor !== 'hand' && anchor !== 'between-hands' && anchor !== 'face') {
    return resolveAnchors(anchor, ctx, w, h).map((p) => ({ x: w - p.x, y: p.y, angle: Math.PI - p.angle }))
  }
  const center = { x: w / 2, y: h / 2 }
  const hand = ctx.position ?? ctx.hands[0] ?? center
  switch (anchor) {
    case 'hand':
      return [{ ...hand, angle: UP }]
    case 'between-hands': {
      const [a, b] = ctx.hands
      const mid = ctx.position ?? (a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : hand)
      return [{ ...mid, angle: UP }]
    }
    case 'bottom-corners':
      return [
        { x: 0, y: h, angle: -Math.PI / 3 },
        { x: w, y: h, angle: (-2 * Math.PI) / 3 }
      ]
    case 'center':
      return [{ ...center, angle: UP }]
    case 'face': {
      const f = ctx.face
      return [{ ...(f ? { x: f.x + f.width / 2, y: f.y + f.height / 2 } : center), angle: UP }]
    }
    case 'top-left':
      return [{ x: 0, y: 0, angle: Math.PI / 4 }]
    case 'top-right':
      return [{ x: w, y: 0, angle: (3 * Math.PI) / 4 }]
    case 'bottom-left':
      return [{ x: 0, y: h, angle: -Math.PI / 4 }]
    case 'bottom-right':
      return [{ x: w, y: h, angle: (-3 * Math.PI) / 4 }]
    case 'bottom-center':
      return [{ x: w / 2, y: h, angle: UP }]
  }
}

/** Which point of a clip sits on its anchor (e.g. bottom-left clips hug the bottom-left corner). */
export function clipAlignment(anchor: Anchor, mirror = false): { x: number; y: number } {
  if (mirror) {
    const a = clipAlignment(anchor)
    return { x: 1 - a.x, y: a.y }
  }
  switch (anchor) {
    case 'top-left':
      return { x: 0, y: 0 }
    case 'top-right':
      return { x: 1, y: 0 }
    case 'bottom-left':
      return { x: 0, y: 1 }
    case 'bottom-right':
      return { x: 1, y: 1 }
    case 'bottom-center':
    case 'bottom-corners':
      return { x: 0.5, y: 1 }
    default:
      return { x: 0.5, y: 0.5 }
  }
}
