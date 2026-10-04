import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseConfig } from '../shared/config'

describe('skillcam.config.json', () => {
  it('is valid', () => {
    const r = parseConfig(readFileSync(new URL('../../skillcam.config.json', import.meta.url), 'utf8'))
    expect(r.ok ? 'ok' : r.error).toBe('ok')
  })
})
