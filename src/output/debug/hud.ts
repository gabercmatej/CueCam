import { Container, Graphics, Text } from 'pixi.js'
import type { HandResult } from '../perception/hands'
import { FRAME_HEIGHT, FRAME_WIDTH } from '../camera'

// MediaPipe hand skeleton (21 landmarks).
const BONES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]
]

/** Phase 0 spike overlay: landmark dots, gesture labels, FPS/timing, last word. */
export class Hud {
  private readonly hands = new Graphics()
  private readonly stats = new Text({
    text: '',
    style: { fill: '#ffffff', fontFamily: 'Menlo, monospace', fontSize: 18, stroke: { color: '#000000', width: 4 } }
  })
  private readonly labels: Text[] = []

  constructor(parent: Container) {
    this.stats.position.set(16, 12)
    parent.addChild(this.hands, this.stats)
  }

  drawHands(result: HandResult | null): void {
    const g = this.hands.clear()
    this.labels.forEach((l) => (l.visible = false))
    if (!result) return

    result.landmarks.forEach((points, i) => {
      const px = (k: number): [number, number] => [points[k]!.x * FRAME_WIDTH, points[k]!.y * FRAME_HEIGHT]
      for (const [a, b] of BONES) g.moveTo(...px(a)).lineTo(...px(b))
      g.stroke({ color: 0xffffff, width: 2, alpha: 0.6 })
      for (let k = 0; k < points.length; k++) g.circle(...px(k), k % 4 === 0 ? 6 : 4)
      g.fill({ color: 0x33ff99 })

      const top = result.gestures[i]?.[0]
      const side = result.handedness[i]?.[0]?.categoryName ?? '?'
      const label = this.label(i)
      label.text = `${top?.categoryName ?? '—'} ${top ? top.score.toFixed(2) : ''} (${side})`
      const [wx, wy] = px(0)
      label.position.set(wx - label.width / 2, wy + 16)
      label.visible = true
    })
  }

  setStats(lines: string[]): void {
    this.stats.text = lines.join('\n')
  }

  private label(i: number): Text {
    let l = this.labels[i]
    if (!l) {
      l = new Text({
        text: '',
        style: { fill: '#ffe066', fontFamily: 'Menlo, monospace', fontSize: 22, fontWeight: 'bold', stroke: { color: '#000000', width: 5 } }
      })
      this.labels[i] = l
      this.hands.parent?.addChild(l)
    }
    return l
  }
}
