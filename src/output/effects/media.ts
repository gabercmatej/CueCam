/**
 * Media effects from reactions/: images, GIFs and video (alpha WebM or green-screen MP4, keyed
 * automatically), placed in a corner (pop in, hold, fade; stacked), at an anchor (optionally
 * following a hand and sized by it), or over the whole frame. Plus sound effects.
 *
 * Every file is loaded ahead of time when the config is applied, so a trigger never waits on
 * the disk. A missing file never breaks a trigger: corner cards show a placeholder, anchored
 * and full-frame media fall back to a spark burst.
 */
import { type Container, type Filter, Graphics, ImageSource, Rectangle, type Renderer, Sprite, Text, Texture, type Ticker, VideoSource } from 'pixi.js'
import { GifSource, GifSprite } from 'pixi.js/gif'
import type { EffectConfig } from '../../shared/config'
import { mediaKind, mediaUrl } from '../../shared/media'
import type { EffectContext, HandSide, Point } from '../../shared/types'
import type { AudioEngine } from '../audio/audioEngine'
import { createChromaKey, type ChromaKeySettings } from '../render/chromaKey'
import { clipAlignment, resolveAnchors } from './anchors'
import { chooseCorner, type CornerCard, type CornerName, cornersByDistance, layoutCards } from './corners'
import { autoSimilarity, detectGreenScreen, type GreenSample } from './greenScreen'
import { pickVariant } from './variants'

export type MediaConfig = Extract<EffectConfig, { type: 'media' }>
export type SoundConfig = Extract<EffectConfig, { type: 'sound' }>

/** A hand as effects see it this frame: palm centre and size (wrist → middle knuckle) in stage px. */
export interface HandPoint {
  side: HandSide
  palm: Point
  size: number
}

/** Tunables. */
export const MEDIA_TUNING = {
  /** Corner card: longest side ÷ frame height. */
  cornerSize: 0.3,
  /** Images and GIFs stay this long by default. */
  imageHoldMs: 2500,
  cornerMargin: 24,
  cornerGap: 14,
  /** Pop-in: scale 0 → overshoot → 1 over this long. */
  popMs: 260,
  /** How fast restacked cards slide to their new place (1/s). */
  slideRate: 14,
  /** Anchored media fade in over this long. */
  fadeInMs: 120,
  /** A trigger that arrives while its file is still loading plays when ready, unless it is older than this. */
  maxLoadWaitMs: 1500
}

interface AssetBase {
  path: string
  state: 'loading' | 'ready' | 'missing'
  width: number
  height: number
  /** A play that arrived while loading (the latest wins). */
  pending?: () => void
}
interface ImageAsset extends AssetBase {
  kind: 'image'
  texture: Texture
}
interface GifAsset extends AssetBase {
  kind: 'gif'
  source: GifSource | null
}
interface VideoAsset extends AssetBase {
  kind: 'video'
  video: HTMLVideoElement
  texture: Texture
  /** Detected green-screen colour, null if not a green screen. */
  green: string | null
  /** The Shown currently using this video (one playback per file). */
  owner: Shown | null
  /** Bumped per play so a stale play() rejection can't stop a newer playback. */
  token: number
}
type Asset = ImageAsset | GifAsset | VideoAsset

interface Shown {
  cfg: MediaConfig
  asset: Asset
  display: Sprite
  /** A cropped texture made for this showing (destroyed with it; the source is shared). */
  ownTexture: Texture | null
  start: number
  /** Fade-out starts here; removed at endAt + fadeMs. */
  endAt: number
  /** Corner cards: their corner and size; null for anchored / full-frame media. */
  card: CornerCard | null
  /** Scale at full size (before the pop). */
  baseScale: number
  placed: boolean
  /** Following hand, if any. */
  follow: HandSide | null
}

const easeOutBack = (t: number): number => {
  const c = 1.9
  const u = t - 1
  return 1 + (c + 1) * u * u * u + c * u * u
}

export class MediaEngine {
  private readonly assets = new Map<string, Asset>()
  /** Effect name → its resolved files (by kind). */
  private files = new Map<string, string[]>()
  private readonly lastPick = new Map<string, string>()
  private shown: Shown[] = []
  /** Corner cards in arrival order (retiring ones excluded), and their target centres. */
  private cards: Shown[] = []
  private readonly cardInfo: CornerCard[] = []
  private readonly targets: Point[] = []
  private readonly keyFilters = new Map<string, Filter>()
  private readonly placeholders = new Map<string, Texture>()
  private hands: readonly HandPoint[] = []
  private readonly sampler = document.createElement('canvas')
  private generation = 0

