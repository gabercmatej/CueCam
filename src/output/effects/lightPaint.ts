/**
 * Light painting: while the hand that triggered it stays pinched, glowing dots are stamped along
 * the pinch point's path into a render texture (one per hand). The drawing is one full-frame
 * sprite, so a long stroke costs nothing more per frame than a short one: no geometry is rebuilt,
 * only the newest segment is drawn. Releasing the pinch fades the drawing out quickly and clears it.
 */
import { Container, Graphics, RenderTexture, type Renderer, Sprite, type Texture } from 'pixi.js'
import type { EffectConfig } from '../../shared/config'
import type { EffectContext, HandSide, Point } from '../../shared/types'
import { hexToRgb } from './grade'

type LightPaintConfig = Extract<EffectConfig, { type: 'lightPaint' }>

/** Most dots stamped per frame per hand (a fast flick is subsampled, not a long task). */
const MAX_STAMPS = 48
/** Pen smoothing per frame (0–1): steadies landmark jitter at the cost of a little lag. */
const PEN_SMOOTHING = 0.55
/** Rainbow: hue turns this many degrees per stage px of stroke. */
const HUE_PER_PX = 0.45
/**
 * The pinch must be gone this long before the stroke ends: one missed tracking sample (hand
 * dropped for a frame, motion blur past the pinch threshold) must not wipe the drawing. Shorter
 * than the stabilizer's release, so a real re-pinch after this always fires a new Pinch.
 */
const RELEASE_GRACE_MS = 200

interface Stroke {
  cfg: LightPaintConfig
  rt: RenderTexture
  sprite: Sprite
  /** Drawing (pinched), fading out, or idle (cleared). */
  state: 'drawing' | 'fading' | 'idle'
  pen: Point | null
  /** When the pinch was last missing while drawing (null = pinched now). */
  lostAt: number | null
  hue: number
  fadeStart: number
}

function hsvToRgb(h: number): number {
  const f = (n: number): number => {
    const k = (n + h / 60) % 6
    return Math.round(255 * (1 - Math.max(0, Math.min(k, 4 - k, 1))))
  }
  return (f(5) << 16) | (f(3) << 8) | f(1)
}

export class LightPaint {
  private readonly strokes = new Map<HandSide, Stroke>()
  private readonly glow: Texture
  /** Pooled stamp sprites, rendered into a stroke's texture each frame (glow + core per dot). */
  private readonly stamps = new Container()
  private readonly glows: Sprite[] = []
  private readonly cores: Sprite[] = []

  constructor(
    private readonly layer: Container,
    private readonly renderer: Renderer,
    private readonly width: number,
    private readonly height: number,
    private readonly resolution: number
  ) {
    // A soft round dot: rings of falling alpha.
    const g = new Graphics()
    for (let r = 32; r > 0; r -= 2) g.circle(32, 32, r).fill({ color: 0xffffff, alpha: 0.06 + 0.5 * (1 - r / 32) ** 3 })
    this.glow = renderer.generateTexture({ target: g, resolution: 1 })
    g.destroy()
    for (let i = 0; i < MAX_STAMPS; i++) {
      const glow = new Sprite({ texture: this.glow, anchor: 0.5, blendMode: 'add' })
      const core = new Sprite({ texture: this.glow, anchor: 0.5, blendMode: 'add' })
      this.glows.push(glow)
      this.cores.push(core)
      this.stamps.addChild(glow, core)
    }
  }

  get active(): number {
    let n = 0
    for (const s of this.strokes.values()) if (s.state !== 'idle') n++
    return n
  }

  /** Starts drawing for the hand that pinched. */
  play(cfg: LightPaintConfig, ctx: EffectContext): void {
    const side = ctx.hand === 'Left' || ctx.hand === 'Right' ? ctx.hand : 'Right'
    let s = this.strokes.get(side)
    if (!s) {
      const rt = RenderTexture.create({ width: this.width, height: this.height, resolution: this.resolution })
      const sprite = new Sprite(rt)
      sprite.blendMode = 'add'
      this.layer.addChild(sprite)
      s = { cfg, rt, sprite, state: 'idle', pen: null, lostAt: null, hue: Math.random() * 360, fadeStart: 0 }
      this.strokes.set(side, s)
    }
    if (s.state === 'fading') this.clear(s)
    s.cfg = cfg
    s.state = 'drawing'
    s.lostAt = null
    s.sprite.alpha = 1
    s.sprite.visible = true
    s.pen = ctx.position ? { x: ctx.position.x, y: ctx.position.y } : null
  }

