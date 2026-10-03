import { describe, expect, it } from 'vitest'
import { parseConfig } from './config'

const valid = {
  hotkey: 'CommandOrControl+Shift+K',
  defaultCooldownMs: 2000,
  words: ['fire', 'boom', "let's go"],
  rules: [
    { when: { gesture: 'ThumbUp' }, play: 'confetti_hand' },
    { when: { word: 'boom' }, play: ['explosion_clip', 'shake'], cooldownMs: 4000 },
    { when: { word: 'fire', gesture: 'PalmPush', withinMs: 1500 }, play: 'shake' }
  ],
  effects: {
    explosion_clip: { type: 'clip', file: 'explosion.webm', layer: 'back', anchor: 'bottom-left', scale: 0.6 },
    shake: { type: 'cameraMove', kind: 'shake', intensity: 0.8, durationMs: 600 },
    confetti_hand: { type: 'particles', preset: 'confetti', anchor: 'hand', count: 120 }
  }
}

const parse = (v: unknown) => parseConfig(JSON.stringify(v))

describe('parseConfig', () => {
  it('accepts the BUILD_PLAN §6 shape (with our gesture names) and fills defaults', () => {
    const r = parse(valid)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.config.rules[0]!.play).toEqual(['confetti_hand'])
    expect(r.config.effects['shake']).toMatchObject({ kind: 'shake', intensity: 0.8 })
  })

  it('reports invalid JSON with a readable message', () => {
    const r = parseConfig('{ "words": [ }')
    expect(r).toMatchObject({ ok: false })
    if (!r.ok) expect(r.error).toMatch(/JSON/)
  })

  it('rejects raw MediaPipe labels and unknown gestures', () => {
    const r = parse({ ...valid, rules: [{ when: { gesture: 'Thumb_Up' }, play: 'shake' }] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/gesture/)
  })

  it('rejects a rule that plays an undefined effect', () => {
    const r = parse({ ...valid, rules: [{ when: { word: 'boom' }, play: 'nope' }] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/nope/)
  })

  it('rejects a rule word missing from the words list', () => {
    const r = parse({ ...valid, rules: [{ when: { word: 'kaboom' }, play: 'shake' }] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/kaboom/)
  })

  it('rejects an empty trigger', () => {
    expect(parse({ ...valid, rules: [{ when: {}, play: 'shake' }] }).ok).toBe(false)
  })

  it('rejects clip paths that try to leave effects/clips', () => {
    const effects = { ...valid.effects, explosion_clip: { type: 'clip', file: '../../secret.webm' } }
    expect(parse({ ...valid, effects }).ok).toBe(false)
  })

  it('defaults combo withinMs to 1500', () => {
    const r = parse({ ...valid, rules: [{ when: { word: 'fire', gesture: 'PalmPush' }, play: 'shake' }] })
    expect(r.ok && r.config.rules[0]!.when.withinMs).toBe(1500)
  })
})