  constructor(
    private readonly layers: { back: Container; front: Container },
    private readonly renderer: Renderer,
    private readonly width: number,
    private readonly height: number,
    private readonly mirror: boolean,
    private readonly audio: AudioEngine,
    /** Anchored / full-frame media whose files are all missing: something still happens (sparks). */
    private readonly onMissing: (cfg: MediaConfig, ctx: EffectContext) => void
  ) {
    this.sampler.width = 48
    this.sampler.height = 27
  }

  get count(): number {
    return this.shown.length
  }

  /** Resolves every media/sound effect's files (folders → files) and preloads them. */
  async setEffects(effects: Record<string, EffectConfig>): Promise<void> {
    const generation = ++this.generation
    const entries = new Set<string>()
    for (const e of Object.values(effects)) if (e.type === 'media' || e.type === 'sound') e.files.forEach((f) => entries.add(f))
    let resolved: Record<string, string[]> = {}
    try {
      resolved = await window.skillcam.resolveMedia([...entries])
    } catch (err) {
      console.error('[media] could not resolve reactions/ files', err)
    }
    if (generation !== this.generation) return
    const files = new Map<string, string[]>()
    for (const [name, e] of Object.entries(effects)) {
      if (e.type !== 'media' && e.type !== 'sound') continue
      const want = (p: string): boolean => (e.type === 'sound' ? mediaKind(p) === 'audio' : mediaKind(p) !== 'audio' && mediaKind(p) !== null)
      const list = [...new Set(e.files.flatMap((f) => resolved[f] ?? []))].filter(want)
      const missing = e.files.filter((f) => (resolved[f] ?? []).filter(want).length === 0)
      if (missing.length) console.warn(`[media] ${name}: nothing usable at reactions/${missing.join(', reactions/')}${list.length ? '' : ' (placeholder)'}`)
      files.set(name, list)
      for (const path of list) {
        if (e.type === 'sound') void this.audio.load(path)
        else this.load(path)
      }
    }
    this.files = files
  }

  /** The resolved files per effect, for the startup report. */
  get resolved(): ReadonlyMap<string, readonly string[]> {
    return this.files
  }

  playSound(name: string, cfg: SoundConfig): void {
    const path = this.pick(name)
    if (!path) return
    void this.audio.play(path, cfg.muted ? 0 : cfg.volume)
  }

  play(name: string, cfg: MediaConfig, ctx: EffectContext, now: number): void {
    const path = this.pick(name)
    const asset = path ? this.assets.get(path) : undefined
    if (!asset || asset.state === 'missing') {
      if (cfg.placement === 'corner') this.show(cfg, this.placeholder(name), ctx, now)
      else this.onMissing(cfg, ctx)
      return
    }
    if (asset.state === 'loading') {
      // Size isn't known until it loads; play then, unless that is too late to still read as the reaction.
      asset.pending = () => {
        const t = performance.now()
        if (t - now <= MEDIA_TUNING.maxLoadWaitMs) this.play(name, cfg, ctx, t)
      }
      return
    }
    this.show(cfg, asset, ctx, now)
  }

  /** Per frame: animation, corner restacking, hand following, expiry. `hands` is reused by the caller. */
  update(now: number, ticker: Ticker, hands: readonly HandPoint[]): void {
    this.hands = hands
    if (this.shown.length === 0) return
    const slide = 1 - Math.exp((-MEDIA_TUNING.slideRate * Math.min(ticker.deltaMS, 100)) / 1000)
    let expired = false
    for (let i = 0; i < this.shown.length; i++) {
      const s = this.shown[i]!
      const t = now - s.start
      const d = s.display
      if (now >= s.endAt + s.cfg.fadeMs) {
        expired = true
        continue
      }
      const fadeOut = now > s.endAt ? 1 - (now - s.endAt) / Math.max(1, s.cfg.fadeMs) : 1
      if (d instanceof GifSprite) d.update(ticker)
      if (s.card) {
        const k = this.cards.indexOf(s)
        const target = k >= 0 ? this.targets[k] : undefined
        if (target) {
          if (!s.placed) {
            d.position.set(target.x, target.y)
            s.placed = true
          } else {
            d.x += (target.x - d.x) * slide
            d.y += (target.y - d.y) * slide
          }
        }
        const pop = Math.min(1, t / MEDIA_TUNING.popMs)
        d.scale.set(s.baseScale * Math.max(0, easeOutBack(pop)))
        d.alpha = fadeOut
      } else {
        if (s.follow) this.followHand(s)
        d.alpha = Math.min(1, t / MEDIA_TUNING.fadeInMs) * fadeOut
      }
    }
    if (expired) this.dropExpired(now)
  }

