import { Container, Graphics, Text } from 'pixi.js'
import type { HandState } from '../perception/gestures'
import type { FingerStates } from '../perception/handGeometry'

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

const mono = (fill: string, fontSize: number) => ({
  fill,
  fontFamily: 'Menlo, monospace',
  fontSize,
  fontWeight: 'bold' as const,
  stroke: { color: '#000000', width: 5 }
})

/** Debug overlay: skeletons, our gesture name per hand, finger states, stats. Output-window only until Phase 2. */
export class Hud {
  private readonly hands = new Graphics()
  private readonly stats = new Text({ text: '', style: mono('#ffffff', 17) })
  private readonly labels: Text[] = []

  constructor(private readonly parent: Container) {
    this.stats.position.set(16, 12)
    parent.addChild(this.hands, this.stats)
  }

  drawHands(hands: HandState[]): void {
    const g = this.hands.clear()
    this.labels.forEach((l) => (l.visible = false))

    hands.forEach((hand, i) => {
      const p = hand.landmarks
      for (const [a, b] of BONES) g.moveTo(p[a]!.x, p[a]!.y).lineTo(p[b]!.x, p[b]!.y)
      g.stroke({ color: 0xffffff, width: 2, alpha: 0.6 })
      for (let k = 0; k < p.length; k++) g.circle(p[k]!.x, p[k]!.y, k % 4 === 0 ? 6 : 4)
      g.fill({ color: hand.pinching ? 0xff4fd8 : 0x33ff99 })

      const label = this.label(i)
      label.text = `${hand.label ?? '—'}${hand.pinching ? ' · Pinch' : ''}\n${hand.side} ${fingerString(hand.fingers)}`
      label.position.set(p[0]!.x - label.width / 2, p[0]!.y + 18)
      label.visible = true
    })
  }

  setStats(lines: string[]): void {
    this.stats.text = lines.join('\n')
  }

  private label(i: number): Text {
    let l = this.labels[i]
    if (!l) {
      l = new Text({ text: '', style: { ...mono('#ffe066', 22), align: 'center' } })
      this.labels[i] = l
      this.parent.addChild(l)
    }
    return l
  }
}
