import { ControlPanel } from '../control/panel'
import type { Config, ConfigResult } from '../shared/config'
import type { EffectContext, Point, ScreenBox, TriggerEvent } from '../shared/types'
import { openCamera } from './camera'
import { FpsMeter, RollingAverage } from './debug/fpsMeter'
import { CameraMoves } from './effects/cameraMove'
import { ClipEngine } from './effects/clip'
import { ParticleEngine } from './effects/particles'
import { EffectRegistry } from './effects/registry'
import { type Firing, TriggerEngine } from './engine/triggers'
import { QualityController, QUALITY_LEVELS } from './perf/quality'
import { type FaceBox, FaceSmoother } from './perception/faceSmoother'
import { onEachVideoFrame } from './perception/frameLoop'
import { assignSides, GestureTracker, type RawHand } from './perception/gestures'
import type { Landmark } from './perception/handGeometry'
import { HandSmoother, type TrackedHand } from './perception/handSmoother'
import { MODELS, PerceptionClient, type PerceptionMessage } from './perception/perceptionClient'
import type { FrameTasks, HandsResult, WorkerModels } from './perception/perceptionProtocol'
import { type Task, TaskScheduler } from './perception/taskScheduler'
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
/**
 * A mask older than this no longer matches the picture: drop the person layer (back FX over the
 * camera). The limit is at least 500 ms and 2.5 expected segmentation intervals, so a slow camera
 * or a high quality level (masks further apart) doesn't make the layer flicker on and off.
 */
const MASK_STALE_MS = 500
const maskStaleMs = (segmentEvery: number, cameraFps: number): number =>
  Math.max(MASK_STALE_MS, (2.5 * segmentEvery * 1000) / Math.max(cameraFps, 5))
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

/** Normalized raw camera box → output pixels (mirrored if the view is). */
function boxToScreen(b: FaceBox): ScreenBox {
  const x = view.mirror ? 1 - (b.x + b.width) : b.x
  return { x: x * view.width, y: b.y * view.height, width: b.width * view.width, height: b.height * view.height }
}

/** One perception worker, the tasks it hosts and its frame scheduler. */
interface Pipe {
  name: string
  hosts: readonly Task[]
  client: PerceptionClient | null
  scheduler: TaskScheduler
  /** Reused per send (structured-cloned by postMessage). */
  tasks: FrameTasks
}

/** Per-stage timings (ms, rolling means) shown in the Control window. */
const stage = {
  grab: new RollingAverage(30),
  track: new RollingAverage(30),
  segment: new RollingAverage(30),
  face: new RollingAverage(15),
  prep: new RollingAverage(30),
  worker: new RollingAverage(30),
  mask: new RollingAverage(30),
  latency: new RollingAverage(30),
  gestures: new RollingAverage(30),
  effects: new RollingAverage(60),
  render: new RollingAverage(60),
  preview: new RollingAverage(30),
  work: new RollingAverage(60),
  frame: new RollingAverage(60)
}

