import { describe, expect, it } from 'vitest'
import type { Config } from '../shared/config'
import { ConfigState } from './configState'

const good = { rules: [] } as unknown as Config

describe('ConfigState (review fix: keep the last good config in main)', () => {
  it('serves the last good config after an invalid save, plus the error', () => {
    const s = new ConfigState()
    s.update({ ok: true, config: good })
    s.update({ ok: false, error: 'bad' })
    expect(s.current).toEqual({ ok: true, config: good, error: 'bad' })
  })

  it('clears the error once a good config is saved again', () => {
    const s = new ConfigState()
    s.update({ ok: false, error: 'bad' })
    expect(s.current).toEqual({ ok: false, error: 'bad' })
    s.update({ ok: true, config: good })
    expect(s.current).toEqual({ ok: true, config: good })
  })
})
