/**
 * "What the AI sees", for the web demo only (the desktop Output never creates this): the hand
 * skeletons with their live gesture labels, the segmentation mask and the face box, drawn over the
 * effects inside the scene (so a camera shake moves them with the picture).
 *
 * Cost: hands are drawn from the landmarks the smoother predicts for the frame on screen, so they
 * move every frame. Each hand is a fixed set of sprites (per bone a soft glow and a thin core, per
 * landmark a dot) whose transforms are set per frame: no geometry is rebuilt, and Pixi batches them
 * into one draw call. The label Text re-renders only when the gesture changes, the mask is one quad
 * sampling the existing mask texture, and the face box moves by its transform (redrawn on a size change).
 */
import { Container, Graphics, Sprite, Text, Texture } from 'pixi.js'
import type { OverlayName } from '../../shared/api'
import type { HandSide, ScreenBox } from '../../shared/types'
import type { Landmark } from '../perception/handGeometry'
import type { View } from '../view'

// MediaPipe hand skeleton (21 landmarks), as in the Control panel's preview.
const BONES: readonly (readonly [number, number])[] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]
]
const TIPS = new Set([4, 8, 12, 16, 20])
/** One colour per hand (your left: cool cyan, your right: warm amber), white joints. */
const HAND_COLOR: Record<HandSide, number> = { Left: 0x5ad1ff, Right: 0xffb347 }
const PULSE_MS = 420
const FACE_COLOR = 0x8fd3ff
const FACE_LOST = 0xffb347

export interface OverlayHand {
  side: HandSide
  landmarks: readonly Landmark[]
}

/** Canvas-drawn textures, made once: a line profile soft across its width (glow) and a round dot. */
function makeTextures(): { glow: Texture; core: Texture; dot: Texture } {
  const canvas = (w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): Texture => {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    draw(c.getContext('2d')!)
    return Texture.from(c)
  }
  const across = (stops: [number, number][]) => (g: CanvasRenderingContext2D): void => {
    const grad = g.createLinearGradient(0, 0, 0, 32)
    for (const [at, a] of stops) grad.addColorStop(at, `rgba(255,255,255,${a})`)
    g.fillStyle = grad
    g.fillRect(0, 0, 4, 32)
  }
  return {
    glow: canvas(4, 32, across([[0, 0], [0.5, 0.55], [1, 0]])),
    core: canvas(4, 32, across([[0, 0], [0.3, 0.9], [0.5, 1], [0.7, 0.9], [1, 0]])),
    dot: canvas(32, 32, (g) => {
      const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16)
      grad.addColorStop(0, 'rgba(255,255,255,1)')
      grad.addColorStop(0.55, 'rgba(255,255,255,1)')
      grad.addColorStop(1, 'rgba(255,255,255,0)')
      g.fillStyle = grad
      g.fillRect(0, 0, 32, 32)
    })
  }
}

interface HandDraw {
  skeleton: Container
  glows: Sprite[]
  cores: Sprite[]
  dots: Sprite[]
  /** The cores are white during a pulse (tint is only reassigned when this flips). */
  white: boolean
  label: Text
  pill: Graphics
  text: string
  pulseAt: number
}

export class AiOverlays {
  readonly root = new Container()
  private readonly hands: Record<HandSide, HandDraw>
  private readonly face = new Graphics()
  private faceW = -1
  private faceH = -1
  private faceSolid = false