  private pick(name: string): string | undefined {
    const files = this.files.get(name) ?? []
    const path = pickVariant(files, this.lastPick.get(name), Math.random)
    if (path) this.lastPick.set(name, path)
    return path
  }

  private show(cfg: MediaConfig, asset: Asset, ctx: EffectContext, now: number): void {
    let ownTexture: Texture | null = null
    let display: Sprite
    if (asset.kind === 'gif') {
      display = new GifSprite({ source: asset.source!, autoPlay: true, loop: true, autoUpdate: false })
    } else {
      let texture = asset.texture
      if (cfg.crop) {
        const [x, y, w, h] = cfg.crop
        texture = ownTexture = new Texture({
          source: texture.source,
          frame: new Rectangle(x * asset.width, y * asset.height, Math.min(w, 1 - x) * asset.width, Math.min(h, 1 - y) * asset.height)
        })
      }
      display = new Sprite(texture)
    }
    const tw = display.texture.width || 1
    const th = display.texture.height || 1

    const shown: Shown = { cfg, asset, display, ownTexture, start: now, endAt: now, card: null, baseScale: 1, placed: false, follow: null }

    if (asset.kind === 'video') {
      // One playback per file: a re-trigger restarts it.
      if (asset.owner) this.remove(asset.owner)
      asset.owner = shown
      const key = this.keyFor(cfg, asset.green)
      if (key) display.filters = [this.keyFilter(key)]
    }
    // Video: its own length by default (the fade ends with the clip); images and GIFs: 2.5 s.
    const lengthMs = asset.kind === 'video' ? asset.video.duration * 1000 : 0
    const holdMs = cfg.holdMs ?? (Number.isFinite(lengthMs) && lengthMs > 0 ? Math.max(500, lengthMs - cfg.fadeMs) : MEDIA_TUNING.imageHoldMs)
    shown.endAt = now + holdMs

    display.anchor.set(0.5)
    if (cfg.placement === 'corner') {
      const size = (cfg.size ?? MEDIA_TUNING.cornerSize) * this.height
      shown.baseScale = size / Math.max(tw, th)
      shown.card = { corner: 'top-right', width: tw * shown.baseScale, height: th * shown.baseScale }
      shown.card.corner = this.placeCard(cfg, shown.card, ctx, now)
      display.scale.set(0)
      this.cards.push(shown)
      this.relayout()
      this.layers[cfg.layer].addChild(display)
    } else if (cfg.placement === 'fullscreen') {
      display.scale.set(Math.max(this.width / tw, this.height / th))
      display.position.set(this.width / 2, this.height / 2)
      display.alpha = 0
      this.layers[cfg.layer].addChild(display)
    } else {
      const [at] = resolveAnchors(cfg.anchor, ctx, this.width, this.height, this.mirror)
      const origin = cfg.origin ? { x: cfg.origin[0], y: cfg.origin[1] } : clipAlignment(cfg.anchor, this.mirror)
      display.anchor.set(origin.x, origin.y)
      display.position.set(at!.x, at!.y)
      const hand = this.handFor(ctx)
      if (cfg.follow && hand) shown.follow = hand.side
      const height = cfg.handScale && hand ? cfg.handScale * hand.size : (cfg.size ?? 1) * this.height
      shown.baseScale = height / th
      display.scale.set(shown.baseScale)
      display.alpha = 0
      this.layers[cfg.layer].addChild(display)
    }
    this.shown.push(shown)

    if (asset.kind === 'video') this.startVideo(asset, cfg, holdMs + cfg.fadeMs)
  }

  private startVideo(asset: VideoAsset, cfg: MediaConfig, showMs: number): void {
    const video = asset.video
    const volume = cfg.muted ? 0 : cfg.volume
    // A video with no sound wanted never touches the audio graph (and stays muted).
    if (volume > 0 || !video.muted) this.audio.setVideoVolume(video, volume)
    video.loop = showMs > video.duration * 1000 + 50
    video.currentTime = 0
    const token = ++asset.token
    video.play().catch((err: unknown) => {
      if (token !== asset.token) return
      console.warn(`[media] reactions/${asset.path} failed to play`, err)
    })
  }

  /** Picks the corner (farthest from the face unless the effect names one), retiring old cards to make room. */
  private placeCard(cfg: MediaConfig, card: CornerCard, ctx: EffectContext, now: number): CornerName {
    const order = cfg.corner === 'auto' ? cornersByDistance(ctx.face, this.width, this.height) : [cfg.corner]
    const layout = this.layout()
    for (;;) {
      const corner = chooseCorner(order, this.cardInfoList(), card, layout)
      if (corner) return corner
      // No room: retire the oldest card in the wanted corner's column (or anywhere), then try again.
      const left = order[0]!.endsWith('left')
      const victim = this.cards.find((c) => c.card!.corner.endsWith('left') === left) ?? this.cards[0]
      if (!victim) return order[0]!
      this.retire(victim, now)
    }
  }

