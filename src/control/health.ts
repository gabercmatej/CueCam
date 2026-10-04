/**
 * The Control window's health strip: each link of the chain (camera → tracking, mic → speech, mix →
 * call) as a level, a short summary, and, when it isn't OK, a reason that says what to do. Pure.
 */
import type { AppStatus } from '../shared/api'

/** ok: working · wait: starting or waiting on another link · off: switched off · warn: degraded · error: broken. */
export type Level = 'ok' | 'wait' | 'off' | 'warn' | 'error'

export interface Link {
  level: Level
  summary: string
  reason: string | null
}

export interface HealthInput {
  status: AppStatus | null
  camera: { state: 'opening' | 'ok' | 'error'; problem: string | null; label: string; fps: number; sinceOkMs: number }
  /** started: every worker loaded; failed: why one didn't (or crashed). */
  tracking: { started: boolean; failed: string | null; perSecond: number; errors: number }
  speech: { state: 'loading' | 'on' | 'failed'; error: string | null }
  call: { sendToCall: boolean; active: boolean; status: string; micError: string | null }
}

export interface Health {
  camera: Link
  tracking: Link
  speech: Link
  call: Link
}

const FETCH = 'Run npm run fetch-assets, then restart Skillcam.'
const ok = (summary: string): Link => ({ level: 'ok', summary, reason: null })

const missing = (status: AppStatus | null, prefix: string): string[] => (status?.missingAssets ?? []).filter((f) => f.startsWith(prefix))

/** Why the mic can't be used, from macOS's permission and the error getUserMedia gave. */
function micProblem(input: HealthInput, error: string | null): string | null {
  const perm = input.status?.permissions.microphone
  if (perm === 'denied' || perm === 'restricted' || (error && /NotAllowed|Permission|denied/i.test(error))) {
    return 'Microphone access is blocked. Allow it in System Settings → Privacy & Security → Microphone (in dev: Electron), then restart Skillcam.'
  }
  if (error && /NotFound|Requested device not found/i.test(error)) return 'No microphone found. Connect one, then restart Skillcam.'
  return null
}

export function health(input: HealthInput): Health {
  return { camera: camera(input), tracking: tracking(input), speech: speech(input), call: call(input) }
}

function camera({ camera: c }: HealthInput): Link {
  if (c.state === 'error') return { level: 'error', summary: 'No picture', reason: c.problem }
  if (c.state === 'opening') return { level: 'wait', summary: 'Opening…', reason: null }
  // Frames stopped although the track is live (the first seconds after opening don't count).
  if (c.fps < 1 && c.sinceOkMs > 3000) return { level: 'error', summary: 'No frames', reason: `"${c.label}" is open but sends no frames. Another app may have taken it.` }
  if (c.fps > 0 && c.fps < 20 && c.sinceOkMs > 3000) {
    return { level: 'warn', summary: `${c.fps.toFixed(0)} fps`, reason: `The camera runs at ${c.fps.toFixed(0)} fps (expected 30). Low light makes macOS cameras slow down.` }
  }
  return ok(`${c.fps.toFixed(0)} fps`)
}

function tracking(input: HealthInput): Link {
  const t = input.tracking
  const files = missing(input.status, 'mediapipe/')
  if (files.length) return { level: 'error', summary: 'Models missing', reason: `Missing assets/${files.join(', assets/')}. ${FETCH}` }
  if (t.failed) return { level: 'error', summary: 'Failed', reason: `Hand tracking failed: ${t.failed}` }
  if (input.camera.state !== 'ok') return { level: 'wait', summary: 'Waiting for camera', reason: null }
  if (!t.started) return { level: 'wait', summary: 'Loading…', reason: null }
  if (t.perSecond < 1 && input.camera.fps >= 1 && input.camera.sinceOkMs > 3000) {
    return { level: 'error', summary: 'Stalled', reason: `No tracking results for a while${t.errors ? ` (${t.errors} errors, see the terminal)` : ''}.` }
  }
  return ok(`${t.perSecond.toFixed(0)}/s`)
}

function speech(input: HealthInput): Link {
  const s = input.speech
  const files = missing(input.status, 'vosk/')
  if (files.length) return { level: 'error', summary: 'Model missing', reason: `Missing assets/${files.join(', assets/')}. ${FETCH}` }
  if (s.state === 'failed') {
    return { level: 'error', summary: 'Off', reason: micProblem(input, s.error) ?? `Speech recognition failed to start: ${s.error ?? 'unknown error'}.` }
  }
  if (s.state === 'loading') return { level: 'wait', summary: 'Loading…', reason: null }
  return ok('Listening')
}

function call(input: HealthInput): Link {
  const c = input.call
  if (!c.sendToCall) return { level: 'off', summary: 'Off', reason: null }
  const mic = micProblem(input, c.micError)
  if (mic) return { level: 'error', summary: 'No mic', reason: mic }
  if (c.active) return ok(c.status.replace(/^ON → /, '').replace(/ \(Virtual\)$/, ''))
  const notFound = /^"(.+)" not found/.exec(c.status)
  if (notFound) {
    const name = notFound[1]!
    return {
      level: 'error',
      summary: `${name} missing`,
      reason: /blackhole/i.test(name)
        ? 'BlackHole isn\'t installed or running, so the call hears no effect sounds (they play on your own output). Install BlackHole 2ch, see docs/audio-setup.md.'
        : `No audio output named like "${name}" (audio.call.device), so the call hears no effect sounds (they play on your own output).`
    }
  }
  if (/no mic/.test(c.status)) return { level: 'error', summary: 'No mic', reason: 'The microphone for the call mix didn\'t start.' }
  if (/unavailable|failed/i.test(c.status)) return { level: 'error', summary: 'Unavailable', reason: c.status }
  return { level: 'wait', summary: 'Connecting…', reason: null }
}