  constructor(
    private readonly view: View,
    private readonly maskTint: Container
  ) {
    const tex = makeTextures()
    const make = (side: HandSide): HandDraw => {
      const skeleton = new Container()
      const sprite = (texture: Texture, anchorX: number): Sprite => {
        const s = new Sprite(texture)
        s.anchor.set(anchorX, 0.5)
        skeleton.addChild(s)
        return s
      }
      const glows = BONES.map(() => sprite(tex.glow, 0))
      const cores = BONES.map(() => sprite(tex.core, 0))
      const dots = Array.from({ length: 21 }, () => sprite(tex.dot, 0.5))
      for (const s of [...glows, ...cores]) s.tint = HAND_COLOR[side]
      skeleton.visible = false
      const pill = new Graphics()
      const label = new Text({
        text: '',
        style: { fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif', fontSize: 15, fontWeight: '600', fill: 0xffffff },
        resolution: 2
      })
      label.anchor.set(0.5, 0)
      pill.visible = false
      label.visible = false
      return { skeleton, glows, cores, dots, white: false, label, pill, text: '', pulseAt: -Infinity }
    }
    this.hands = { Left: make('Left'), Right: make('Right') }
    this.root.addChild(maskTint, this.face)
    for (const side of ['Left', 'Right'] as const) this.root.addChild(this.hands[side].skeleton, this.hands[side].pill, this.hands[side].label)
  }

  /** A gesture fired with this hand (or both): its skeleton pulses briefly. */
  pulse(side: HandSide | 'Both', now: number): void {
    if (side !== 'Right') this.hands.Left.pulseAt = now
    if (side !== 'Left') this.hands.Right.pulseAt = now
  }

  update(
    now: number,
    on: Readonly<Record<OverlayName, boolean>>,
    hands: readonly OverlayHand[],
    labelOf: (side: HandSide) => string,
    face: ScreenBox | null,
    faceVisible: boolean,
    maskFresh: boolean
  ): void {
    this.maskTint.visible = on.mask && maskFresh
    this.drawFace(on.face ? face : null, faceVisible)
    for (const side of ['Left', 'Right'] as const) {
      let hand: OverlayHand | undefined
      if (on.hands) for (const h of hands) if (h.side === side) hand = h
      this.drawHand(this.hands[side], side, hand, hand ? labelOf(side) : '', now)
    }
  }

  private x(p: Landmark): number {
    return (this.view.mirror ? 1 - p.x : p.x) * this.view.width
  }

  private y(p: Landmark): number {
    return p.y * this.view.height
  }

  private drawHand(d: HandDraw, side: HandSide, hand: OverlayHand | undefined, text: string, now: number): void {
    d.skeleton.visible = hand !== undefined
    if (!hand) {
      d.label.visible = false
      d.pill.visible = false
      return
    }
    const lm = hand.landmarks
    const color = HAND_COLOR[side]
    const pulse = Math.max(0, 1 - (now - d.pulseAt) / PULSE_MS)
    // A wide soft line under a thin bright one reads as a glow, without a blur filter.
    // Texture height is 32 px: the scale sets the drawn width of each line.
    const glowH = (16 + 22 * pulse) / 32
    const coreH = (4 + 3 * pulse) / 32
    const glowA = 0.35 + 0.4 * pulse
    for (let i = 0; i < BONES.length; i++) {
      const [a, b] = BONES[i]!
      const x0 = this.x(lm[a]!)
      const y0 = this.y(lm[a]!)
      const dx = this.x(lm[b]!) - x0
      const dy = this.y(lm[b]!) - y0
      const len = Math.hypot(dx, dy)
      const rot = Math.atan2(dy, dx)
      const glow = d.glows[i]!
      glow.position.set(x0, y0)
      glow.rotation = rot
      glow.scale.set(len / 4, glowH)
      glow.alpha = glowA
      const core = d.cores[i]!
      core.position.set(x0, y0)
      core.rotation = rot
      core.scale.set(len / 4, coreH)
    }
    const white = pulse > 0.5
    if (white !== d.white) {
      d.white = white
      for (const core of d.cores) core.tint = white ? 0xffffff : color
    }
    for (let i = 0; i < d.dots.length; i++) {
      const dot = d.dots[i]!
      dot.position.set(this.x(lm[i]!), this.y(lm[i]!))
      dot.scale.set(((TIPS.has(i) ? 7 : 5.5) + 3 * pulse) / 32)
    }

    if (text !== d.text) {
      d.text = text
      d.label.text = text
      const w = d.label.width + 18
      const h = d.label.height + 8
      d.pill.clear().roundRect(-w / 2, 0, w, h, h / 2).fill({ color: 0x101010, alpha: 0.72 }).stroke({ width: 1.5, color, alpha: 0.9 })
    }
    const show = text !== ''
    d.label.visible = show
    d.pill.visible = show
    if (show) {
      // Under the wrist, kept inside the frame.
      const wx = Math.min(this.view.width - 60, Math.max(60, this.x(lm[0]!)))
      const wy = Math.min(this.view.height - 34, this.y(lm[0]!) + 14)
      d.pill.position.set(wx, wy)
      d.label.position.set(wx, wy + 4)
      const s = 1 + 0.12 * pulse
      d.pill.scale.set(s)
      d.label.scale.set(s)
    }
  }

  /**
   * The face box moves by its transform every frame; its outline is redrawn only when the size changes
   * by a few pixels (or it turns dashed/solid), so a moving head doesn't rebuild geometry per frame.
   */
  private drawFace(box: ScreenBox | null, visible: boolean): void {
    this.face.visible = box !== null
    if (!box) return
    this.face.position.set(box.x, box.y)
    const w = Math.round(box.width / 4) * 4
    const h = Math.round(box.height / 4) * 4
    if (w === this.faceW && h === this.faceH && visible === this.faceSolid) return
    this.faceW = w
    this.faceH = h
    this.faceSolid = visible
    const g = this.face.clear()
    if (visible) {
      g.roundRect(0, 0, w, h, Math.min(w, h) * 0.18).stroke({ width: 2.5, color: FACE_COLOR, alpha: 0.9 })
      return
    }
    // Lost or covered: the held box, dashed.
    const dash = 12
    const gap = 9
    const edges: [number, number, number, number][] = [
      [0, 0, w, 0],
      [w, 0, w, h],
      [w, h, 0, h],
      [0, h, 0, 0]
    ]
    for (const [x0, y0, x1, y1] of edges) {
      const len = Math.hypot(x1 - x0, y1 - y0)
      for (let t = 0; t < len; t += dash + gap) {
        const p = t / len
        const q = Math.min(len, t + dash) / len
        g.moveTo(x0 + (x1 - x0) * p, y0 + (y1 - y0) * p).lineTo(x0 + (x1 - x0) * q, y0 + (y1 - y0) * q)
      }
    }
    g.stroke({ width: 2.5, color: FACE_LOST, alpha: 0.9 })
  }
}