async function main(): Promise<void> {
  // Startup settings (camera, output size, workers) come from the first config; later edits hot-reload the rest.
  const first = await window.skillcam.getConfig()
  const startup = first.ok ? first.config : null
  const outputHeight = startup?.video.outputHeight ?? 1080
  const video = await openCamera(startup?.video.camera)
  const pixi = await createStage(video, view, { width: (outputHeight * 16) / 9, height: outputHeight })
  let control = ControlPanel.open()

  // Effects
  const particles = new ParticleEngine(pixi.front, pixi.app.renderer, view.width, view.height, view.mirror)
  const camera = new CameraMoves(pixi.scene, view.width, view.height, pixi.setGrade)
  const clips = new ClipEngine({ back: pixi.back, front: pixi.front }, view.width, view.height, view.mirror, (cfg, ctx) => {
    // Missing clip file: a spark burst at the same spot so the trigger still reads.
    particles.play({ type: 'particles', preset: 'sparks', anchor: cfg.anchor, count: 220 }, ctx)
  })
  const registry = new EffectRegistry({ particles, clips, camera })
  const triggers = new TriggerEngine()

  // Perception state
  const quality = new QualityController(startup?.performance ?? { trackEvery: 2, adaptive: true })
  const smoother = new HandSmoother()
  const faces = new FaceSmoother()
  let segmentation = startup?.performance.segmentation ?? true
  /** When the last mask arrived (−∞ = never). */
  let maskAt = -Infinity
  let lastMask: Uint8Array | null = null
  /** Dev: a synthetic mask replaces the segmenter's. */
  let fakeMask = false
  let maskCount = 0
  let lastFace: FaceBox | null = null
  const gestures = new GestureTracker(view)
  let labels: { side: string; label: string | null }[] = []
  /** Hands predicted for the camera frame currently on screen (reused objects). */
  let predicted: TrackedHand[] = []
  let cameraFrameAt = 0
  let trackerStatus = 'starting…'
  let trackErrors = 0

  // One worker hosts every task, or hands get their own (performance.perceptionWorkers, read at startup).
  const workerCount = startup?.performance.perceptionWorkers ?? 1
  const groups: Task[][] = workerCount === 2 ? [['hands'], ['segment', 'face']] : [['hands', 'segment', 'face']]
  const pipes: Pipe[] = groups.map((hosts, i) => ({
    name: workerCount === 2 ? (i === 0 ? 'hands' : 'segment+face') : 'all',
    hosts,
    client: null,
    scheduler: new TaskScheduler({ hands: 0, segment: 0, face: 0 }),
    tasks: { hands: false, segment: null, face: false }
  }))

  /** Current segmentation stride, cached here so the render loop doesn't allocate a strides object per frame. */
  let segmentStride = 2
  const applyQuality = (): void => {
    const s = quality.settings
    const want = quality.strides
    segmentStride = want.segment
    for (const pipe of pipes) {
      for (const t of ['hands', 'segment', 'face'] as const) pipe.scheduler.every[t] = pipe.hosts.includes(t) && pipe.client?.tasks.includes(t) ? want[t] : 0
    }
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
    const face = faces.get(performance.now())
    for (const firing of firings) {
      // One context per firing: a clip that is still loading keeps it until it plays.
      const ctx: EffectContext = firing.position ? { position: firing.position, hands } : { hands }
      if (face) ctx.face = boxToScreen(face.box)
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
      segmentation = config.performance.segmentation
      applyQuality()
    }
    configStatus = result.error
      ? `ERROR (keeping last good): ${result.error.split('\n').slice(0, 2).join(' ')}`
      : `ok · ${config.rules.length} rules · ${Object.keys(config.effects).length} effects`
  }
  window.skillcam.onConfig(applyConfig)
  applyConfig(first)

  // Perception: each worker answers every frame it gets; hands → gestures + triggers, mask → person layer, face → anchor.
  const onPerception = (pipe: Pipe, msg: PerceptionMessage): void => {
    if (msg.type === 'hands') return onHands(msg)
    if (msg.at !== undefined) pipe.scheduler.done(msg.at)
    if (msg.type === 'error') {
      trackErrors++
      if (msg.fatal) trackerStatus = `FAILED (${pipe.name}): ${msg.message}`
      console.error(`[perception] ${pipe.name}: ${msg.message}`)
      return
    }
    const t0 = performance.now()
    stage.worker.push(msg.ms.total)
    stage.prep.push(msg.ms.prep)
    quality.worked(msg.ms)
    if (msg.mask && !fakeMask) {
      const m = msg.mask
      lastMask = m.data
      pixi.camera.setMask(m.data, m.width, m.height)
      control?.setMask(m.data, m.width, m.height)
      maskAt = t0
      maskCount++
      stage.segment.push(msg.ms.segment ?? 0)
    }
    if (msg.face !== undefined) {
      faces.observe(msg.face, msg.at)
      lastFace = msg.face
      stage.face.push(msg.ms.face ?? 0)
    }
    if (msg.mask) stage.mask.push(performance.now() - t0)
  }
  // Hands arrive ahead of the frame's other results (see HandsResult).
  const onHands = (msg: HandsResult): void => {
    const t0 = performance.now()
    stage.track.push(msg.ms)
    stage.latency.push(t0 - msg.at)
    trackFps.tick(t0)
    const raw = assignSides(msg.hands.map((h): RawHand => ({ landmarks: h.landmarks, side: correctHandedness(h.handedness), builtin: h.builtin })))
    smoother.observe(raw, msg.at)
    const update = gestures.update(raw, msg.at)
    labels = update.hands
    control?.setLabels(update.hands)
    update.events.forEach(dispatch)
    stage.gestures.push(performance.now() - t0)
  }
  const delegate = startup?.performance.trackerDelegate ?? 'GPU'
  await Promise.all(
    pipes.map(async (pipe) => {
      const models: WorkerModels = {}
      if (pipe.hosts.includes('hands')) models.hands = { model: MODELS.hands, delegate }
      // Segmentation and face detection load even when off in the config, so a hot reload can switch them on.
      const segDelegate = startup?.performance.segmentDelegate ?? 'GPU'
      if (pipe.hosts.includes('segment')) models.segment = { model: MODELS.segment, delegate: segDelegate }
      if (pipe.hosts.includes('face')) models.face = { model: MODELS.face, delegate: segDelegate }
      pipe.client = await PerceptionClient.start(models, (msg) => onPerception(pipe, msg)).catch((err: unknown) => {
        trackerStatus = `FAILED (${pipe.name}): ${String(err)}`
        console.error(`[perception] ${pipe.name} worker failed to start`, err)
        return null
      })
    })
  )
  if (!trackerStatus.startsWith('FAILED')) {
    trackerStatus = pipes.map((p) => `${p.name}: ${(p.client?.tasks ?? []).map((t) => `${t} ${p.client?.delegates[t]}`).join(', ')}`).join(' | ')
  }
  applyQuality()

  // Per camera frame: hand the frame to each worker that has a task due and is free. Never waits.
  onEachVideoFrame(
    video,
    (now) => {
      cameraFps.tick(now)
      cameraFrameAt = now
      const mask = quality.settings.mask
      for (const pipe of pipes) {
        if (!pipe.client || !pipe.scheduler.offer(now)) continue
        const due = pipe.scheduler.due
        pipe.tasks.hands = due.hands
        pipe.tasks.segment = due.segment ? mask : null
        pipe.tasks.face = due.face
        const t0 = performance.now()
        if (!pipe.client.send(video, now, pipe.tasks)) pipe.scheduler.done(now)
        stage.grab.push(performance.now() - t0)
      }
    },
    (err) => console.error('[perception] frame step failed', err)
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

  if (import.meta.env.DEV) {
    // Dev-only hooks for scripts/perf-probe.mjs (CDP): trigger effects and measure GPU render cost without a camera subject.
    ;(window as unknown as { __skillcamDev: unknown }).__skillcamDev = {
      play: (name: string) => play([{ rule: -1, effects: [name] }], `dev ${name}`),
      /** Forces the person layer on (true), off (false) or back to automatic (null) for measurements. */
      cutout: (on: boolean | null) => (forceCutout = on),
      /** Mean person confidence (0–1) of the latest real mask: tells which way round the model's mask is. */
      maskMean: () => (lastMask ? lastMask.reduce((a, b) => a + b, 0) / lastMask.length / 255 : null),
      /** Replaces the segmentation with a fixed person-shaped mask (head + shoulders), to check the compositing without a person. */
      fakeMask(on: boolean) {
        fakeMask = on
        if (!on) return
        const w = 256
        const h = 144
        const data = new Uint8Array(w * h)
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const head = ((x - 128) / 26) ** 2 + ((y - 50) / 34) ** 2 < 1
            const body = ((x - 128) / 70) ** 2 + ((y - 150) / 62) ** 2 < 1
            data[y * w + x] = head || body ? 255 : 0
          }
        }
        pixi.camera.setMask(data, w, h)
        control?.setMask(data, w, h)
      },
      /**
       * Renders the stage `frames` times, each followed by a 1-pixel readPixels (Chromium's gl.finish
       * doesn't block; a readback has to wait for the GPU), so the time includes the GPU's work:
       * the true per-frame render cost at the current output size, plus a fixed sync overhead. Ms per frame.
       */
      bench(frames = 120): number {
        const gl = (pixi.app.renderer as unknown as { gl: WebGL2RenderingContext }).gl
        const px = new Uint8Array(4)
        const once = (): void => {
          pixi.app.renderer.render(pixi.app.stage)
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
        }
        once()
        const t0 = performance.now()
        for (let i = 0; i < frames; i++) once()
        return (performance.now() - t0) / frames
      },
      /** The fixed cost of the readback sync alone (an empty render target), to subtract from bench(). */
      syncCost(frames = 120): number {
        const gl = (pixi.app.renderer as unknown as { gl: WebGL2RenderingContext }).gl
        const px = new Uint8Array(4)
        const t0 = performance.now()
        for (let i = 0; i < frames; i++) {
          gl.clear(gl.COLOR_BUFFER_BIT)
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
        }
        return (performance.now() - t0) / frames
      }
    }
  }
  let forceCutout: boolean | null = null

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
    if (fakeMask) maskAt = now
    // The person cutout costs a full-screen pass: draw it only while back FX exist and the mask is fresh.
    pixi.camera.person.visible =
      forceCutout ?? (segmentation && pixi.back.children.length > 0 && now - maskAt < maskStaleMs(segmentStride, cameraFps.fps))
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
        const face = faces.get(now)
        control.drawPreview(pixi.app.canvas, predicted, face)
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
  const maskAge = (): string => (Number.isFinite(maskAt) ? `${Math.round(performance.now() - maskAt)} ms` : 'none')
  const faceStatus = (): string => {
    const f = faces.get(performance.now())
    if (!f) return lastFace === null && quality.strides.face ? 'none' : quality.strides.face ? 'lost' : 'off'
    return `${f.visible ? 'seen' : 'HELD (occluded)'} ${(f.box.width * 100).toFixed(0)}% wide`
  }
  function publishStats(): void {
    const q = quality.settings
    control?.setStats([
      `render ${renderFps.fps.toFixed(0)} fps (cap ${q.maxRenderFps}) · camera ${cameraFps.fps.toFixed(0)} fps · tracked ${trackFps.fps.toFixed(0)}/s`,
      `quality L${quality.level}/${QUALITY_LEVELS.length - 1}: track every ${q.trackEvery} · particles ×${q.particleScale} · tracker ${trackerStatus}${trackErrors ? ` · ${trackErrors} errors` : ''}`,
      `stages ms  grab ${ms(stage.grab)} · hands ${ms(stage.track)} · latency ${ms(stage.latency)} · gestures ${ms(stage.gestures)}`,
      `           effects ${ms(stage.effects)} · render ${ms(stage.render)} · preview ${ms(stage.preview)} · main/frame ${ms(stage.work)} · interval ${ms(stage.frame)}`,
      `worker ms  total/frame ${ms(stage.worker)} · prep ${ms(stage.prep)} · segment ${ms(stage.segment)} · face ${ms(stage.face)} · mask apply (CPU; GPU upload counts in render) ${ms(stage.mask)}`,
      `segment ${segmentation ? `every ${quality.strides.segment} · mask ${q.mask.width}×${q.mask.height} · age ${maskAge()} · cutout ${pixi.camera.person.visible ? 'ON' : 'idle'}` : 'off'} · face ${faceStatus()}`,
      `long tasks ${longTaskPerS.toFixed(0)} ms/s · worker busy skips ${pipes.map((p) => p.scheduler.busySkips).join('/')} · particles ${particles.count}`,
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
          segmentMs: stage.segment.value,
          faceMs: stage.face.value,
          prepMs: stage.prep.value,
          workerMs: stage.worker.value,
          maskApplyMs: stage.mask.value,
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
        extra: {
          canvas: `${pixi.app.canvas.width}×${pixi.app.canvas.height}`,
          strides: quality.strides,
          mask: quality.settings.mask,
          maskAge: maskAge(),
          masks: maskCount,
          cutout: pixi.camera.person.visible,
          face: faceStatus()
        },
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
