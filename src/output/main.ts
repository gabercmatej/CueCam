import { health } from '../control/health'
import { gestureName, ruleKey, ruleNote, ruleTrigger } from '../control/labels'
import { ControlPanel, type Issue, type PanelState } from '../control/panel'
import type { AppStatus, MediaChange } from '../shared/api'
import type { Config, ConfigResult } from '../shared/config'
import type { EffectContext, HandSide, Point, ScreenBox, TriggerEvent } from '../shared/types'
import { AudioEngine } from './audio/audioEngine'
import type { Onset } from './audio/clapOnset'
import { LiveCamera } from './camera'
import { FpsMeter, RollingAverage } from './debug/fpsMeter'
import { CameraMoves } from './effects/cameraMove'
import { ClipEngine } from './effects/clip'
import { LightPaint } from './effects/lightPaint'
import { type HandPoint, MediaEngine } from './effects/media'
import { ParticleEngine } from './effects/particles'
import { EffectRegistry } from './effects/registry'
import { type Firing, TriggerEngine } from './engine/triggers'
import { GestureLatency } from './perf/gestureLatency'
import { QualityController, QUALITY_LEVELS } from './perf/quality'
import { type FaceBox, FaceSmoother } from './perception/faceSmoother'
import { ClapFusion, type FusedClap } from './perception/clapFusion'
import { onEachVideoFrame } from './perception/frameLoop'
import { assignSides, GESTURE_TUNING, GestureTracker, type HandState, type RawHand } from './perception/gestures'
import type { HandPose } from './perception/__fixtures__/hands'
import type { Landmark } from './perception/handGeometry'
import { HandSmoother, type TrackedHand } from './perception/handSmoother'
import { MODELS, PerceptionClient, type PerceptionMessage } from './perception/perceptionClient'
import type { FrameTasks, HandsResult, TrackedHandResult, WorkerModels } from './perception/perceptionProtocol'
import { type Task, TaskScheduler } from './perception/taskScheduler'
import { decoysFor } from './perception/decoys'
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

/** Rules switched off in the Control window, by signature (labels.ruleKey), kept in this page's storage. */
const DISABLED_KEY = 'skillcam.disabledRules'
function readDisabled(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(DISABLED_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : []
  } catch {
    return []
  }
}
function writeDisabled(keys: ReadonlySet<string>): void {
  try {
    localStorage.setItem(DISABLED_KEY, JSON.stringify([...keys]))
  } catch {
    // Not saved: the switch still applies until restart.
  }
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
  /** Camera capture → frame callback (rVFC captureTime), when the camera reports it. */
  capture: new RollingAverage(30),
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
  /** The Control window's 250 ms update (state + DOM writes), not per frame. */
  panel: new RollingAverage(20),
  work: new RollingAverage(60),
  frame: new RollingAverage(60)
}

