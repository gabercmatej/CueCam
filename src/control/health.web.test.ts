import { describe, expect, it } from 'vitest'
import { health, type HealthInput } from './health'

const base: HealthInput = {
  status: { permissions: { camera: 'unknown', microphone: 'unknown' }, missingAssets: [], hotkey: { accelerator: 'K', registered: true, error: null }, folder: '', browser: true },
  camera: { state: 'ok', problem: null, label: 'cam', fps: 30, sinceOkMs: 5000 },
  tracking: { started: true, failed: null, perSecond: 15, errors: 0 },
  speech: { state: 'off', error: null },
  call: { sendToCall: false, active: false, status: 'off', micError: null }
}

describe('health in the web demo', () => {
  it('shows speech as off until voice is enabled', () => {
    expect(health(base).speech).toEqual({ level: 'off', summary: 'Off', reason: null })
  })

  it('explains a blocked mic in browser terms', () => {
    const h = health({ ...base, speech: { state: 'failed', error: 'NotAllowedError: Permission denied' } })
    expect(h.speech.level).toBe('error')
    expect(h.speech.reason).toMatch(/address bar/)
    expect(h.speech.reason).not.toMatch(/System Settings/)
  })
})
