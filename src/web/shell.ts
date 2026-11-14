/**
 * The web demo's page: checks the browser, asks for the camera on a click, downloads the tracking
 * models with progress, then starts the same Output page the Electron app runs (src/output/main.ts)
 * on the web adapter (platform.ts). Voice (mic + a 41 MB speech model) loads only when asked for.
 */
import type { LiveStats, OverlayName } from '../shared/api'
import { OUTPUT_VIEW } from '../output/view'
import { downloadAll, megabytes, type SizedFile } from './loader'
import { installWebPlatform, type WebPlatform } from './platform'

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T
const base = new URL('./', document.baseURI).href
/** A model download slower than this gets a "still loading" note. */
const SLOW_MS = 15_000
/** Models are in but no tracking result after this long: say why instead of "Starting…" forever. */
const STUCK_MS = 20_000

interface AssetSizes {
  models: SizedFile[]
  voice: SizedFile[]
}

// ── Browser support ────────────────────────────────────────────────────────────

type NavigatorUA = Navigator & { userAgentData?: { brands: { brand: string }[]; mobile: boolean } }

function unsupportedReason(): string | null {
  // First: on plain http even Chrome hides userAgentData, and the camera is unavailable anyway.
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return 'The camera is only available on a secure page. Open the demo over https (or on localhost).'
  const ua = (navigator as NavigatorUA).userAgentData
  const chromium = ua?.brands.some((b) => /Chromium|Google Chrome|Microsoft Edge/.test(b.brand)) ?? false
  if (!chromium) return 'This demo needs Chrome or Edge (or another Chromium browser) on a laptop or desktop. Safari and Firefox don’t yet support what it uses (video frames sent to a worker, WebGL inside a worker).'
  if (ua?.mobile) return 'This demo is made for a laptop or desktop: hand tracking, segmentation and effects at 30+ fps need more than most phones have. Open it on a computer with Chrome or Edge.'
  if (typeof VideoFrame === 'undefined' || typeof OffscreenCanvas === 'undefined' || !document.createElement('canvas').getContext('webgl2')) {
    return 'This browser lacks WebGL 2 or WebCodecs video frames. Update Chrome or Edge, or turn on hardware acceleration in its settings.'
  }
  return null
}

// ── Screens ────────────────────────────────────────────────────────────────────

function showCard(id: 'start-card' | 'load-card' | 'error-card' | null): void {
  for (const card of ['start-card', 'load-card', 'error-card']) $(card).hidden = card !== id
  $('overlay').hidden = id === null
}

function showError(title: string, text: string, retry?: () => void): void {
  $('error-title').textContent = title
  $('error-text').textContent = text
  const button = $<HTMLButtonElement>('retry')
  button.textContent = 'Try again'
  button.hidden = !retry
  button.onclick = retry ?? null
  showCard('error-card')
}

function step(id: string, state: 'active' | 'done' | 'failed', text?: string): void {
  const li = $(id)
  li.classList.remove('active', 'done', 'failed')
  li.classList.add(state)
  if (text !== undefined) li.querySelector('.state')!.textContent = text
}

const setBar = (id: string, share: number): void => {
  $(id).style.transform = `scaleX(${Math.max(0, Math.min(1, share)).toFixed(3)})`
}

function cameraMessage(err: unknown): [string, string] {
  const name = err instanceof DOMException ? err.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return ['Camera access is blocked', 'Allow the camera with the icon at the left of the address bar, then try again. Nothing is recorded or uploaded: the video stays in this tab.']
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return ['No camera found', 'Connect a camera, then try again.']
  if (name === 'NotReadableError' || name === 'AbortError') return ['The camera is busy', 'Another app or tab may be using it. Close it, then try again.']
  return ['The camera didn’t start', `${name || 'Error'}: ${err instanceof Error ? err.message : String(err)}`]
}

// ── Start ──────────────────────────────────────────────────────────────────────

let sizes: Promise<AssetSizes> | null = null
const loadSizes = (): Promise<AssetSizes> =>
  (sizes ??= fetch(new URL('asset-sizes.json', base)).then((r) => {
    if (!r.ok) throw new Error(`asset-sizes.json: HTTP ${r.status}`)
    return r.json() as Promise<AssetSizes>
  }))

let platform: WebPlatform | null = null
let trackingSeen = false

async function start(): Promise<void> {
  showCard('load-card')
  step('step-camera', 'active', 'Waiting for permission…')

  // Ask for the camera first (the prompt shows while the models download). The Output page opens it
  // again with its own settings; a granted permission doesn't ask twice.
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ video: true })
    probe.getTracks().forEach((t) => t.stop())
    step('step-camera', 'done', 'On')
  } catch (err) {
    step('step-camera', 'failed', 'Blocked')
    const [title, text] = cameraMessage(err)
    showError(title, text, () => void start())
    return
  }

  // Models: progress here; the worker reads them from the cache afterwards.
  step('step-models', 'active')
  const began = performance.now()
  const slow = setInterval(() => {
    if (performance.now() - began > SLOW_MS) $('slow-note').hidden = false
  }, 1000)
  const modelsReady = loadSizes()
    .then((s) =>
      downloadAll(s.models, base, (loaded, total) => {
        setBar('models-bar', loaded / total)
        $('models-state').textContent = `${megabytes(loaded)} / ${megabytes(total)} MB`
        $('slow-note').textContent = `Still loading: ${megabytes(loaded)} of ${megabytes(total)} MB. A slow connection takes a while the first time; the next visit loads from the cache.`
      })
    )
    .then(
      () => {
        step('step-models', 'done')
        step('step-tracker', 'active', 'Starting…')
      },
      (err: unknown) => {
        step('step-models', 'failed', 'Failed')
        showError('The models didn’t download', `${err instanceof Error ? err.message : String(err)}. Check the connection, then reload the page.`)
        throw err
      }
    )
    .finally(() => {
      clearInterval(slow)
      $('slow-note').hidden = true
    })

  $('panel-placeholder').remove()
  platform = installWebPlatform({
    stage: $('stage'),
    panel: $('panel'),
    modelsReady,
    onStats,
    onFatal: (message) => showError('CueCam couldn’t start', `${message}. Hardware acceleration may be off in the browser settings; turn it on and reload.`)
  })
  watchStartup(modelsReady)
  // On the web Skillcam is a mirror: you see yourself the way you move (effects flip with it).
  OUTPUT_VIEW.mirror = true
  await import('../output/main')
}

