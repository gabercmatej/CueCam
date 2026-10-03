import { type Container, Sprite, Texture, VideoSource } from 'pixi.js'
import type { EffectConfig } from '../../shared/config'
import type { EffectContext } from '../../shared/types'
import { clipAlignment, resolveAnchors } from './anchors'

type ClipConfig = Extract<EffectConfig, { type: 'clip' }>

/** Max clips playing at once (BUILD_PLAN §8). */
const MAX_PLAYING = 2

interface LoadedClip {
  video: HTMLVideoElement
  texture: Texture
  state: 'loading' | 'ready' | 'missing'
}

/**
 * Plays clips from effects/clips/ (served as skillcam://clips/<file>). Alpha WebM plays
 * natively; green-screen MP4 keying arrives with the chroma-key filter in Phase 3.
 */
export class ClipEngine {
  private readonly clips = new Map<string, LoadedClip>()
  private playing: { clip: LoadedClip; sprite: Sprite }[] = []

  constructor(
    private readonly layers: { back: Container; front: Container },
    private readonly width: number,
    private readonly height: number,
    /** Called instead of playing when a clip file is missing or unplayable. */
    private readonly onMissing: (cfg: ClipConfig, ctx: EffectContext) => void
  ) {}

  /** Preloads every clip the config references (BUILD_PLAN §8: preload on startup). */
  preload(files: string[]): void {
    for (const file of files) {
      if (this.clips.has(file)) continue
      const video = document.createElement('video')
      video.muted = true
      video.playsInline = true
      video.preload = 'auto'
      // skillcam:// is another origin; without CORS the video taints WebGL and every render throws.
      video.crossOrigin = 'anonymous'
      const clip: LoadedClip = {
        video,
        texture: new Texture({ source: new VideoSource({ resource: video, autoPlay: false, updateFPS: 0 }) }),
        state: 'loading'
      }
      video.addEventListener('canplaythrough', () => (clip.state = 'ready'), { once: true })
      video.addEventListener('error', () => {
        clip.state = 'missing'
        console.warn(`[clip] cannot load effects/clips/${file} (${video.error?.message ?? 'not found'})`)
      })
      video.src = `skillcam://clips/${encodeURIComponent(file)}`
      this.clips.set(file, clip)
    }
  }

  play(cfg: ClipConfig, ctx: EffectContext): void {
    const clip = this.clips.get(cfg.file)
    if (!clip || clip.state === 'missing') {
      this.onMissing(cfg, ctx)
      return
    }
    this.stop(clip)
    while (this.playing.length >= MAX_PLAYING) this.stop(this.playing[0]!.clip)

    const sprite = new Sprite(clip.texture)
    const [at] = resolveAnchors(cfg.anchor, ctx, this.width, this.height)
    const align = clipAlignment(cfg.anchor)
    const aspect = clip.video.videoWidth && clip.video.videoHeight ? clip.video.videoWidth / clip.video.videoHeight : 1
    sprite.height = cfg.scale * this.height
    sprite.width = sprite.height * aspect
    sprite.anchor.set(align.x, align.y)
    sprite.position.set(at!.x, at!.y)
    this.layers[cfg.layer].addChild(sprite)
    this.playing.push({ clip, sprite })

    clip.video.currentTime = 0
    clip.video.onended = () => this.stop(clip)
    clip.video.play().catch((err: unknown) => {
      console.warn(`[clip] ${cfg.file} failed to play`, err)
      this.stop(clip)
    })
  }

  private stop(clip: LoadedClip): void {
    const i = this.playing.findIndex((p) => p.clip === clip)
    if (i < 0) return
    this.playing.splice(i, 1)[0]!.sprite.destroy()
    clip.video.pause()
  }
}
