import type { EffectConfig } from '../../shared/config'
import type { EffectContext } from '../../shared/types'
import type { CameraMoves } from './cameraMove'
import type { ClipEngine } from './clip'
import type { ParticleEngine } from './particles'

/** Effect names from the config → the engine that renders them. */
export class EffectRegistry {
  private effects: Record<string, EffectConfig> = {}

  constructor(
    private readonly engines: { particles: ParticleEngine; clips: ClipEngine; camera: CameraMoves }
  ) {}

  setEffects(effects: Record<string, EffectConfig>): void {
    this.effects = effects
    const files = Object.values(effects).flatMap((e) => (e.type === 'clip' ? [e.file] : []))
    this.engines.clips.preload(files)
  }

  has(name: string): boolean {
    return name in this.effects
  }

  play(name: string, ctx: EffectContext, now: number): void {
    const effect = this.effects[name]
    if (!effect) {
      console.warn(`[effects] unknown effect "${name}"`)
      return
    }
    switch (effect.type) {
      case 'particles':
        return this.engines.particles.play(effect, ctx)
      case 'clip':
        return this.engines.clips.play(effect, ctx)
      case 'cameraMove':
        return this.engines.camera.play(effect, ctx, now)
    }
  }
}