  /** Disarmed: every drawing starts fading out now, as if the pinch was released. */
  windDown(now: number): void {
    for (const s of this.strokes.values()) {
      if (s.state !== 'drawing') continue
      // Quickly, whatever the effect's own fade (play() restores its config).
      if (s.cfg.fadeMs > 250) s.cfg = { ...s.cfg, fadeMs: 250 }
      s.state = 'fading'
      s.fadeStart = now
    }
  }

  /**
   * Per frame. `pinch(side)` is the pinch point for a hand still pinching, or null once released
   * (or the hand is gone).
   */
  update(now: number, pinch: (side: HandSide) => Point | null): void {
    for (const [side, s] of this.strokes) {
      if (s.state === 'drawing') {
        const p = pinch(side)
        if (!p) {
          s.lostAt ??= now
          if (now - s.lostAt >= RELEASE_GRACE_MS) {
            s.state = 'fading'
            s.fadeStart = now
          }
          continue
        }
        // Back within the grace period: carry on the same line.
        s.lostAt = null
        this.drawTo(s, p)
      } else if (s.state === 'fading') {
        const t = s.cfg.fadeMs > 0 ? (now - s.fadeStart) / s.cfg.fadeMs : 1
        if (t >= 1) this.clear(s)
        else s.sprite.alpha = 1 - t
      }
    }
  }

  private drawTo(s: Stroke, target: Point): void {
    if (!s.pen) {
      s.pen = { x: target.x, y: target.y }
      return
    }
    const fromX = s.pen.x
    const fromY = s.pen.y
    s.pen.x += (target.x - s.pen.x) * PEN_SMOOTHING
    s.pen.y += (target.y - s.pen.y) * PEN_SMOOTHING
    const dx = s.pen.x - fromX
    const dy = s.pen.y - fromY
    const len = Math.hypot(dx, dy)
    const width = s.cfg.width
    const spacing = Math.max(1.5, width * 0.3)
    const n = Math.min(MAX_STAMPS, Math.max(1, Math.ceil(len / spacing)))
    const fixed = s.cfg.color === 'rainbow' ? null : hexToRgb(s.cfg.color)
    const fixedTint = fixed ? (Math.round(fixed[0] * 255) << 16) | (Math.round(fixed[1] * 255) << 8) | Math.round(fixed[2] * 255) : 0
    for (let i = 0; i < MAX_STAMPS; i++) {
      const glow = this.glows[i]!
      const core = this.cores[i]!
      const on = i < n
      glow.visible = on
      core.visible = on
      if (!on) continue
      const t = (i + 1) / n
      const x = fromX + dx * t
      const y = fromY + dy * t
      if (!fixed) s.hue = (s.hue + (len / n) * HUE_PER_PX) % 360
      const tint = fixed ? fixedTint : hsvToRgb(s.hue)
      glow.position.set(x, y)
      glow.scale.set((width * 2.6) / 64)
      glow.tint = tint
      glow.alpha = 0.18
      core.position.set(x, y)
      core.scale.set((width * 0.7) / 64)
      core.tint = 0xffffff
      core.alpha = 0.55
    }
    this.renderer.render({ container: this.stamps, target: s.rt, clear: false })
  }

  private clear(s: Stroke): void {
    // Render the pool with every stamp hidden: a clear and nothing drawn.
    for (let i = 0; i < MAX_STAMPS; i++) {
      this.glows[i]!.visible = false
      this.cores[i]!.visible = false
    }
    this.renderer.render({ container: this.stamps, target: s.rt, clear: true, clearColor: [0, 0, 0, 0] })
    s.state = 'idle'
    s.pen = null
    s.lostAt = null
    s.sprite.visible = false
    s.sprite.alpha = 1
  }
}