  private layout(): { width: number; height: number; margin: number; gap: number } {
    return { width: this.width, height: this.height, margin: MEDIA_TUNING.cornerMargin, gap: MEDIA_TUNING.cornerGap }
  }

  private cardInfoList(): CornerCard[] {
    this.cardInfo.length = 0
    for (const c of this.cards) this.cardInfo.push(c.card!)
    return this.cardInfo
  }

  private relayout(): void {
    layoutCards(this.cardInfoList(), this.layout(), this.targets)
  }

  /** Starts a card's fade-out now and takes it out of the stack (the others close the gap). */
  private retire(s: Shown, now: number): void {
    s.endAt = Math.min(s.endAt, now)
    const i = this.cards.indexOf(s)
    if (i >= 0) {
      this.cards.splice(i, 1)
      this.relayout()
    }
  }

  private dropExpired(now: number): void {
    let kept = 0
    let restack = false
    for (let i = 0; i < this.shown.length; i++) {
      const s = this.shown[i]!
      if (now < s.endAt + s.cfg.fadeMs) {
        this.shown[kept++] = s
        continue
      }
      restack ||= this.destroy(s)
    }
    this.shown.length = kept
    if (restack) this.relayout()
  }

  private remove(s: Shown): void {
    const i = this.shown.indexOf(s)
    if (i >= 0) this.shown.splice(i, 1)
    if (this.destroy(s)) this.relayout()
  }

  /** Frees a showing. True if it was in the corner stack. */
  private destroy(s: Shown): boolean {
    s.display.destroy()
    s.ownTexture?.destroy(false)
    if (s.asset.kind === 'video' && s.asset.owner === s) {
      s.asset.owner = null
      s.asset.video.pause()
    }
    const i = this.cards.indexOf(s)
    if (i >= 0) this.cards.splice(i, 1)
    return i >= 0
  }

  private handFor(ctx: EffectContext): HandPoint | undefined {
    if (this.hands.length === 0) return undefined
    const side = ctx.hand === 'Left' || ctx.hand === 'Right' ? ctx.hand : undefined
    if (side) return this.hands.find((h) => h.side === side)
    // No side: the hand nearest the trigger.
    const p = ctx.position
    if (!p) return this.hands[0]
    let best = this.hands[0]!
    for (const h of this.hands) if (Math.hypot(h.palm.x - p.x, h.palm.y - p.y) < Math.hypot(best.palm.x - p.x, best.palm.y - p.y)) best = h
    return best
  }

  private followHand(s: Shown): void {
    for (const h of this.hands) {
      if (h.side !== s.follow) continue
      s.display.position.set(h.palm.x, h.palm.y)
      if (s.cfg.handScale) {
        s.baseScale = (s.cfg.handScale * h.size) / (s.display.texture.height || 1)
        s.display.scale.set(s.baseScale)
      }
      return
    }
    // Hand not seen this frame: stay where it was.
  }

  private keyFor(cfg: MediaConfig, detected: string | null): ChromaKeySettings | null {
    if (cfg.key === false) return null
    const keyColor = cfg.keyColor ?? detected ?? (cfg.key ? '#00ff00' : null)
    if (!keyColor) return null
    return { keyColor, similarity: cfg.similarity ?? autoSimilarity(keyColor), smoothness: cfg.smoothness, spill: cfg.spill }
  }

  private keyFilter(key: ChromaKeySettings): Filter {
    const id = `${key.keyColor}|${key.similarity}|${key.smoothness}|${key.spill}`
    let filter = this.keyFilters.get(id)
    if (!filter) {
      filter = createChromaKey(key)
      this.keyFilters.set(id, filter)
    }
    return filter
  }

  /** A dark card with the effect's name: what a corner reaction shows when its files are missing. */
  private placeholder(name: string): ImageAsset {
    let texture = this.placeholders.get(name)
    if (!texture) {
      const card = new Graphics().roundRect(0, 0, 320, 200, 18).fill({ color: 0x1b1d22, alpha: 0.9 }).stroke({ color: 0xffffff, alpha: 0.5, width: 3 })
      const label = new Text({ text: `${name}\n(missing file)`, style: { fill: 0xffffff, fontSize: 26, fontFamily: 'Helvetica', align: 'center' } })
      label.anchor.set(0.5)
      label.position.set(160, 100)
      card.addChild(label)
      texture = this.renderer.generateTexture({ target: card, resolution: 2 })
      card.destroy({ children: true })
      this.placeholders.set(name, texture)
    }
    return { kind: 'image', path: `(placeholder ${name})`, state: 'ready', texture, width: texture.width, height: texture.height }
  }

