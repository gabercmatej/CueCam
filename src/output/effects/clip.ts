import { type Container, type Filter, Sprite, Texture, VideoSource } from 'pixi.js'
import type { EffectConfig } from '../../shared/config'
import type { EffectContext } from '../../shared/types'
import { createChromaKey } from '../render/chromaKey'
import { clipAlignment, resolveAnchors } from './anchors'
import { keySettings } from './clipKey'

type ClipConfig = Extract<EffectConfig, { type: 'clip' }>

/** Max clips playing at once (BUILD_PLAN §8). */
const MAX_PLAYING = 2

interface LoadedClip {
  video: HTMLVideoElement
  texture: Texture
  state: 'loading' | 'ready' | 'missing'
  /** A trigger that arrived while loading; played once the clip is ready. */
  pending?: () => void
  /** Bumped on every play, so a stale play() rejection can't stop a newer playback. */
  token: number
}

/**
 * Plays clips from effects/clips/ (served as skillcam://clips/<file>). Alpha WebM plays
 * natively; green-screen MP4s are keyed on the GPU when the effect asks for it (`key`/`keyColor`).
 */
export class ClipEngine {
  private readonly clips = new Map<string, LoadedClip>()
  private playing: { clip: LoadedClip; sprite: Sprite }[] = []
  /** One chroma-key filter per distinct key setting. */
  private readonly keyFilters = new Map<string, Filter>()

  constructor(
    private readonly layers: { back: Container; front: Container },
    private readonly width: number,
    private readonly height: number,
    private readonly mirror: boolean,
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
        state: 'loading',
        token: 0
      }
      video.addEventListener(
        'canplaythrough',
        () => {
          clip.state = 'ready'
          clip.pending?.()
          clip.pending = undefined
        },
        { once: true }
      )
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
    if (clip.state === 'loading') {
      // Size isn't known until metadata loads (the texture is 1×1), so play when ready.
      clip.pending = () => this.play(cfg, ctx)
      return
    }
    this.stop(clip)
    while (this.playing.length >= MAX_PLAYING) this.stop(this.playing[0]!.clip)

    const sprite = new Sprite(clip.texture)
    const [at] = resolveAnchors(cfg.anchor, ctx, this.width, this.height, this.mirror)
    const align = clipAlignment(cfg.anchor, this.mirror)
    const aspect = clip.video.videoWidth && clip.video.videoHeight ? clip.video.videoWidth / clip.video.videoHeight : 1
    sprite.height = cfg.scale * this.height
    sprite.width = sprite.height * aspect
    sprite.anchor.set(align.x, align.y)
    sprite.position.set(at!.x, at!.y)
    const key = keySettings(cfg)
    if (key) sprite.filters = [this.keyFilter(key)]
    this.layers[cfg.layer].addChild(sprite)
    this.playing.push({ clip, sprite })

    const token = ++clip.token
    clip.video.currentTime = 0
    clip.video.onended = () => this.stop(clip)
    clip.video.play().catch((err: unknown) => {
      // A re-trigger interrupts the previous play() with an AbortError; that one must not stop the new playback.
      if (token !== clip.token) return
      console.warn(`[clip] ${cfg.file} failed to play`, err)
      this.stop(clip)
    })
  }

  private keyFilter(key: NonNullable<ReturnType<typeof keySettings>>): Filter {
    const id = `${key.keyColor}|${key.similarity}|${key.smoothness}|${key.spill}`
    let filter = this.keyFilters.get(id)
    if (!filter) {
      filter = createChromaKey(key)
      this.keyFilters.set(id, filter)
    }
    return filter
  }

  private stop(clip: LoadedClip): void {
    const i = this.playing.findIndex((p) => p.clip === clip)
    if (i < 0) return
    this.playing.splice(i, 1)[0]!.sprite.destroy()
    clip.video.pause()
  }
}