function onStats(s: LiveStats): void {
  // The latest numbers, for anyone curious in the console (and for measuring the demo).
  ;(window as unknown as { skillcamStats: LiveStats }).skillcamStats = s
  // The Stats overlay (S): a small corner panel over the stage.
  $('hud').hidden = !platform?.overlays.state.stats
  if (!$('hud').hidden) {
    $('hud-fps').textContent = `${s.renderFps.toFixed(0)} fps`
    $('hud-latency').textContent = s.gestureLatencyMs > 0 ? `gesture → effect ${s.gestureLatencyMs.toFixed(0)} ms` : 'gesture → effect —'
    $('hud-quality').textContent = `quality L${s.quality}`
  }
  if (!trackingSeen && s.trackFps > 0) {
    trackingSeen = true
    step('step-tracker', 'done', 'Running')
    showCard(null)
    const voice = $<HTMLButtonElement>('voice-btn')
    voice.disabled = false
  }
}

/**
 * Until tracking runs, watch for the reasons it might not: an error in the panel (camera busy, tracker
 * failed, no frames) held for a few seconds, or no result long after the models arrived. Then the
 * loading card turns into an error card with the panel's explanation.
 */
function watchStartup(modelsReady: Promise<void>): void {
  let modelsAt = Infinity
  modelsReady.then(() => (modelsAt = performance.now()), () => {})
  let errorSince = Infinity
  const timer = setInterval(() => {
    if (trackingSeen || !$('error-card').hidden) return clearInterval(timer)
    const issue = document.querySelector('#panel .issues li:not(.warn)')
    const now = performance.now()
    errorSince = issue ? Math.min(errorSince, now) : Infinity
    if (now - errorSince > 3000 || now - modelsAt > STUCK_MS) {
      clearInterval(timer)
      const text = issue?.textContent?.trim() || 'No hand tracking results arrived. The graphics driver may be busy or blocked: close other heavy tabs, check that hardware acceleration is on, and reload.'
      showError('CueCam couldn’t start tracking', text, () => location.reload())
      $<HTMLButtonElement>('retry').textContent = 'Reload'
    }
  }, 1000)
}

// ── Voice ──────────────────────────────────────────────────────────────────────

async function enableVoice(): Promise<void> {
  const button = $<HTMLButtonElement>('voice-btn')
  const box = $('voice')
  const state = $('voice-state')
  if (!platform) return
  button.disabled = true
  box.classList.remove('failed')
  state.textContent = 'Waiting for microphone permission…'
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
    probe.getTracks().forEach((t) => t.stop())
  } catch (err) {
    box.classList.add('failed')
    const blocked = err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError')
    state.textContent = blocked
      ? 'Microphone access is blocked. Allow it with the icon at the left of the address bar, then click again.'
      : `The microphone didn’t start (${err instanceof Error ? err.message : String(err)}).`
    button.disabled = false
    return
  }
  try {
    $('voice-track').hidden = false
    const s = await loadSizes()
    await downloadAll(s.voice, base, (loaded, total) => {
      setBar('voice-bar', loaded / total)
      state.textContent = `Downloading the speech model: ${megabytes(loaded)} / ${megabytes(total)} MB`
    })
    state.textContent = 'Starting speech recognition…'
    const { clap } = await platform.startVoice()
    $('voice-track').hidden = true
    box.classList.add('on')
    if (clap) {
      state.textContent = 'Listening. Say “boom”, “let’s go”, “I love you” or “bye”, or clap. Fire: open palm + “fire”.'
      button.textContent = 'Voice on'
    } else {
      state.textContent = 'Listening for words. Clap is unavailable: its sound detector didn’t start. Click to try again.'
      button.textContent = 'Retry clap'
      button.disabled = false
    }
  } catch (err) {
    box.classList.add('failed')
    state.textContent = `Voice didn’t start: ${err instanceof Error ? err.message : String(err)}`
    button.disabled = false
  }
}

// ── Wiring ─────────────────────────────────────────────────────────────────────

const reason = unsupportedReason()
if (reason) {
  showError('Not supported in this browser', reason)
  $('voice-btn').hidden = true
} else {
  $('start').addEventListener('click', () => void start(), { once: true })
}
$('voice-btn').addEventListener('click', () => void enableVoice())
// K arms and disarms, like ⇧⌘K in the app; H, M, F, S switch the overlays (not while typing or with modifiers).
const OVERLAY_KEYS: Record<string, OverlayName> = { h: 'hands', m: 'mask', f: 'face', s: 'stats' }
document.addEventListener('keydown', (e) => {
  if (!platform || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
  if (e.target instanceof HTMLInputElement && e.target.type !== 'checkbox') return
  if (e.target instanceof HTMLTextAreaElement) return
  const key = e.key.toLowerCase()
  if (key === 'k') platform.toggleArmed()
  const overlay = OVERLAY_KEYS[key]
  if (overlay) platform.overlays.set(overlay, !platform.overlays.state[overlay])
})
