import { ControlPanel } from '../control/panel'
import type { Config, ConfigResult } from '../shared/config'
import type { EffectContext, Point, TriggerEvent } from '../shared/types'
import { openCamera } from './camera'
import { FpsMeter, RollingAverage } from './debug/fpsMeter'
import { CameraMoves } from './effects/cameraMove'
import { ClipEngine } from './effects/clip'
import { ParticleEngine } from './effects/particles'
import { EffectRegistry } from './effects/registry'
import { type Firing, TriggerEngine } from './engine/triggers'
import { QualityController, QUALITY_LEVELS } from './perf/quality'
import { onEachVideoFrame } from './perception/frameLoop'
import { FrameScheduler } from './perception/frameScheduler'
import { assignSides, GestureTracker, type RawHand } from './perception/gestures'
import type { Landmark } from './perception/handGeometry'
import { HandTracker, type TrackerMessage } from './perception/hands'
import { HandSmoother, type TrackedHand } from './perception/handSmoother'
import { SpeechInput } from './perception/speech'
import { createStage } from './render/stage'
import { correctHandedness, OUTPUT_VIEW, toScreen } from './view'

// Surface CSP violations with their source so they are fixable, not just noisy.
document.addEventListener('securitypolicyviolation', (e) => {
  console.warn(`[csp] ${e.effectiveDirective} blocked ${e.blockedURI || 'inline'} at ${e.sourceFile}:${e.lineNumber}:${e.columnNumber}`)
})

const view = OUTPUT_VIEW
/** Stats text in the Control window refreshes at this interval; the preview at most every 2nd frame. */
const STATS_MS = 250
/** Preview every Nth rendered frame: ~30 fps normally, fewer at the low quality levels. */
const previewEvery = (level: number): number => (level >= 3 ? 4 : 2)
const PALM = [0, 5, 9, 13, 17]

function palmOf(landmarks: Landmark[]): Point {
  let x = 0
  let y = 0
  for (const i of PALM) {
    x += landmarks[i]!.x
    y += landmarks[i]!.y
  }
  return toScreen(view, { x: x / PALM.length, y: y / PALM.length })
}

/** Per-stage timings (ms, rolling means) shown in the Control window. */
const stage = {
  grab: new RollingAverage(30),
  track: new RollingAverage(30),
  latency: new RollingAverage(30),
  gestures: new RollingAverage(30),
  effects: new RollingAverage(60),
  render: new RollingAverage(60),
  preview: new RollingAverage(30),
  work: new RollingAverage(60),
  frame: new RollingAverage(60)
}

