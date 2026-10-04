import type { Container } from 'pixi.js'
import type { EffectConfig } from '../../shared/config'
import type { EffectContext, Point } from '../../shared/types'
import { resolveAnchors } from './anchors'
import { type ActiveGrade, combineGrades, type Grade, hexToRgb, NEUTRAL_GRADE } from './grade'

type CameraMoveConfig = Extract<EffectConfig, { type: 'cameraMove' }>

export interface ActiveMove {
  kind: 'shake' | 'zoom'
  start: number
  durationMs: number
  intensity: number
  amount: number
  focus: Point
}

export interface CameraTransform {
  scale: number
  focus: Point
  offset: Point
  rotation: number
}

/** Peak shake displacement in px at intensity 1. */
const SHAKE_PX = 30
const RAMP = 0.25

const smooth = (t: number): number => t * t * (3 - 2 * t)

/** Zoom envelope: ease in over the first quarter, hold, ease out over the last quarter. */
function zoomEnvelope(p: number): number {
  if (p < RAMP) return smooth(p / RAMP)
  if (p > 1 - RAMP) return smooth((1 - p) / RAMP)
  return 1
}

/** Combines active camera moves into one transform. `rand` returns 0–1 (injected for tests). */
export function cameraTransform(moves: ActiveMove[], now: number, rand: () => number): CameraTransform {
  let scale = 1
  let focus: Point = { x: 0, y: 0 }
  const offset = { x: 0, y: 0 }
  let rotation = 0
  let shakeScale = 1

  for (const m of moves) {
    const p = (now - m.start) / m.durationMs
    if (p < 0 || p >= 1) continue
    if (m.kind === 'zoom') {
      const s = 1 + (m.amount - 1) * zoomEnvelope(p)
      if (s > scale) {
        scale = s
        focus = m.focus
      }
    } else {
      const amp = m.intensity * SHAKE_PX * (1 - p) ** 2
      offset.x += (rand() * 2 - 1) * amp
      offset.y += (rand() * 2 - 1) * amp
      rotation += (rand() * 2 - 1) * 0.012 * m.intensity * (1 - p) ** 2
      // Scale up slightly so the shaken frame never shows its edges.
      shakeScale = Math.max(shakeScale, 1 + (2.2 * amp) / 720)
      if (scale === 1) focus = m.focus
    }
  }
  return { scale: Math.max(scale, shakeScale), focus, offset, rotation }
}

/** Removes finished entries in place (the render loop must not allocate). */
function dropExpired(list: { start: number; durationMs: number }[], now: number): void {
  let kept = 0
  for (let i = 0; i < list.length; i++) {
    const m = list[i]!
    if (now - m.start < m.durationMs) list[kept++] = m
  }
  list.length = kept
}

/**
 * Applies shake/zoom to the scene container (camera + effect layers move together) and the
 * colour grade (camera saturation/tint + vignette), each animating in and out.
 */
export class CameraMoves {
  private readonly moves: ActiveMove[] = []
  private readonly grades: ActiveGrade[] = []
  private readonly grade: Grade = { ...NEUTRAL_GRADE, tint: [1, 1, 1] }
  private gradeActive = false

  constructor(
    private readonly scene: Container,
    private readonly width: number,
    private readonly height: number,
    private readonly setGrade: (grade: Grade) => void
  ) {}

  play(cfg: CameraMoveConfig, ctx: EffectContext, now: number): void {
    if (cfg.kind === 'grade') {
      const target = { saturation: cfg.saturation, tint: hexToRgb(cfg.tint), tintAmount: cfg.tintAmount, vignette: cfg.vignette }
      this.grades.push({ all: cfg.gradeScope === 'all', start: now, durationMs: cfg.durationMs, fadeMs: cfg.fadeMs, target })
      return
    }
    const center = { x: this.width / 2, y: this.height / 2 }
    const focus = cfg.kind === 'zoom' && cfg.target !== 'center' ? resolveAnchors(cfg.target, ctx, this.width, this.height)[0]! : center
    this.moves.push({ kind: cfg.kind, start: now, durationMs: cfg.durationMs, intensity: cfg.intensity, amount: cfg.amount, focus })
  }

  update(now: number): void {
    if (this.grades.length > 0 || this.gradeActive) {
      dropExpired(this.grades, now)
      this.setGrade(combineGrades(this.grades, now, this.grade))
      // One more neutral update after the last grade ends, then idle.
      this.gradeActive = this.grades.length > 0
    }
    dropExpired(this.moves, now)
    const t = cameraTransform(this.moves, now, Math.random)
    this.scene.pivot.set(t.focus.x, t.focus.y)
    this.scene.position.set(t.focus.x + t.offset.x, t.focus.y + t.offset.y)
    this.scene.scale.set(t.scale)
    this.scene.rotation = t.rotation
  }
}
