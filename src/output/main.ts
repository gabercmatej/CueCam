import { openCamera } from './camera'
import { createStage } from './render/stage'
import { createHandTracker, type HandResult } from './perception/hands'
import { startSpeech } from './perception/speech'
import { FpsMeter, RollingAverage } from './debug/fpsMeter'
import { Hud } from './debug/hud'

// Phase 0 spike: camera → Pixi, gesture recognizer with landmark overlay, Vosk keyword log, FPS HUD.
const SPIKE_WORDS = ['boom', 'fire', 'bye']

// Surface CSP violations with their source so they are fixable, not just noisy.
document.addEventListener('securitypolicyviolation', (e) => {
  console.warn(`[csp] ${e.effectiveDirective} blocked ${e.blockedURI || 'inline'} at ${e.sourceFile}:${e.lineNumber}:${e.columnNumber}`)
})

async function main(): Promise<void> {
  const video = await openCamera()
  const { app, debug } = await createStage(video)
  const hud = new Hud(debug)

  const renderFps = new FpsMeter()
  const handFps = new FpsMeter()
  const handMs = new RollingAverage(30)
  let lastHands: HandResult | null = null
  let lastWord = 'listening…'
  let speechStatus = 'loading model…'
  let micPeak = 0
  let micChunks = 0

  const tracker = await createHandTracker()
  console.log('[hands] GestureRecognizer ready (GPU, VIDEO, 2 hands)')

  // Run the recognizer once per new camera frame, not per render frame.
  const onFrame = (now: number): void => {
    const t0 = performance.now()
    lastHands = tracker.recognizeForVideo(video, now)
    handMs.push(performance.now() - t0)
    handFps.tick(now)
    video.requestVideoFrameCallback(onFrame)
  }
  video.requestVideoFrameCallback(onFrame)

  app.ticker.add(() => {
    renderFps.tick(performance.now())
    hud.drawHands(lastHands)
    if (import.meta.env.DEV) {
      // Text-only snapshot for dev tooling (CDP), so diagnostics never need a camera frame.
      ;(window as unknown as { __skillcam: unknown }).__skillcam = {
        renderFps: +renderFps.fps.toFixed(1),
        handFps: +handFps.fps.toFixed(1),
        gestureMs: +handMs.value.toFixed(1),
        gestures: lastHands?.gestures.map((g) => `${g[0]?.categoryName}:${g[0]?.score.toFixed(2)}`) ?? [],
        speechStatus,
        micPeak: +micPeak.toFixed(3),
        micChunks,
        lastWord
      }
    }
    hud.setStats([
      `render ${renderFps.fps.toFixed(1)} fps   camera+hands ${handFps.fps.toFixed(1)} fps   gesture ${handMs.value.toFixed(1)} ms`,
      `speech ${speechStatus}   mic ${'█'.repeat(Math.round(micPeak * 20)).padEnd(20, '·')} (${micChunks} chunks)   last: ${lastWord}`
    ])
  })

  let partialAt = new Map<string, number>()
  startSpeech(SPIKE_WORDS, {
    onLevel(peak) {
      micPeak = Math.max(peak, micPeak * 0.8)
      micChunks++
    },
    onPartial(word, at) {
      partialAt.set(word, at)
      lastWord = `${word} (partial)`
      console.log(`[speech] partial "${word}"`)
    },
    onWord(hit) {
      const p = partialAt.get(hit.word)
      const lead = p === undefined ? '' : `, partial ${Math.round(performance.now() - p)} ms earlier`
      lastWord = `${hit.word} ${hit.confidence.toFixed(2)} · ${Math.round(hit.latencyMs)} ms`
      console.log(`[speech] word "${hit.word}" conf ${hit.confidence.toFixed(2)} latency ${Math.round(hit.latencyMs)} ms${lead}`)
      partialAt = new Map()
    }
  })
    .then(() => (speechStatus = 'on'))
    .catch((err: unknown) => {
      speechStatus = 'FAILED'
      console.error('[speech] failed to start', err)
    })
}

main().catch((err: unknown) => console.error('[output] fatal', err))
