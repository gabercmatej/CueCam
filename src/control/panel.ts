/**
 * The Control window. It is opened by the Output page with window.open, so it lives in the
 * same renderer process and is driven directly from the Output's frame loop: no second
 * camera, no second tracker, no per-frame IPC. The preview is a mirrored, downscaled copy
 * of the Output canvas (one GPU blit), with the debug overlay drawn on top.
 */
import type { HandSide } from '../shared/types'
import type { FaceState } from '../output/perception/faceSmoother'
import type { FingerStates, Landmark } from '../output/perception/handGeometry'

export const CONTROL_WINDOW_NAME = 'skillcam-control'

/** Preview size (the Output is 16:9). */
const PREVIEW = { width: 640, height: 360 }
// The preview is mirrored, like a mirror: normalized raw camera x → (1 − x) · width.
const sx = (p: Landmark): number => (1 - p.x) * PREVIEW.width
const sy = (p: Landmark): number => p.y * PREVIEW.height

// MediaPipe hand skeleton (21 landmarks).
const BONES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]
]

const FINGER = { ext: '↑', curl: '↓', half: '~' }
const THUMB = { out: '↗', tucked: '·', half: '~' }

/** "T↗ I↑ M↓ R↓ P↑": the finger states our custom gestures are built from. */
export function fingerString(f: FingerStates): string {
  return `T${THUMB[f.thumb]} I${FINGER[f.index]} M${FINGER[f.middle]} R${FINGER[f.ring]} P${FINGER[f.pinky]}`
}

export interface OverlayHand {
  side: HandSide
  /** Predicted landmarks, normalized raw camera coordinates. */
  landmarks: Landmark[]
}

export interface HandLabel {
  side: HandSide
  label: string | null
  pinching: boolean
  fingers: FingerStates
}

const STYLE = `
  :root { color-scheme: dark; }
  html, body { margin: 0; background: #111214; color: #e8e8ea; font: 13px/1.45 Menlo, monospace; }
  main { padding: 12px; display: grid; gap: 10px; }
  canvas { width: ${PREVIEW.width}px; height: ${PREVIEW.height}px; background: #000; border-radius: 6px; display: block; }
  pre { margin: 0; white-space: pre-wrap; }
  .muted { color: #8b8d93; }
  .toggles { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
  input[type=range] { width: 120px; vertical-align: middle; }
  label { cursor: pointer; user-select: none; }
`

export interface AudioControls {
  sendToCall(on: boolean): void
  /** 0–1; 0 = monitor off. */
  monitorVolume(volume: number): void
}

interface LabelText {
  title: string
  detail: string
  pinching: boolean
}

export class ControlPanel {
  /** Overlay label text per side, rebuilt once per tracking result rather than per drawn frame. */
  private readonly labels = new Map<HandSide, LabelText>()
  private readonly ctx: CanvasRenderingContext2D
  private readonly stats: HTMLPreElement
  private readonly log: HTMLPreElement
  private readonly showMask: HTMLInputElement
  private readonly showFace: HTMLInputElement
  private readonly sendToCall: HTMLInputElement
  private readonly monitor: HTMLInputElement
  private readonly monitorText: HTMLSpanElement
  private audioHandlers: AudioControls | null = null
  /** The latest segmentation mask as a tinted image, rebuilt per mask only while the toggle is on. */
  private readonly maskCanvas: HTMLCanvasElement
  private maskImage: ImageData | null = null

  private constructor(private readonly win: Window) {
    const doc = win.document
    doc.head.replaceChildren()
    doc.body.replaceChildren()
    doc.title = 'Skillcam Control'
    const style = doc.createElement('style')
    style.textContent = STYLE
    doc.head.append(style)

    const canvas = doc.createElement('canvas')
    canvas.width = PREVIEW.width
    canvas.height = PREVIEW.height
    this.ctx = canvas.getContext('2d', { alpha: false })!
    this.stats = doc.createElement('pre')
    this.log = doc.createElement('pre')
    this.log.className = 'muted'
    this.maskCanvas = doc.createElement('canvas')
    const toggle = (text: string): [HTMLLabelElement, HTMLInputElement] => {
      const label = doc.createElement('label')
      const box = doc.createElement('input')
      box.type = 'checkbox'
      label.append(box, ` ${text}`)
      return [label, box]
    }
    const [maskLabel, showMask] = toggle('segmentation mask')
    const [faceLabel, showFace] = toggle('face box')
    this.showMask = showMask
    this.showFace = showFace
    const toggles = doc.createElement('div')
    toggles.className = 'toggles'
    toggles.append(maskLabel, faceLabel)

    // Call audio: the switch and the monitor volume act at once (not saved to the config).
    const [callLabel, sendToCall] = toggle('send to call')
    this.sendToCall = sendToCall
    sendToCall.addEventListener('change', () => this.audioHandlers?.sendToCall(sendToCall.checked))
    const monitorLabel = doc.createElement('label')
    this.monitor = doc.createElement('input')
    this.monitor.type = 'range'
    this.monitor.min = '0'
    this.monitor.max = '100'
    this.monitorText = doc.createElement('span')
    monitorLabel.append('monitor ', this.monitor, this.monitorText)
    this.monitor.addEventListener('input', () => {
      this.monitorText.textContent = ` ${this.monitor.value}%`
      this.audioHandlers?.monitorVolume(Number(this.monitor.value) / 100)
    })
    const audioRow = doc.createElement('div')
    audioRow.className = 'toggles'
    audioRow.append(callLabel, monitorLabel)

    const main = doc.createElement('main')
    main.append(canvas, toggles, audioRow, this.stats, this.log)
    doc.body.append(main)
  }