async function main(): Promise<void> {
  const video = await openCamera()
  const pixi = await createStage(video, view)
  let control = ControlPanel.open()

  // Effects
  const particles = new ParticleEngine(pixi.front, pixi.app.renderer, view.width, view.height, view.mirror)
  const camera = new CameraMoves(pixi.scene, view.width, view.height)
  const clips = new ClipEngine({ back: pixi.back, front: pixi.front }, view.width, view.height, view.mirror, (cfg, ctx) => {
    // Missing clip file: a spark burst at the same spot so the trigger still reads.
    particles.play({ type: 'particles', preset: 'sparks', anchor: cfg.anchor, count: 220 }, ctx)
  })
  const registry = new EffectRegistry({ particles, clips, camera })
  const triggers = new TriggerEngine()

  // Perception state
  const quality = new QualityController({ trackEvery: 2, adaptive: true })
  const scheduler = new FrameScheduler(quality.settings.trackEvery)
  const smoother = new HandSmoother()
  const gestures = new GestureTracker(view)
  let labels: { side: string; label: string | null }[] = []
  /** Hands predicted for the camera frame currently on screen (reused objects). */
  let predicted: TrackedHand[] = []
  let cameraFrameAt = 0
  let trackerStatus = 'starting…'
  let trackErrors = 0

  const applyQuality = (): void => {
    const s = quality.settings
    scheduler.trackEvery = s.trackEvery
    particles.setScale(s.particleScale)
    // Cap slightly above the target: an exact 60 cap on a 60 Hz display drops frames to vsync
    // jitter, while a 120 Hz display still gets every other frame (≈60).
    pixi.app.ticker.maxFPS = s.maxRenderFps * 1.08
  }
  applyQuality()

  // Debug state
  const renderFps = new FpsMeter()
  const cameraFps = new FpsMeter()
  const trackFps = new FpsMeter()
  let longTaskMs = 0
  let longTaskPerS = 0
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) longTaskMs += e.duration
  }).observe({ type: 'longtask' })
  let configStatus = 'loading…'
  let speechStatus = 'loading model…'
  let speechDecodeShare = 1
  let micPeak = 0
  let lastWord = '—'
  const recent: string[] = []
  const log = (line: string): void => {
    recent.unshift(line)
    recent.length = Math.min(recent.length, 6)
    console.log(`[trigger] ${line}`)
  }

  function play(firings: readonly Firing[], what: string): void {
    if (firings.length === 0) return
    const hands = predicted.map((h) => palmOf(h.landmarks))
    for (const firing of firings) {
      // One context per firing: a clip that is still loading keeps it until it plays.
      const ctx: EffectContext = firing.position ? { position: firing.position, hands } : { hands }
      for (const name of firing.effects) registry.play(name, ctx, performance.now())
      log(`${what} → ${firing.effects.join(' + ')}`)
    }
  }

  function dispatch(event: TriggerEvent): void {
    play(triggers.handle(event), event.type === 'gesture' ? event.gesture : `"${event.word}"`)
  }

  // Config (validated + hot-reloaded in main)
  let config: Config | null = null
  let speech: SpeechInput | null = null
  const applyConfig = (result: ConfigResult): void => {
    if (!result.ok) {
      configStatus = `ERROR (keeping last good): ${result.error.split('\n').slice(0, 2).join(' ')}`
      console.error(`[config] ${result.error}`)
      return
    }
    if (result.config !== config) {
      config = result.config
      triggers.setRules(config.rules, config.defaultCooldownMs)
      registry.setEffects(config.effects)
      speech?.setWords(config.words)
      quality.configure(config.performance)
      applyQuality()
    }
    configStatus = result.error
      ? `ERROR (keeping last good): ${result.error.split('\n').slice(0, 2).join(' ')}`
      : `ok · ${config.rules.length} rules · ${Object.keys(config.effects).length} effects`
  }
  window.skillcam.onConfig(applyConfig)
  applyConfig(await window.skillcam.getConfig())

  // Hands: the tracker worker answers each frame it gets; gestures + triggers run on the result.
  const onTracker = (msg: TrackerMessage): void => {
    if (msg.at !== undefined) scheduler.done(msg.at)
    if (msg.type === 'error') {
      trackErrors++
      if (msg.fatal) trackerStatus = `FAILED: ${msg.message}`
      console.error(`[hands] ${msg.message}`)
      return
    }
    const t0 = performance.now()
    stage.track.push(msg.ms)
    stage.latency.push(t0 - msg.at)
    trackFps.tick(t0)
    quality.tracked(msg.ms)
    const raw = assignSides(
      msg.hands.map(
        (h): RawHand => ({ landmarks: h.landmarks, side: correctHandedness(h.handedness), builtin: h.builtin })
      )
    )
    smoother.observe(raw, msg.at)
    const update = gestures.update(raw, msg.at)
    labels = update.hands
    control?.setLabels(update.hands)
    update.events.forEach(dispatch)
    stage.gestures.push(performance.now() - t0)
  }
  const tracker = await HandTracker.start(onTracker, (config as Config | null)?.performance.trackerDelegate ?? 'GPU').catch((err: unknown) => {
    trackerStatus = `FAILED: ${String(err)}`
    console.error('[hands] tracker failed to start', err)
    return null
  })
  if (tracker) trackerStatus = tracker.delegate

  // Per camera frame: hand the frame to the tracker if it's due and the worker is free. Never waits.
  onEachVideoFrame(
    video,
    (now) => {
      cameraFps.tick(now)
      cameraFrameAt = now
      if (!tracker || !scheduler.offer(now)) return
      const t0 = performance.now()
      if (!tracker.send(video, now)) scheduler.done(now)
      stage.grab.push(performance.now() - t0)
    },
    (err) => console.error('[hands] frame step failed', err)
  )

  // Speech → word events
  SpeechInput.start({
    onLevel(peak) {
      micPeak = Math.max(peak, micPeak * 0.8)
    },
    onWord(word, at) {
      lastWord = `${word.word}${word.partial ? ' (partial)' : ` (final, ${Math.round(word.latencyMs ?? 0)} ms)`}`
      console.log(`[speech] ${lastWord}`)
      dispatch({ type: 'word', word: word.word, confidence: word.confidence, partial: word.partial, at })
    }
  })
    .then((s) => {
      speech = s
      if (config) s.setWords(config.words)
      speechStatus = 'on'
    })
    .catch((err: unknown) => {
      speechStatus = 'FAILED'
      console.error('[speech] failed to start', err)
    })

  // Render loop. Order per frame: update (priority 0) → Pixi render (LOW) → after-render (UTILITY).
  const ticker = pixi.app.ticker
  let frameStart = 0
  let renderStart = 0
  let lastFrameAt = 0
  let frameCount = 0
  let lastStatsAt = 0
  let lastSecondAt = 0
  /** Model loading and the first uploads stall startup; don't let that count as load. */
  const qualityFrom = performance.now() + 3000

  ticker.add(() => {
    const now = performance.now()
    frameStart = now
    renderFps.tick(now)
    play(triggers.tick(now), 'held word')
    predicted = smoother.predict(cameraFrameAt)
    particles.update(Math.min(ticker.deltaMS, 100) / 1000)
    camera.update(now)
    stage.effects.push(performance.now() - now)
  })
  // Between our update (0) and Pixi's render (LOW = -25).
  ticker.add(() => (renderStart = performance.now()), undefined, -10)
  ticker.add(() => {
    const now = performance.now()
    stage.render.push(now - renderStart)
    frameCount++
    let previewMs = 0
    if (control && frameCount % previewEvery(quality.level) === 0) {
      if (control.closed) control = null
      else {
        control.drawPreview(pixi.app.canvas, predicted)
        previewMs = performance.now() - now
        stage.preview.push(previewMs)
      }
    }
    const end = performance.now()
    // The Control preview isn't part of the output; keep it out of the quality signal (no level changes it).
    const work = end - frameStart - previewMs
    const frameMs = lastFrameAt ? end - lastFrameAt : 1000 / 60
    lastFrameAt = end
    stage.work.push(work)
    stage.frame.push(frameMs)
    const before = quality.level
    if (end >= qualityFrom) quality.frame(end, frameMs, work)
    if (quality.level !== before) {
      applyQuality()
      log(`quality → L${quality.level} (track every ${quality.settings.trackEvery}, particles ×${quality.settings.particleScale}, ≤${quality.settings.maxRenderFps} fps)`)
    }
    if (end - lastSecondAt >= 1000) {
      speechDecodeShare = speech?.takeDecodeShare() ?? 1
      longTaskPerS = (longTaskMs * 1000) / (end - lastSecondAt)
      longTaskMs = 0
      lastSecondAt = end
    }
    if (end - lastStatsAt >= STATS_MS) {
      lastStatsAt = end
      publishStats()
    }
  }, undefined, -50)

  const ms = (a: RollingAverage): string => a.value.toFixed(1)
  function publishStats(): void {
    const q = quality.settings
    control?.setStats([
      `render ${renderFps.fps.toFixed(0)} fps (cap ${q.maxRenderFps}) · camera ${cameraFps.fps.toFixed(0)} fps · tracked ${trackFps.fps.toFixed(0)}/s`,
      `quality L${quality.level}/${QUALITY_LEVELS.length - 1}: track every ${q.trackEvery} · particles ×${q.particleScale} · tracker ${trackerStatus}${trackErrors ? ` · ${trackErrors} errors` : ''}`,
      `stages ms  grab ${ms(stage.grab)} · track ${ms(stage.track)} (worker) · latency ${ms(stage.latency)} · gestures ${ms(stage.gestures)}`,
      `           effects ${ms(stage.effects)} · render ${ms(stage.render)} · preview ${ms(stage.preview)} · main/frame ${ms(stage.work)} · interval ${ms(stage.frame)}`,
      `long tasks ${longTaskPerS.toFixed(0)} ms/s · tracker busy skips ${scheduler.busySkips} · particles ${particles.count}`,
      `config ${configStatus} · ${triggers.armed ? 'ARMED' : 'disarmed'}`,
      `speech ${speechStatus} ${'█'.repeat(Math.round(micPeak * 12)).padEnd(12, '·')} decoding ${(speechDecodeShare * 100).toFixed(0)}% · last: ${lastWord}`
    ])
    control?.setLog(recent.map((r, i) => `${i === 0 ? 'fired' : '     '} ${r}`))
    if (import.meta.env.DEV) {
      // Text-only snapshot for dev tooling (CDP), so diagnostics never need a camera frame.
      ;(window as unknown as { __skillcam: unknown }).__skillcam = {
        perf: {
          renderFps: renderFps.fps,
          cameraFps: cameraFps.fps,
          trackFps: trackFps.fps,
          quality: quality.level,
          grabMs: stage.grab.value,
          trackMs: stage.track.value,
          latencyMs: stage.latency.value,
          gesturesMs: stage.gestures.value,
          effectsMs: stage.effects.value,
          renderMs: stage.render.value,
          previewMs: stage.preview.value,
          mainWorkMs: stage.work.value,
          frameIntervalMs: stage.frame.value,
          longTaskMsPerS: longTaskPerS,
          speechDecode: speechDecodeShare,
          micPeak
        },
        tracker: trackerStatus,
        hands: labels.map((h) => `${h.side}:${h.label}`),
        particles: particles.count,
        configStatus,
        speechStatus,
        lastWord,
        recent
      }
    }
  }
}

main().catch((err: unknown) => console.error(`[output] fatal ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`))
