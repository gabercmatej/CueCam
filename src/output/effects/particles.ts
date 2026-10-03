import { Container, Graphics, Particle, ParticleContainer, type Renderer, type Texture } from 'pixi.js'
import type { EffectConfig } from '../../shared/config'
import type { EffectContext } from '../../shared/types'
import { resolveAnchors } from './anchors'
import { particleAlpha, PRESETS, type ParticleTexture, type SimParticle, spawnBurst, stepParticle } from './particleSim'

type ParticlesConfig = Extract<EffectConfig, { type: 'particles' }>

/** Live particle cap across all presets (BUILD_PLAN §8). */
export const MAX_PARTICLES = 1500

interface Pool {
  container: ParticleContainer
  live: { sim: SimParticle; sprite: Particle }[]
  free: Particle[]
  texture: Texture
}

function makeTextures(renderer: Renderer): Record<ParticleTexture, Texture> {
  const rect = new Graphics().rect(0, 0, 14, 8).fill(0xffffff)
  // Heart from two bezier lobes, drawn in a 32×30 box.
  const heart = new Graphics()
    .moveTo(16, 29)
    .bezierCurveTo(4, 20, 0, 12, 0, 8)
    .bezierCurveTo(0, 3, 4, 0, 8.5, 0)
    .bezierCurveTo(12, 0, 15, 2.5, 16, 5.5)
    .bezierCurveTo(17, 2.5, 20, 0, 23.5, 0)
    .bezierCurveTo(28, 0, 32, 3, 32, 8)
    .bezierCurveTo(32, 12, 28, 20, 16, 29)
    .fill(0xffffff)
  const dot = new Graphics().circle(8, 8, 8).fill({ color: 0xffffff, alpha: 0.35 }).circle(8, 8, 4).fill(0xffffff)
  return {
    rect: renderer.generateTexture(rect),
    heart: renderer.generateTexture(heart),
    dot: renderer.generateTexture(dot)
  }
}

/** Pooled particle bursts. One ParticleContainer per texture (they can't mix textures). */
export class ParticleEngine {
  private readonly pools = new Map<ParticleTexture, Pool>()
  private liveCount = 0

  constructor(
    layer: Container,
    renderer: Renderer,
    private readonly width: number,
    private readonly height: number
  ) {
    const textures = makeTextures(renderer)
    for (const kind of ['rect', 'heart', 'dot'] as const) {
      const container = new ParticleContainer({
        texture: textures[kind],
        dynamicProperties: { position: true, rotation: true, vertex: true, color: true, uvs: false }
      })
      if (kind === 'dot') container.blendMode = 'add'
      layer.addChild(container)
      this.pools.set(kind, { container, live: [], free: [], texture: textures[kind] })
    }
  }

  get count(): number {
    return this.liveCount
  }

  play(cfg: ParticlesConfig, ctx: EffectContext): void {
    const preset = PRESETS[cfg.preset]
    const pool = this.pools.get(preset.texture)!
    const anchors = resolveAnchors(cfg.anchor, ctx, this.width, this.height)
    const mode = cfg.anchor === 'bottom-corners' ? 'cannon' : 'burst'
    const budget = Math.min(cfg.count, MAX_PARTICLES - this.liveCount)
    if (budget <= 0) return
    const perAnchor = Math.max(1, Math.floor(budget / anchors.length))

    for (const anchor of anchors) {
      for (const sim of spawnBurst(preset, anchor, perAnchor, mode, Math.random)) {
        const sprite = pool.free.pop() ?? new Particle({ texture: pool.texture, anchorX: 0.5, anchorY: 0.5 })
        sprite.tint = sim.tint
        pool.live.push({ sim, sprite })
        pool.container.addParticle(sprite)
        this.liveCount++
      }
    }
  }

  update(dt: number): void {
    for (const pool of this.pools.values()) {
      if (pool.live.length === 0) continue
      const alive: Pool['live'] = []
      for (const entry of pool.live) {
        const { sim, sprite } = entry
        if (!stepParticle(sim, dt)) {
          pool.free.push(sprite)
          this.liveCount--
          continue
        }
        const pop = Math.min(1, sim.age / 0.12)
        const s = sim.size * (0.4 + 0.6 * pop)
        sprite.x = sim.x
        sprite.y = sim.y
        sprite.rotation = sim.rotation
        sprite.scaleX = s
        sprite.scaleY = sim.flutter ? s * (0.25 + 0.75 * Math.abs(Math.sin(sim.age * 9 + sim.rotation))) : s
        sprite.alpha = particleAlpha(sim)
        alive.push(entry)
      }
      if (alive.length !== pool.live.length) {
        pool.live = alive
        pool.container.particleChildren = alive.map((e) => e.sprite)
        pool.container.update()
      }
    }
  }
}
