import { describe, expect, it } from 'vitest'
import { createOverlayControl, OVERLAY_DEFAULTS } from './overlays'

const memory = (initial: Record<string, string> = {}) => {
  const data = { ...initial }
  return { data, store: { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => void (data[k] = v) } }
}

describe('overlay switches', () => {
  it('start from the defaults: skeleton on, the rest off', () => {
    expect(createOverlayControl(() => memory().store).state).toEqual(OVERLAY_DEFAULTS)
    expect(OVERLAY_DEFAULTS).toEqual({ hands: true, mask: false, face: false, stats: false })
  })

  it('remember choices and notify listeners', () => {
    const m = memory()
    const c = createOverlayControl(() => m.store)
    let calls = 0
    c.onChange(() => calls++)
    c.set('mask', true)
    c.set('mask', true)
    expect(calls).toBe(1)
    expect(createOverlayControl(() => m.store).state.mask).toBe(true)
  })

  it('ignore corrupt or partial saved data', () => {
    const c = createOverlayControl(() => memory({ 'skillcam.web.overlays': '{"face":true,"hands":"yes","x":1}' }).store)
    expect(c.state).toEqual({ ...OVERLAY_DEFAULTS, face: true })
    expect(createOverlayControl(() => memory({ 'skillcam.web.overlays': 'not json' }).store).state).toEqual(OVERLAY_DEFAULTS)
  })

  it('keep working when storage throws or is missing', () => {
    const throwing = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    const c = createOverlayControl(() => throwing)
    c.set('stats', true)
    expect(c.state.stats).toBe(true)
    expect(createOverlayControl(() => null).state).toEqual(OVERLAY_DEFAULTS)
  })
})
