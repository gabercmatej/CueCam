import type { EffectConfig } from '../../shared/config'
import type { EffectContext } from '../../shared/types'
import type { CameraMoves } from './cameraMove'
import type { ClipEngine } from './clip'
import type { LightPaint } from './lightPaint'
import type { MediaEngine } from './media'
import type { ParticleEngine } from './particles'

/** Effect names from the config → the engine that renders them. */
export class EffectRegistry {
  private effects: Record<string, EffectConfig> = {}

  constructor(
    private readonly engines: { particles: ParticleEngine; clips: ClipEngine; camera: CameraMoves; media: MediaEngine; lightPaint: LightPaint }
  ) {}

  setEffects(effects: Record<string, EffectConfig>): void {
    this.effects = effects
    const files = Object.values(effects).flatMap((e) => (e.type === 'clip' ? [e.file] : []))
    this.engines.clips.preload(files)
    void this.engines.media.setEffects(effects)
  }

  /** Disarmed: playing effects fade out quickly. Particles, shakes and grades are short and finish on their own. */
  windDown(now: number): void {
    this.engines.media.windDown(now)
    this.engines.clips.windDown()
    this.engines.lightPaint.windDown(now)
  }

  /** Files changed on disk: drop them and reload what the current effects use. */
  filesChanged(root: 'reactions' | 'clips', paths: readonly string[]): void {
    if (root === 'reactions') this.engines.media.invalidate(paths)
    else this.engines.clips.invalidate(paths)
    this.setEffects(this.effects)
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
      case 'media':
        return this.engines.media.play(name, effect, ctx, now)
      case 'sound':
        return this.engines.media.playSound(name, effect)
      case 'lightPaint':
        return this.engines.lightPaint.play(effect, ctx)
      case 'cameraMove':
        return this.engines.camera.play(effect, ctx, now)
    }
  }
}