  /** Opens (or, after a reload of the Output, reuses) the Control window. Null if it was blocked. */
  static open(): ControlPanel | null {
    const win = window.open('', CONTROL_WINDOW_NAME)
    if (!win) {
      console.warn('[control] window could not be opened')
      return null
    }
    return new ControlPanel(win)
  }

  get closed(): boolean {
    return this.win.closed
  }

  setLabels(labels: HandLabel[]): void {
    this.labels.clear()
    for (const l of labels) {
      this.labels.set(l.side, {
        title: `${l.label ?? '—'}${l.pinching ? ' · Pinch' : ''}`,
        detail: `${l.side} ${fingerString(l.fingers)}`,
        pinching: l.pinching
      })
    }
  }

  /** A new segmentation mask (bytes, raw camera orientation). Only converted while the mask toggle is on. */
  setMask(data: Uint8Array, width: number, height: number): void {
    if (this.win.closed || !this.showMask.checked) return
    if (!this.maskImage || this.maskImage.width !== width || this.maskImage.height !== height) {
      this.maskCanvas.width = width
      this.maskCanvas.height = height
      this.maskImage = new ImageData(width, height)
    }
    const px = this.maskImage.data
    // Person = magenta, alpha follows confidence; background stays clear.
    for (let i = 0, j = 0; i < data.length; i++, j += 4) {
      px[j] = 255
      px[j + 1] = 40
      px[j + 2] = 200
      px[j + 3] = data[i]! >> 1
    }
    this.maskCanvas.getContext('2d')!.putImageData(this.maskImage, 0, 0)
  }

  /**
   * Copies the Output canvas, mirrored, then draws the overlay. Call right after the Output
   * renders, in the same task, so the WebGL drawing buffer is still valid.
   */
  drawPreview(output: HTMLCanvasElement, hands: OverlayHand[], face: FaceState | null): void {
    if (this.win.closed) return
    const g = this.ctx
    g.setTransform(-1, 0, 0, 1, PREVIEW.width, 0)
    g.drawImage(output, 0, 0, PREVIEW.width, PREVIEW.height)
    if (this.showMask.checked && this.maskImage) g.drawImage(this.maskCanvas, 0, 0, PREVIEW.width, PREVIEW.height)
    g.setTransform(1, 0, 0, 1, 0, 0)

    if (this.showFace.checked && face) {
      const b = face.box
      const x = (1 - (b.x + b.width)) * PREVIEW.width
      const y = b.y * PREVIEW.height
      g.lineWidth = 2
      g.setLineDash(face.visible ? [] : [6, 4])
      g.strokeStyle = face.visible ? '#4fc3ff' : '#ffb340'
      g.strokeRect(x, y, b.width * PREVIEW.width, b.height * PREVIEW.height)
      g.setLineDash([])
      g.font = '12px Menlo, monospace'
      g.textAlign = 'left'
      g.fillStyle = g.strokeStyle
      g.fillText(face.visible ? 'face' : 'face (held)', x, y - 5)
    }

    g.lineWidth = 1.5
    g.strokeStyle = 'rgba(255,255,255,0.6)'
    g.font = 'bold 13px Menlo, monospace'
    g.textAlign = 'center'
    for (const hand of hands) {
      const info = this.labels.get(hand.side)
      const pts = hand.landmarks
      g.beginPath()
      for (const [a, b] of BONES) {
        g.moveTo(sx(pts[a]!), sy(pts[a]!))
        g.lineTo(sx(pts[b]!), sy(pts[b]!))
      }
      g.stroke()
      g.fillStyle = info?.pinching ? '#ff4fd8' : '#33ff99'
      g.beginPath()
      for (let k = 0; k < pts.length; k++) {
        const r = k % 4 === 0 ? 3.5 : 2.5
        const x = sx(pts[k]!)
        const y = sy(pts[k]!)
        g.moveTo(x + r, y)
        g.arc(x, y, r, 0, Math.PI * 2)
      }
      g.fill()
      if (info) {
        const x = sx(pts[0]!)
        const y = sy(pts[0]!)
        g.fillStyle = '#ffe066'
        g.fillText(info.title, x, y + 18)
        g.fillStyle = '#ffffff'
        g.fillText(info.detail, x, y + 34)
      }
    }
  }

  onAudio(handlers: AudioControls): void {
    this.audioHandlers = handlers
  }

  /** Shows the current call switch and monitor volume (after a config change). */
  setAudioControls(sendToCall: boolean, monitorVolume: number): void {
    if (this.win.closed) return
    this.sendToCall.checked = sendToCall
    this.monitor.value = String(Math.round(monitorVolume * 100))
    this.monitorText.textContent = ` ${this.monitor.value}%`
  }

  setStats(lines: string[]): void {
    if (this.win.closed) return
    this.stats.textContent = lines.join('\n')
  }

  setLog(lines: string[]): void {
    if (this.win.closed) return
    this.log.textContent = lines.join('\n')
  }
}