async function main(): Promise<void> {
  // Startup settings (camera, output size, workers) come from the first config; later edits hot-reload the rest.
  const first = await window.skillcam.getConfig()
  const startup = first.ok ? first.config : null
  const outputHeight = startup?.video.outputHeight ?? 1080
  // The Control window opens first, so a missing or blocked camera is explained there, not only in the terminal.
  let control = ControlPanel.open()
  let appStatus: AppStatus | null = null
  void window.skillcam.getStatus().then((st) => (appStatus = st))
  window.skillcam.onStatus((st) => (appStatus = st))
  // Everything that can arrive while we wait for a camera (which may take forever) is kept, not dropped:
  // the latest config, the armed state, file changes. Their real handlers are wired once the camera works.
  let latestConfig: ConfigResult = first
  let onConfigReady: ((result: ConfigResult) => void) | null = null
  window.skillcam.onConfig((result) => {
    latestConfig = result
    onConfigReady?.(result)
  })
  let armedEarly = true
  let toggleArmed = (): void => {
    armedEarly = !armedEarly
  }
  window.skillcam.onToggleArmed(() => toggleArmed())
  let onMediaReady: ((change: MediaChange) => void) | null = null
  window.skillcam.onMediaChanged((change) => onMediaReady?.(change))
  const noop = (): void => {}
  control?.on({ toggleArmed: () => toggleArmed(), test: noop, setRuleEnabled: noop, sendToCall: noop, monitorVolume: noop })
  const cam = new LiveCamera(startup?.video.camera)
  // Until the camera works, the panel shows only that (everything else starts after it).
  const publishWaiting = (): void => {
    if (!control?.visible) return
    const h = health({
      status: appStatus,
      camera: { state: cam.state, problem: cam.problem, label: cam.label, fps: 0, sinceOkMs: 0 },
      tracking: { started: false, failed: null, perSecond: 0, errors: 0 },
      speech: { state: 'loading', error: null },
      call: { sendToCall: false, active: false, status: 'off', micError: null }
    })
    const c = latestConfig
    const configIssue: Issue[] = c.ok && !c.error ? [] : [{ level: 'error', title: 'skillcam.config.json is invalid', detail: c.error ?? '' }]
    control.update(
      { armed: armedEarly, hotkey: appStatus?.hotkey ?? null, health: h, issues: configIssue, last: null, gestures: '', heard: [], heardText: '', ruleProblems: new Map(), audio: { route: '', micDb: -120, mixDb: -120 } },
      performance.now()
    )
  }
  const waitingPanel = setInterval(publishWaiting, 250)
  const video = await cam.open()
  clearInterval(waitingPanel)
  const pixi = await createStage(video, view, { width: (outputHeight * 16) / 9, height: outputHeight })

  // Effects
  const particles = new ParticleEngine(pixi.front, pixi.app.renderer, view.width, view.height, view.mirror)
  const camera = new CameraMoves(pixi.scene, view.width, view.height, pixi.setGrade)
  const clips = new ClipEngine({ back: pixi.back, front: pixi.front }, view.width, view.height, view.mirror, (cfg, ctx) => {
    // Missing clip file: a spark burst at the same spot so the trigger still reads.
    particles.play({ type: 'particles', preset: 'sparks', anchor: cfg.anchor, count: 220 }, ctx)
  })
  const clapFusion = new ClapFusion()
  /** The latest sound onset on the raw mic (clap or rejected), for the Control window. */
  let lastOnset: { onset: Onset; at: number } | null = null
  const onsetCounts = { clap: 0, quiet: 0, dull: 0, long: 0 }
  // Set once the trigger engine exists (below); a sound can't arrive before the mic has started anyway.
  let onFusedClap: (clap: FusedClap) => void = () => {}
  const audio = new AudioEngine({
    onOnset(onset, at) {
      lastOnset = { onset, at }
      onsetCounts[onset.verdict]++
      if (onset.verdict !== 'clap') return
      const clap = clapFusion.sound(at, performance.now())
      if (clap) onFusedClap(clap)
    }
  })
  const media = new MediaEngine({ back: pixi.back, front: pixi.front }, pixi.app.renderer, view.width, view.height, view.mirror, audio, (cfg, ctx) => {
    // All files missing for an anchored/full-frame effect: a spark burst so the trigger still reads.
    particles.play({ type: 'particles', preset: 'sparks', anchor: cfg.anchor, count: 220 }, ctx)
  })
  const lightPaint = new LightPaint(pixi.front, pixi.app.renderer, view.width, view.height, pixi.app.renderer.resolution)
  const registry = new EffectRegistry({ particles, clips, camera, media, lightPaint })
  const triggers = new TriggerEngine()
  const latency = new GestureLatency()
  /** Rule signatures switched off in the Control window (kept across config reloads and restarts). */
  const disabledKeys = new Set<string>(readDisabled())
  function setArmed(on: boolean): void {
    if (triggers.armed === on) return
    triggers.armed = on
    audio.playCue(on)
    if (!on) {
      const now = performance.now()
      registry.windDown(now)
      audio.fadeOutSounds()
    }
    console.log(`[armed] ${on ? 'ARMED' : 'disarmed'}`)
  }
  triggers.armed = armedEarly
  toggleArmed = () => setArmed(!triggers.armed)
  const handlers = {
    toggleArmed: () => toggleArmed(),
    test: (i: number) => {
      const rule = config?.rules[i]
      if (rule) play([{ rule: i, effects: rule.play }], 'Test button')
    },
    setRuleEnabled: (i: number, on: boolean) => {
      const rule = config?.rules[i]
      if (!rule) return
      if (on) disabledKeys.delete(ruleKey(rule))
      else disabledKeys.add(ruleKey(rule))
      writeDisabled(disabledKeys)
      applyDisabled()
      control?.setRuleStates(config?.rules.map((r) => !disabledKeys.has(ruleKey(r))) ?? [])
    },
    sendToCall: (on: boolean) => audio.setSendToCall(on),
    monitorVolume: (v: number) => audio.setMonitorVolume(v)
  }
  control?.on(handlers)
  /** The effects list, from the config and the switches (every row re-read, so no row can show a stale switch). */
  function showRules(): void {
    const cfg = config
    if (!cfg) return
    control?.setRules(
      cfg.rules.map((r) => ({
        trigger: ruleTrigger(r),
        effects: r.play.join(' + '),
        note: ruleNote(r, r.play.map((name) => cfg.effects[name]?.type ?? '')),
        enabled: !disabledKeys.has(ruleKey(r))
      }))
    )
  }
  const applyDisabled = (): void => {
    const off = new Set<number>()
    config?.rules.forEach((r, i) => disabledKeys.has(ruleKey(r)) && off.add(i))
    triggers.setDisabled(off)
  }
  /** Dev: fixture hands replacing the tracker's (end-to-end latency without a person on camera). */
  let fakeHands: TrackedHandResult[] | null = null

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
  /** The latest tracking result's per-hand state (labels, pinch). */
  let labels: HandState[] = []
  /** Hands for effects this frame (palm + size in stage px), from the predicted landmarks; reused objects. */
  const handPoints: HandPoint[] = []
  const handPool: Record<HandSide, HandPoint> = {
    Left: { side: 'Left', palm: { x: 0, y: 0 }, size: 0 },
    Right: { side: 'Right', palm: { x: 0, y: 0 }, size: 0 }
  }
  const pinchPoint: Point = { x: 0, y: 0 }
  /** The pinch point of a hand that is still pinching (light painting), or null. */
  const pinchOf = (side: HandSide): Point | null => {
    let pinching = false
    for (const h of labels) if (h.side === side && h.pinching) pinching = true
    let hand: TrackedHand | undefined
    for (const h of predicted) if (h.side === side) hand = h
    if (!pinching || !hand) return null
    const a = hand.landmarks[4]!
    const b = hand.landmarks[8]!
    const x = (a.x + b.x) / 2
    pinchPoint.x = (view.mirror ? 1 - x : x) * view.width
    pinchPoint.y = ((a.y + b.y) / 2) * view.height
    return pinchPoint
  }
  /** Hands predicted for the camera frame currently on screen (reused objects). */
  let predicted: TrackedHand[] = []
  let cameraFrameAt = 0
  let trackerStatus = 'starting…'
  let burstCount = 0
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
  let configError: string | null = null
  let speechState: 'loading' | 'on' | 'failed' = 'loading'
  let speechError: string | null = null
  let speechStatus = 'loading model…'
  let trackerFailed: string | null = null
  let trackersStarted = false
  let lastTrigger: PanelState['last'] = null
  const heard: { word: string; fired: boolean }[] = []
  let heardText = ''
  let speechDecodeShare = 1
  let micPeak = 0
  let lastWord = '—'
  /** Dev: every word event and firing, for false-trigger counts. */
  const wordLog: string[] = []
  const recent: string[] = []
  const log = (line: string): void => {
    recent.unshift(line)
    recent.length = Math.min(recent.length, 6)
    console.log(`[trigger] ${line}`)
  }

  function play(firings: readonly Firing[], what: string, cause = what): void {
    if (firings.length === 0) return
    const now = performance.now()
    const hands = predicted.map((h) => palmOf(h.landmarks))
    const face = faces.get(now)
    for (const firing of firings) {
      // One context per firing: a clip that is still loading keeps it until it plays.
      const ctx: EffectContext = firing.position ? { position: firing.position, hands } : { hands }
      if (firing.hand) ctx.hand = firing.hand
      if (face) ctx.face = boxToScreen(face.box)
      for (const name of firing.effects) registry.play(name, ctx, now)
      log(`${what} → ${firing.effects.join(' + ')}`)
      const rule = config?.rules[firing.rule]
      lastTrigger = { effects: firing.effects.join(' + '), cause: rule && firing.rule >= 0 && cause !== 'Test button' ? `${ruleTrigger(rule)} · ${cause}` : cause, at: now }
      if (firing.rule >= 0) control?.ruleFired(firing.rule, now)
    }
  }

  /** In words: what made a rule fire. */
  const causeOf = (event: TriggerEvent): string => {
    if (event.type === 'gesture') return event.hand === 'Both' ? 'both hands' : `${event.hand.toLowerCase()} hand`
    if (event.partial) return 'heard (fast)'
    const pause = event.pauseAfterMs === undefined ? '' : Number.isFinite(event.pauseAfterMs) ? `, ${Math.round(event.pauseAfterMs)} ms pause` : ', end of phrase'
    return `heard (final, ${event.confidence.toFixed(2)}${pause})`
  }

  function dispatch(event: TriggerEvent): number {
    const firings = triggers.handle(event)
    play(firings, event.type === 'gesture' ? event.gesture : `"${event.word}"`, causeOf(event))
    return firings.length
  }

  /** Camera contact + clap sound agreed: the Clap gesture. */
  onFusedClap = (clap) => {
    const t0 = performance.now()
    if (dispatch({ type: 'gesture', gesture: 'Clap', hand: 'Both', position: clap.position, at: clap.at, heldFrom: clap.at }) > 0) {
      latency.fired('Clap', clap.at, clap.at, t0, stage.capture.value)
    }
  }

  // Config (validated + hot-reloaded in main)
  let config: Config | null = null
  let speech: SpeechInput | null = null
  const applyConfig = (result: ConfigResult): void => {
    if (!result.ok) {
      configStatus = `ERROR (keeping last good): ${result.error.split('\n').slice(0, 2).join(' ')}`
      configError = result.error
      console.error(`[config] ${result.error}`)
      return
    }
    configError = result.error ?? null
    if (result.config !== config) {
      config = result.config
      triggers.setRules(config.rules, config.defaultCooldownMs)
      applyDisabled()
      showRules()
      gestures.setUsedGestures(new Set(config.rules.flatMap((r) => (r.when.gesture ? [r.when.gesture] : []))))
      registry.setEffects(config.effects)
      audio.configure(config.audio)
      const { windowMs, requireSound, ...sound } = config.clap
      clapFusion.settings = { windowMs, requireSound }
      audio.setClapSettings(sound)
      control?.setAudioControls(audio.sendingToCall, audio.monitorVolume)
      speech?.setWords(config.words, config.speech.decoys ? decoysFor(config.words) : [])
      quality.configure(config.performance)
      segmentation = config.performance.segmentation
      applyQuality()
    }
    configStatus = result.error
      ? `ERROR (keeping last good): ${result.error.split('\n').slice(0, 2).join(' ')}`
      : `ok · ${config.rules.length} rules · ${Object.keys(config.effects).length} effects`
  }
  onConfigReady = applyConfig
  applyConfig(latestConfig)
  // Replaced, added or removed files in reactions/ or effects/clips/ apply at once.
  onMediaReady = (change) => {
    console.log(`[media] changed in ${change.root}/: ${change.paths.join(', ')}`)
    registry.filesChanged(change.root, change.paths)
  }

  // Perception: each worker answers every frame it gets; hands → gestures + triggers, mask → person layer, face → anchor.
  const onPerception = (pipe: Pipe, msg: PerceptionMessage): void => {
    if (msg.type === 'hands') return onHands(msg)
    if (msg.at !== undefined) pipe.scheduler.done(msg.at)
    if (msg.type === 'error') {
      trackErrors++
      if (msg.fatal) {
        trackerStatus = `FAILED (${pipe.name}): ${msg.message}`
        trackerFailed = msg.message
      }
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
    if (fakeHands) msg = { ...msg, hands: fakeHands }
    stage.track.push(msg.ms)
    stage.latency.push(t0 - msg.at)
    trackFps.tick(t0)
    const raw = assignSides(msg.hands.map((h): RawHand => ({ landmarks: h.landmarks, side: correctHandedness(h.handedness), builtin: h.builtin })))
    smoother.observe(raw, msg.at)
    const update = gestures.update(raw, msg.at)
    labels = update.hands
    triggers.setActive(update.active)
    // A gesture is about to fire: sample its hold on every camera frame instead of every stride.
    if (update.burst) {
      const until = performance.now() + GESTURE_TUNING.burstMs
      for (const pipe of pipes) if (pipe.hosts.includes('hands')) pipe.scheduler.burst(until)
      burstCount++
    }
    control?.setLabels(update.hands)
    if (update.clapContact) {
      const clap = clapFusion.visual(msg.at, update.clapContact, performance.now())
      if (clap) onFusedClap(clap)
    }
    for (const e of update.events) {
      if (dispatch(e) > 0) latency.fired(e.gesture, e.heldFrom ?? e.at, e.at, t0, stage.capture.value)
    }
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
        trackerFailed = err instanceof Error ? err.message : String(err)
        console.error(`[perception] ${pipe.name} worker failed to start`, err)
        return null
      })
    })
  )
  trackersStarted = true
  if (!trackerStatus.startsWith('FAILED')) {
    trackerStatus = pipes.map((p) => `${p.name}: ${(p.client?.tasks ?? []).map((t) => `${t} ${p.client?.delegates[t]}`).join(', ')}`).join(' | ')
  }
  applyQuality()

  // Per camera frame: hand the frame to each worker that has a task due and is free. Never waits.
  onEachVideoFrame(
    video,
    (now, meta) => {
      if (meta?.captureTime) stage.capture.push(performance.now() - meta.captureTime)
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
    onText(text) {
      heardText = text
    },
    onWord(word, at) {
      const gap = word.gapAfterMs === null ? '' : `, pause ${Number.isFinite(word.gapAfterMs) ? `${Math.round(word.gapAfterMs)} ms` : 'end'}`
      const stage = word.partial ? 'partial' : `final ${word.confidence.toFixed(2)}, ${Math.round(word.latencyMs ?? 0)} ms${word.seenInPartial ? ', seen' : ''}${gap}`
      lastWord = `${word.word} (${stage})`
      console.log(`[speech] ${lastWord}`)
      const fired = dispatch({
        type: 'word',
        word: word.word,
        confidence: word.confidence,
        partial: word.partial,
        seenInPartial: word.seenInPartial,
        ...(word.gapAfterMs === null ? {} : { pauseAfterMs: word.gapAfterMs }),
        at
      })
      if (import.meta.env.DEV) wordLog.push(`${lastWord}${fired ? ' → FIRED' : ''}`)
      // The panel lists each spoken occurrence once: partials, plus finals no partial reported.
      if (word.partial || !word.seenInPartial) heard.push({ word: word.word, fired: fired > 0 })
      else if (fired) {
        const prev = heard.findLast((h) => h.word === word.word)
        if (prev) prev.fired = true
      }
      if (heard.length > 6) heard.shift()
    }
  })
    .then((s) => {
      speech = s
      if (config) s.setWords(config.words, config.speech.decoys ? decoysFor(config.words) : [])
      speechStatus = 'on'
      speechState = 'on'
    })
    .catch((err: unknown) => {
      speechStatus = 'FAILED'
      speechState = 'failed'
      speechError = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      console.error('[speech] failed to start', err)
    })

  if (import.meta.env.DEV) {
    // Dev-only hooks for scripts/perf-probe.mjs (CDP): trigger effects and measure GPU render cost without a camera subject.
    ;(window as unknown as { __skillcamDev: unknown }).__skillcamDev = {
      play: (name: string) => play([{ rule: -1, effects: [name] }], `dev ${name}`),
      /** A word event, as if Vosk heard it (partial). */
      say: (word: string) => dispatch({ type: 'word', word, confidence: 1, partial: true, at: performance.now() }),
      /**
       * Replaces the tracker's hands with a fixture hand for `ms` (real worker timing, stride, stabilizer,
       * triggers, effects and render), so gesture latency can be measured with nobody on camera.
       * `builtin` is a MediaPipe label (Thumb_Up, Closed_Fist, …) or a fixture pose name (rock, openPalm, …).
       */
      async fakeGesture(builtin: string, ms = 1500, side: 'Left' | 'Right' = 'Right'): Promise<string> {
        const { makeHand, POSES } = await import('./perception/__fixtures__/hands')
        const poses: Record<string, HandPose> = POSES
        const pose = poses[builtin] ?? POSES.fist
        // MediaPipe's handedness is the opposite of ours (correctHandedness swaps it back).
        const hand: TrackedHandResult = {
          landmarks: makeHand(pose, { wrist: { x: side === 'Right' ? 0.35 : 0.65, y: 0.8 } }),
          handedness: side === 'Right' ? 'Left' : 'Right',
          builtin: builtin in POSES ? null : { name: builtin, score: 0.9 }
        }
        fakeHands = [hand]
        await new Promise((r) => setTimeout(r, ms))
        fakeHands = []
        await new Promise((r) => setTimeout(r, 600))
        fakeHands = null
        return latency.describe()
      },
      /**
       * Feeds a recording (base64 16-bit PCM, 16 kHz mono, no header) into speech recognition instead of
       * the mic, silently, and returns every word event (and whether it fired a rule) it produced.
       */
      async feedSpeech(pcm16Base64: string, speed = 4): Promise<string[]> {
        if (!speech) throw new Error('speech not running')
        const bytes = Uint8Array.from(atob(pcm16Base64), (c) => c.charCodeAt(0))
        const pcm = new Int16Array(bytes.buffer, 0, bytes.length >> 1)
        const samples = Float32Array.from(pcm, (v) => v / 32768)
        wordLog.length = 0
        triggers.setRules(config?.rules ?? [], config?.defaultCooldownMs ?? 2000)
        // Rules fire as usual, but nothing may be heard while testing.
        if (config) audio.configure({ ...config.audio, muted: true })
        try {
          await speech.feed(samples, speed)
        } finally {
          if (config) audio.configure(config.audio)
        }
        return [...wordLog]
      },
      assetInfo: (path: string) => media.assetInfo(path),
      /** Mix → BlackHole reader latency, silently (see AudioEngine.measureCallLatency). */
      measureCallLatency: (runs?: number) => audio.measureCallLatency(runs),
      audio: () => ({ ...audio.status, context: audio.contextInfo, latency: audio.latency(), mixDb: audio.mixDb(), clap: clapFusion.stats, onsets: onsetCounts, lastOnset }),
      sendToCall: (on: boolean) => audio.setSendToCall(on),
      /** A synthetic clap into the clap detector worklet only (silent): exercises the real DSP path. */
      testClapSound: (amp?: number) => audio.injectTestClap(amp),
      /** A clap sound on the raw mic, as if the worklet heard one `agoMs` ago (pairs with a fake contact). */
      clapSound: (agoMs = 0) => {
        const at = performance.now() - agoMs
        onsetCounts.clap++
        const clap = clapFusion.sound(at, performance.now())
        if (clap) onFusedClap(clap)
        return clap !== null
      },
      latency: () => ({ last: latency.last, avg: latency.averages(), count: latency.count }),
      /**
       * Fixture hands for `ms`, moving in a slow circle when `move` is set: e.g.
       * [{ pose: 'openPalm', builtin: 'Open_Palm', side: 'Right', x: 0.3 }, { pose: 'pinch', side: 'Left', x: 0.7, move: true }].
       * "pinch" is an open palm with the thumb tip on the index tip.
       */
      async fakeHands(specs: { pose: string; builtin?: string; side: 'Left' | 'Right'; x: number; y?: number; move?: boolean }[], ms = 3000, dropEveryMs = 0): Promise<void> {
        const { makeHand, POSES } = await import('./perception/__fixtures__/hands')
        const poses: Record<string, HandPose> = POSES
        const t0 = performance.now()
        const build = (): void => {
          const t = (performance.now() - t0) / 1000
          // Simulated tracking dropouts: no hands for 70 ms every `dropEveryMs`.
          if (dropEveryMs && (t * 1000) % dropEveryMs < 70) {
            fakeHands = []
            return
          }
          fakeHands = specs.map((h) => {
            const wrist = { x: h.x + (h.move ? 0.12 * Math.cos(t * 2.5) : 0), y: (h.y ?? 0.8) + (h.move ? 0.12 * Math.sin(t * 2.5) : 0) }
            const landmarks = makeHand(poses[h.pose] ?? POSES.openPalm, { wrist, size: 0.2 })
            if (h.pose === 'pinch') landmarks[4] = { ...landmarks[8]! }
            return { landmarks, handedness: h.side === 'Right' ? 'Left' : 'Right', builtin: h.builtin ? { name: h.builtin, score: 0.9 } : null }
          })
        }
        build()
        const timer = setInterval(build, 16)
        await new Promise((r) => setTimeout(r, ms))
        clearInterval(timer)
        fakeHands = []
        await new Promise((r) => setTimeout(r, 600))
        fakeHands = null
      },
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
    clapFusion.expire(now)
    predicted = smoother.predict(cameraFrameAt)
    handPoints.length = 0
    for (const h of predicted) {
      const p = handPool[h.side]
      const lm = h.landmarks
      let x = 0
      let y = 0
      for (const i of PALM) {
        x += lm[i]!.x
        y += lm[i]!.y
      }
      x /= PALM.length
      p.palm.x = (view.mirror ? 1 - x : x) * view.width
      p.palm.y = (y / PALM.length) * view.height
      p.size = Math.hypot((lm[0]!.x - lm[9]!.x) * view.width, (lm[0]!.y - lm[9]!.y) * view.height)
      handPoints.push(p)
    }
    particles.update(Math.min(ticker.deltaMS, 100) / 1000)
    media.update(now, ticker, handPoints)
    lightPaint.update(now, pinchOf)
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
      else if (control.visible) {
        const face = faces.get(now)
        control.drawPreview(pixi.app.canvas, predicted, face)
        previewMs = performance.now() - now
        stage.preview.push(previewMs)
      }
    }
    const end = performance.now()
    latency.rendered(previewMs ? end - previewMs : end, stage.frame.value || 1000 / 60)
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
  /** dBFS → a 12-cell meter (−60…0 dB). */
  const meter = (db: number): string => {
    const n = Math.max(0, Math.min(12, Math.round(((db + 60) / 60) * 12)))
    return '█'.repeat(n).padEnd(12, '·')
  }
  const dbText = (db: number): string => (db <= -119 ? '  —  ' : `${db.toFixed(0).padStart(3)} dB`)
  const latencyText = (): string => {
    const l = audio.latency()
    return `latency: mic in ${l.micInput === null ? '?' : l.micInput.toFixed(0)} + audio ${l.base.toFixed(0)} + out ${l.output.toFixed(0)} ms`
  }
  const clapSoundLine = (): string => {
    const c = config?.clap
    const st = audio.status
    const need = c ? `needs rise ≥ ${c.minRiseDb} dB, peak ≥ ${c.minLevelDb} dB, bright ≥ ${c.minBrightness}, ≤ ${c.maxDurationMs} ms` : ''
    return `clap sound ${meter(st.brightDb)} ${dbText(st.brightDb)} (ref ${dbText(st.floorDb)}) · ${need}${c && !c.requireSound ? ' · SOUND NOT REQUIRED' : ''}`
  }
  const clapLastLine = (): string => {
    const f = clapFusion.stats
    const o = lastOnset
    const last = o
      ? `${o.onset.verdict === 'clap' ? 'CLAP' : `no (${o.onset.verdict})`} rise ${o.onset.riseDb.toFixed(0)} dB · peak ${o.onset.peakDb.toFixed(0)} dB · bright ${o.onset.brightness.toFixed(2)} · ${o.onset.durationMs.toFixed(0)} ms · ${((performance.now() - o.at) / 1000).toFixed(0)} s ago`
      : 'none yet'
    const offset = clapFusion.lastOffsetMs === null ? '' : ` · last sound ${clapFusion.lastOffsetMs >= 0 ? '+' : ''}${clapFusion.lastOffsetMs.toFixed(0)} ms vs contact`
    return `clap last sound: ${last} · sounds clap ${onsetCounts.clap}/quiet ${onsetCounts.quiet}/dull ${onsetCounts.dull}/long ${onsetCounts.long} · claps ${f.fused}, camera only ${f.contactOnly}, sound only ${f.soundOnly}${offset}`
  }
  let mixDb = -120
  /** Which rules can't show their files (missing in reactions/ or effects/clips/), by rule index. */
  const ruleProblems = new Map<number, string>()
  function filesIssue(): Issue | null {
    ruleProblems.clear()
    if (!config) return null
    const mediaProblems = media.problems()
    const clipMissing = new Set(clips.missing)
    const byEffect = new Map<string, string[]>()
    for (const [name, effect] of Object.entries(config.effects)) {
      const files = mediaProblems.get(name) ?? (effect.type === 'clip' && clipMissing.has(effect.file) ? [`effects/clips/${effect.file}`] : null)
      if (files) byEffect.set(name, files)
    }
    config.rules.forEach((rule, i) => {
      const missing = rule.play.flatMap((name) => byEffect.get(name) ?? [])
      if (missing.length) ruleProblems.set(i, `Missing ${missing.join(', ')}`)
    })
    if (byEffect.size === 0) return null
    return {
      level: 'warn',
      title: `${byEffect.size} effect${byEffect.size > 1 ? 's' : ''} can't find ${byEffect.size > 1 ? 'their' : 'its'} files`,
      detail: [...byEffect].map(([name, files]) => `${name}: ${files.join(', ')}`).join('\n') + '\nAdd the files (they load at once) or fix the paths in skillcam.config.json.'
    }
  }
  function panelState(now: number): PanelState {
    const issues: Issue[] = []
    if (configError) issues.push({ level: 'error', title: config ? 'skillcam.config.json is invalid: still using the last good version' : 'skillcam.config.json is invalid', detail: configError })
    if (cam.warning) issues.push({ level: 'warn', title: cam.warning })
    const files = filesIssue()
    if (files) issues.push(files)
    if (audio.status.mic.includes('CRASHED')) issues.push({ level: 'warn', title: 'The clap sound detector crashed: claps need the camera only until restart.' })
    const call = audio.status
    return {
      armed: triggers.armed,
      hotkey: appStatus?.hotkey ?? null,
      health: health({
        status: appStatus,
        camera: { state: cam.state, problem: cam.problem, label: cam.label, fps: cameraFps.fpsAt(now), sinceOkMs: cam.state === 'ok' ? now - cam.okAt : 0 },
        tracking: { started: trackersStarted, failed: trackerFailed, perSecond: trackFps.fpsAt(now), errors: trackErrors },
        speech: { state: speechState, error: speechError },
        call: { sendToCall: audio.sendingToCall, active: call.callActive, status: call.call, micError: call.mic.startsWith('FAILED') ? call.mic : null }
      }),
      issues,
      last: lastTrigger,
      gestures: labels
        .filter((h) => h.label || h.pinching)
        .map((h) => `${h.side}: ${h.pinching ? 'Pinch' : gestureName(h.label!)}`)
        .join(' · '),
      heard,
      heardText,
      ruleProblems,
      audio: {
        route: call.callActive ? `→ ${call.output.replace(/ \(Virtual\)$/, '')}` : audio.sendingToCall ? '' : `effects play on ${call.output}`,
        micDb: call.micDb,
        mixDb
      }
    }
  }
  function publishStats(): void {
    const now = performance.now()
    if (control?.visible) {
      mixDb = audio.mixDb()
      control.update(panelState(now), now)
    }
    if (control?.debugOpen) {
      const q = quality.settings
      control.setDebug([
        `render ${renderFps.fps.toFixed(0)} fps (cap ${q.maxRenderFps}) · camera ${cameraFps.fps.toFixed(0)} fps · tracked ${trackFps.fps.toFixed(0)}/s`,
        `quality L${quality.level}/${QUALITY_LEVELS.length - 1}: track every ${q.trackEvery} · particles ×${q.particleScale} · tracker ${trackerStatus}${trackErrors ? ` · ${trackErrors} errors` : ''}`,
        `gesture latency ${latency.describe()} (avg total ${latency.avg.total.value.toFixed(0)} ms over ${Math.min(latency.count, 20)})`,
        `stages ms  capture ${ms(stage.capture)} · grab ${ms(stage.grab)} · hands ${ms(stage.track)} · latency ${ms(stage.latency)} · gestures ${ms(stage.gestures)}`,
        `           effects ${ms(stage.effects)} · render ${ms(stage.render)} · preview ${ms(stage.preview)} · main/frame ${ms(stage.work)} · interval ${ms(stage.frame)}`,
        `worker ms  total/frame ${ms(stage.worker)} · prep ${ms(stage.prep)} · segment ${ms(stage.segment)} · face ${ms(stage.face)} · mask apply (CPU; GPU upload counts in render) ${ms(stage.mask)}`,
        `segment ${segmentation ? `every ${quality.strides.segment} · mask ${q.mask.width}×${q.mask.height} · age ${maskAge()} · cutout ${pixi.camera.person.visible ? 'ON' : 'idle'}` : 'off'} · face ${faceStatus()}`,
        `long tasks ${longTaskPerS.toFixed(0)} ms/s · worker busy skips ${pipes.map((p) => p.scheduler.busySkips).join('/')} · hand bursts ${burstCount} · particles ${particles.count} · media ${media.count} · painting ${lightPaint.active}`,
        `audio → ${audio.status.output} · call ${audio.status.call} · monitor ${audio.status.monitor}`,
        `mic ${meter(audio.status.micDb)} ${dbText(audio.status.micDb)} · mix ${meter(mixDb)} ${dbText(mixDb)} · ${audio.status.mic} · ${latencyText()}`,
        clapSoundLine(),
        clapLastLine(),
        `config ${configStatus} · ${triggers.armed ? 'ARMED' : 'disarmed'}`,
        `speech ${speechStatus} ${'█'.repeat(Math.round(micPeak * 12)).padEnd(12, '·')} decoding ${(speechDecodeShare * 100).toFixed(0)}% · last: ${lastWord}`,
        '',
        `control panel update ${ms(stage.panel)} ms every ${STATS_MS} ms (not per frame)`,
        '',
        ...recent.map((r, i) => `${i === 0 ? 'fired' : '     '} ${r}`)
      ])
    }
    if (control?.visible) stage.panel.push(performance.now() - now)
    if (import.meta.env.DEV) {
      // Text-only snapshot for dev tooling (CDP), so diagnostics never need a camera frame.
      ;(window as unknown as { __skillcam: unknown }).__skillcam = {
        perf: {
          renderFps: renderFps.fps,
          cameraFps: cameraFps.fps,
          trackFps: trackFps.fps,
          quality: quality.level,
          captureMs: stage.capture.value,
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
          panelUpdateMs: stage.panel.value,
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
        media: media.count,
        configStatus,
        speechStatus,
        lastWord,
        recent,
        armed: triggers.armed,
        panel: control?.visible ? panelState(now) : null
      }
    }
  }
}

main().catch((err: unknown) => console.error(`[output] fatal ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`))
