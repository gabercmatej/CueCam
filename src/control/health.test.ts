import { describe, expect, it } from 'vitest'
import type { AppStatus } from '../shared/api'
import { health, type HealthInput } from './health'

const status = (over: Partial<AppStatus> = {}): AppStatus => ({
  permissions: { camera: 'granted', microphone: 'granted' },
  missingAssets: [],
  hotkey: { accelerator: 'CommandOrControl+Shift+K', registered: true, error: null },
  folder: '/tmp/Skillcam',
  ...over
})

const good = (): HealthInput => ({
  status: status(),
  camera: { state: 'ok', problem: null, label: 'MacBook Air Camera', fps: 30, sinceOkMs: 10_000 },
  tracking: { started: true, failed: null, perSecond: 15, errors: 0 },
  speech: { state: 'on', error: null },
  call: { sendToCall: true, active: true, status: 'ON → BlackHole 2ch (Virtual)', micError: null }
})

describe('health', () => {
  it('is all OK for a working chain, with short summaries', () => {
    const h = health(good())
    expect([h.camera.level, h.tracking.level, h.speech.level, h.call.level]).toEqual(['ok', 'ok', 'ok', 'ok'])
    expect(h.camera.summary).toBe('30 fps')
    expect(h.tracking.summary).toBe('15/s')
    expect(h.call.summary).toBe('BlackHole 2ch')
  })

  it('passes the camera problem through, and tracking waits for the camera', () => {
    const input = good()
    input.camera = { state: 'error', problem: 'No camera found.', label: '', fps: 0, sinceOkMs: 0 }
    const h = health(input)
    expect(h.camera).toEqual({ level: 'error', summary: 'No picture', reason: 'No camera found.' })
    expect(h.tracking.level).toBe('wait')
  })

  it('names missing model files and how to get them', () => {
    const input = good()
    input.status = status({ missingAssets: ['mediapipe/gesture_recognizer.task', 'vosk/vosk-model-small-en-us-0.15.tar.gz'] })
    const h = health(input)
    expect(h.tracking.reason).toMatch(/assets\/mediapipe\/gesture_recognizer\.task.*fetch-assets/)
    expect(h.speech.reason).toMatch(/assets\/vosk\/.*fetch-assets/)
  })

  it('explains a denied microphone for speech and the call', () => {
    const input = good()
    input.status = status({ permissions: { camera: 'granted', microphone: 'denied' } })
    input.speech = { state: 'failed', error: 'NotAllowedError: Permission denied' }
    input.call = { sendToCall: true, active: false, status: 'no mic', micError: 'NotAllowedError: Permission denied' }
    const h = health(input)
    expect(h.speech.reason).toMatch(/Privacy & Security → Microphone/)
    expect(h.call.reason).toMatch(/Privacy & Security → Microphone/)
  })

  it('says BlackHole is missing, and is neutral when sending is off', () => {
    const input = good()
    input.call = { sendToCall: true, active: false, status: '"BlackHole" not found: effects play locally, no call audio', micError: null }
    expect(health(input).call).toMatchObject({ level: 'error', summary: 'BlackHole missing' })
    input.call.status = '"Nope" not found: effects play locally, no call audio'
    expect(health(input).call).toMatchObject({ summary: 'Nope missing', reason: expect.stringMatching(/named like "Nope"/) })
    input.call.sendToCall = false
    expect(health(input).call).toEqual({ level: 'off', summary: 'Off', reason: null })
  })

  it('flags a camera that stopped sending frames, but not right after opening', () => {
    const input = good()
    input.camera.fps = 0
    expect(health(input).camera.level).toBe('error')
    input.camera.sinceOkMs = 500
    expect(health(input).camera.level).toBe('ok')
  })
})
