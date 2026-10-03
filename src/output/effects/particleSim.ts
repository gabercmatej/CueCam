/** Pure particle physics and presets. Rendering lives in particles.ts. */
import type { ParticlePreset } from '../../shared/config'
import type { AnchorPoint } from './anchors'

export type ParticleTexture = 'rect' | 'heart' | 'dot'

export interface Preset {
  texture: ParticleTexture
  /** Launch speed range, px/s. */
  speed: [number, number]
  /** Total cone width for bursts (radians). */
  burstSpread: number
  /** Total cone width for cannons (radians). */
  cannonSpread: number
  /** Speed multiplier for cannons. */
  cannonBoost: number
  /** px/s², positive = falls. */
  gravity: number
  /** Velocity decay per second (exponential). */
  drag: number
  life: [number, number]
  size: [number, number]
  /** Max spin, rad/s. */
  spin: number
  tints: number[]
  additive: boolean
  /** Paper-like flipping (confetti). */
  flutter: boolean
}

export const PRESETS: Record<ParticlePreset, Preset> = {
  confetti: {
    texture: 'rect',
    speed: [450, 950],
    burstSpread: 2.4,
    cannonSpread: 0.5,
    cannonBoost: 1.7,
    gravity: 1100,
    drag: 1.6,
    life: [2, 3],
    size: [0.8, 1.3],
    spin: 10,
    tints: [0xff3b5c, 0xffc93c, 0x3ec1ff, 0x7cff6b, 0xb46bff, 0xffffff],
    additive: false,
    flutter: true
  },
  hearts: {
    texture: 'heart',
    speed: [180, 520],
    burstSpread: Math.PI * 2,
    cannonSpread: 0.6,
    cannonBoost: 1.4,
    gravity: -120,
    drag: 2.2,
    life: [1.4, 2.2],
    size: [0.6, 1.3],
    spin: 1.5,
    tints: [0xff2d6f, 0xff5c8a, 0xff8fb1, 0xe0003c],
    additive: false,
    flutter: false
  },
  sparks: {
    texture: 'dot',
    speed: [250, 900],
    burstSpread: Math.PI * 2,
    cannonSpread: 0.5,
    cannonBoost: 1.5,
    gravity: 500,
    drag: 2.5,
    life: [0.45, 1],
    size: [0.5, 1.4],
    spin: 0,
    tints: [0xffe066, 0xffa62b, 0xff6b1a, 0xffffff],
    additive: true,
    flutter: false
  }
}

export interface SimParticle {
  x: number
  y: number
  vx: number
  vy: number
  rotation: number
  spin: number
  age: number
  life: number
  size: number
  tint: number
  gravity: number
  drag: number
  flutter: boolean
}

const range = ([a, b]: [number, number], r: number): number => a + (b - a) * r

export function spawnBurst(preset: Preset, at: AnchorPoint, count: number, mode: 'burst' | 'cannon', rand: () => number): SimParticle[] {
  const spread = mode === 'cannon' ? preset.cannonSpread : preset.burstSpread
  const boost = mode === 'cannon' ? preset.cannonBoost : 1
  return Array.from({ length: count }, () => {
    const angle = at.angle + (rand() - 0.5) * spread
    const speed = range(preset.speed, rand()) * boost
    return {
      x: at.x,
      y: at.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      rotation: rand() * Math.PI * 2,
      spin: (rand() - 0.5) * 2 * preset.spin,
      age: 0,
      life: range(preset.life, rand()),
      size: range(preset.size, rand()),
      tint: preset.tints[Math.floor(rand() * preset.tints.length) % preset.tints.length]!,
      gravity: preset.gravity,
      drag: preset.drag,
      flutter: preset.flutter
    }
  })
}

/** Advances one particle by dt seconds. Returns false once it has died. */
export function stepParticle(p: SimParticle, dt: number): boolean {
  p.vy += p.gravity * dt
  const decay = Math.exp(-p.drag * dt)
  p.vx *= decay
  p.vy *= decay
  p.x += p.vx * dt
  p.y += p.vy * dt
  p.rotation += p.spin * dt
  p.age += dt
  return p.age < p.life
}

/** 0–1 opacity: quick fade-in, fade-out over the last 30% of life. */
export function particleAlpha(p: SimParticle): number {
  const t = p.age / p.life
  return Math.min(1, p.age / 0.05, (1 - t) / 0.3)
}
