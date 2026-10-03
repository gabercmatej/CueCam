import type { Config, ConfigResult } from '../shared/config'
import type { EffectContext, TriggerEvent } from '../shared/types'
import { openCamera } from './camera'
import { FpsMeter, RollingAverage } from './debug/fpsMeter'
import { Hud } from './debug/hud'
import { CameraMoves } from './effects/cameraMove'
import { ClipEngine } from './effects/clip'
import { ParticleEngine } from './effects/particles'
import { EffectRegistry } from './effects/registry'
import { TriggerEngine } from './engine/triggers'
import { onEachVideoFrame } from './perception/frameLoop'
import { GestureTracker, type HandState, type RawHand } from './perception/gestures'
import { createHandTracker } from './perception/hands'
import { SpeechInput } from './perception/speech'
import { createStage } from './render/stage'
import { correctHandedness, OUTPUT_VIEW } from './view'

// Surface CSP violations with their source so they are fixable, not just noisy.
document.addEventListener('securitypolicyviolation', (e) => {
  console.warn(`[csp] ${e.effectiveDirective} blocked ${e.blockedURI || 'inline'} at ${e.sourceFile}:${e.lineNumber}:${e.columnNumber}`)
})

const view = OUTPUT_VIEW

async function main(): Promise<void> {
  const video = await openCamera()
  const stage = await createStage(video, view)
  const hud = new Hud(stage.debug)

  // Effects
  const particles = new ParticleEngine(stage.front, stage.app.renderer, view.width, view.height, view.mirror)
  const camera = new CameraMoves(stage.scene, view.width, view.height)
  const clips = new ClipEngine({ back: stage.back, front: stage.front }, view.width, view.height, view.mirror, (cfg, ctx) => {
    // Missing clip file: a spark burst at the same spot so the trigger still reads.
    particles.play({ type: 'particles', preset: 'sparks', anchor: cfg.anchor, count: 220 }, ctx)
  })
  const registry = new EffectRegistry({ particles, clips, camera })
  const triggers = new TriggerEngine()

  // Debug state
  const renderFps = new FpsMeter()
  const handFps = new FpsMeter()
  const handMs = new RollingAverage(30)
  let hands: HandState[] = []
  let configStatus = 'loading…'
  let speechStatus = 'loading model…'
  let micPeak = 0
  let lastWord = '—'
  const recent: string[] = []
  const log = (line: string): void => {
    recent.unshift(line)
    recent.length = Math.min(recent.length, 3)
    console.log(`[trigger] ${line}`)
  }

  function dispatch(event: TriggerEvent): void {
    for (const firing of triggers.handle(event)) {
      const ctx: EffectContext = { position: firing.position, hands: hands.map((h) => h.palm) }
      for (const name of firing.effects) registry.play(name, ctx, performance.now())
      const what = event.type === 'gesture' ? event.gesture : `"${event.word}"`
      log(`${what} → ${firing.effects.join(' + ')}`)
    }
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
    }
    configStatus = result.error
      ? `ERROR (keeping last good): ${result.error.split('\n').slice(0, 2).join(' ')}`
      : `ok · ${config.rules.length} rules · ${Object.keys(config.effects).length} effects`
  }
  window.skillcam.onConfig(applyConfig)
  applyConfig(await window.skillcam.getConfig())

  // Hands → gestures → triggers, once per new camera frame.
  const tracker = await createHandTracker()
  const gestures = new GestureTracker(view)
  console.log('[hands] GestureRecognizer ready (GPU, VIDEO, 2 hands)')
  onEachVideoFrame(
    video,
    (now) => {
      const t0 = performance.now()
      const result = tracker.recognizeForVideo(video, now)
      handMs.push(performance.now() - t0)
      handFps.tick(now)
      const raw: RawHand[] = result.landmarks.map((landmarks, i) => {
        const top = result.gestures[i]?.[0]
        return {
          landmarks,
          side: correctHandedness(result.handedness[i]?.[0]?.categoryName ?? 'Right'),
          builtin: top ? { name: top.categoryName, score: top.score } : null
        }
      })
      const update = gestures.update(raw, now)
      hands = update.hands
      update.events.forEach(dispatch)
    },
    (err) => console.error('[hands] recognize failed', err)
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

  stage.app.ticker.add((ticker) => {
    const now = performance.now()
    renderFps.tick(now)
    particles.update(Math.min(ticker.deltaMS, 100) / 1000)
    camera.update(now)
    hud.drawHands(hands)
    hud.setStats([
      `render ${renderFps.fps.toFixed(0)} fps · hands ${handFps.fps.toFixed(0)} fps · gesture ${handMs.value.toFixed(1)} ms · particles ${particles.count}`,
      `config ${configStatus} · ${triggers.armed ? 'ARMED' : 'disarmed'}`,
      `speech ${speechStatus} ${'█'.repeat(Math.round(micPeak * 12)).padEnd(12, '·')} last: ${lastWord}`,
      ...recent.map((r, i) => `${i === 0 ? 'fired' : '     '} ${r}`)
    ])
    if (import.meta.env.DEV) {
      // Text-only snapshot for dev tooling (CDP), so diagnostics never need a camera frame.
      ;(window as unknown as { __skillcam: unknown }).__skillcam = {
        renderFps: +renderFps.fps.toFixed(1),
        handFps: +handFps.fps.toFixed(1),
        gestureMs: +handMs.value.toFixed(1),
        hands: hands.map((h) => `${h.side}:${h.label}`),
        particles: particles.count,
        configStatus,
        speechStatus,
        lastWord,
        recent
      }
    }
  })
}

main().catch((err: unknown) => console.error(`[output] fatal ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`))