  private load(path: string): void {
    // A file that failed before is retried on each config apply (it may have been fixed or added since).
    if (this.assets.get(path)?.state === 'missing') this.assets.delete(path)
    if (this.assets.has(path)) return
    const kind = mediaKind(path)
    const url = mediaUrl(path)
    const ready = (asset: Asset): void => {
      asset.state = 'ready'
      asset.pending?.()
      asset.pending = undefined
    }
    const missing = (asset: Asset, err: unknown): void => {
      asset.state = 'missing'
      console.warn(`[media] cannot load reactions/${path}`, err)
      // A trigger that waited for it still shows something (placeholder card or sparks).
      asset.pending?.()
      asset.pending = undefined
    }

    if (kind === 'image') {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      const asset: ImageAsset = { kind: 'image', path, state: 'loading', width: 0, height: 0, texture: Texture.EMPTY }
      this.assets.set(path, asset)
      img.src = url
      img
        .decode()
        .then(() => {
          asset.texture = new Texture({ source: new ImageSource({ resource: img, autoGenerateMipmaps: true, scaleMode: 'linear' }) })
          asset.width = img.naturalWidth
          asset.height = img.naturalHeight
          ready(asset)
        })
        .catch((err: unknown) => missing(asset, err))
    } else if (kind === 'gif') {
      const asset: GifAsset = { kind: 'gif', path, state: 'loading', width: 0, height: 0, source: null }
      this.assets.set(path, asset)
      fetch(url)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((buffer) => {
          asset.source = GifSource.from(buffer)
          asset.width = asset.source.width
          asset.height = asset.source.height
          ready(asset)
        })
        .catch((err: unknown) => missing(asset, err))
    } else if (kind === 'video') {
      const video = document.createElement('video')
      video.muted = true
      video.playsInline = true
      video.preload = 'auto'
      // skillcam:// is another origin: without CORS the video taints WebGL and its audio can't be routed.
      video.crossOrigin = 'anonymous'
      const asset: VideoAsset = {
        kind: 'video',
        path,
        state: 'loading',
        width: 0,
        height: 0,
        video,
        // Mipmaps: corner cards show 1080p clips at a fraction of their size.
        texture: new Texture({ source: new VideoSource({ resource: video, autoPlay: false, updateFPS: 0, autoGenerateMipmaps: true }) }),
        green: null,
        owner: null,
        token: 0
      }
      this.assets.set(path, asset)
      video.addEventListener('error', () => missing(asset, video.error?.message ?? 'not found'), { once: true })
      video.addEventListener(
        'loadeddata',
        () => {
          asset.width = video.videoWidth
          asset.height = video.videoHeight
          void this.detectGreen(video)
            .then((green) => {
              asset.green = green
              if (green) console.log(`[media] reactions/${path}: green screen ${green}, keyed`)
            })
            .catch((err: unknown) => console.warn(`[media] green-screen check failed for reactions/${path}`, err))
            .finally(() => ready(asset))
        },
        { once: true }
      )
      video.src = url
    } else {
      this.assets.set(path, { kind: 'image', path, state: 'missing', width: 0, height: 0, texture: Texture.EMPTY })
    }
  }

  /** Samples a few frames (start, a third in, two thirds in) for a green border. Seeks the idle video. */
  private async detectGreen(video: HTMLVideoElement): Promise<string | null> {
    const g = this.sampler.getContext('2d', { willReadFrequently: true })!
    const samples: GreenSample[] = []
    const d = Number.isFinite(video.duration) ? video.duration : 0
    for (const t of [0, d / 3, (2 * d) / 3]) {
      if (t > 0) {
        // A seek that never completes (decode error) must not leave the clip loading forever.
        const seeked = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 1500)
          video.addEventListener(
            'seeked',
            () => {
              clearTimeout(timer)
              resolve(true)
            },
            { once: true }
          )
          video.currentTime = t
        })
        if (!seeked) break
      }
      g.clearRect(0, 0, this.sampler.width, this.sampler.height)
      g.drawImage(video, 0, 0, this.sampler.width, this.sampler.height)
      const img = g.getImageData(0, 0, this.sampler.width, this.sampler.height)
      samples.push({ data: img.data, width: img.width, height: img.height })
    }
    video.currentTime = 0
    return detectGreenScreen(samples)
  }
}
