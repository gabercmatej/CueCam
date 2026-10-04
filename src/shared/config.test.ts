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

  it('defaults the performance section and validates it', () => {
    const r = parse(valid)
    expect(r.ok && r.config.performance).toEqual({
      trackEvery: 2,
      adaptive: true,
      trackerDelegate: 'GPU',
      segmentation: true,
      segmentEvery: 2,
      segmentDelegate: 'GPU',
      faceDetection: true,
      perceptionWorkers: 1
    })
    expect(parse({ ...valid, performance: { trackEvery: 1 } })).toMatchObject({ ok: true, config: { performance: { trackEvery: 1, adaptive: true, trackerDelegate: 'GPU' } } })
    expect(parse({ ...valid, performance: { perceptionWorkers: 3 } }).ok).toBe(false)
    expect(parse({ ...valid, performance: { trackEvery: 9 } }).ok).toBe(false)
  })

  it('rejects combo windows over 10 s', () => {
    const rules = [{ when: { word: 'fire', gesture: 'PalmPush', withinMs: 10_001 }, play: 'shake' }]
    expect(parse({ ...valid, rules }).ok).toBe(false)
  })

  it('defaults the video section to 1080p and the first real camera', () => {
    const r = parse(valid)
    expect(r.ok && r.config.video).toEqual({ outputHeight: 1080 })
    expect(parse({ ...valid, video: { outputHeight: 900 } }).ok).toBe(false)
  })

  it('accepts chroma-key and grade settings and validates colours', () => {
    const effects = {
      ...valid.effects,
      green: { type: 'clip', file: 'boom.mp4', keyColor: '#00ff00' },
      noway: { type: 'cameraMove', kind: 'grade', saturation: 0, vignette: 0.7, durationMs: 1500 },
      zoomFace: { type: 'cameraMove', kind: 'zoom', target: 'face' }
    }
    const r = parse({ ...valid, effects })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.config.effects['green']).toMatchObject({ keyColor: '#00ff00', similarity: 0.4, smoothness: 0.08, spill: 0.6 })
    expect(r.config.effects['noway']).toMatchObject({ kind: 'grade', saturation: 0, tintAmount: 0, vignette: 0.7, fadeMs: 250 })
    expect(parse({ ...valid, effects: { ...effects, green: { type: 'clip', file: 'a.mp4', keyColor: 'green' } } }).ok).toBe(false)
  })

  it('accepts the face anchor', () => {
    const effects = { ...valid.effects, f: { type: 'particles', preset: 'sparks', anchor: 'face' } }
    expect(parse({ ...valid, effects }).ok).toBe(true)
  })
})

describe('Phase 3b config', () => {
  const withEffects = (effects: Record<string, unknown>, rules: unknown[] = []) => parse({ ...valid, rules: [...valid.rules, ...rules], effects: { ...valid.effects, ...effects } })

  it('media effects default to a front-layer corner card with sound on, the key auto-detected', () => {
    const r = withEffects({ thumbs: { type: 'media', files: 'thumbs up' } })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const e = r.config.effects['thumbs']
    expect(e).toMatchObject({ files: ['thumbs up'], placement: 'corner', corner: 'auto', layer: 'front', volume: 1, muted: false, follow: false, fadeMs: 250 })
    expect((e as { key?: boolean }).key).toBeUndefined()
    expect((e as { similarity?: number }).similarity).toBeUndefined()
  })

  it('rejects media paths that leave reactions/', () => {
    expect(withEffects({ x: { type: 'media', files: '../secrets.png' } }).ok).toBe(false)
    expect(withEffects({ x: { type: 'media', files: ['/etc/passwd'] } }).ok).toBe(false)
    expect(withEffects({ x: { type: 'sound', files: 'rock/../../x.mp3' } }).ok).toBe(false)
  })

  it('accepts sound, light painting, audio settings, per-hand rules and the new gestures', () => {
    const r = parse({
      ...valid,
      audio: { volume: 0.8, device: 'BlackHole' },
      rules: [
        { when: { gesture: 'Fist' }, play: 'confetti_hand', perHand: true },
        { when: { gesture: 'Pinch' }, play: 'paint' },
        { when: { gesture: 'Clap' }, play: 'yeah' },
        { when: { gesture: 'Pray' }, play: 'yeah' },
        { when: { gesture: 'BothHandsUp' }, play: 'yeah' }
      ],
      effects: { ...valid.effects, paint: { type: 'lightPaint' }, yeah: { type: 'sound', files: 'rock', volume: 0.7 } }
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.config.audio).toEqual({ volume: 0.8, muted: false, device: 'BlackHole' })
    expect(r.config.rules[0]!.perHand).toBe(true)
    expect(r.config.rules[1]!.perHand).toBe(false)
    expect(r.config.effects['paint']).toMatchObject({ color: 'rainbow', width: 14, fadeMs: 300 })
  })

  it('grades colour everything by default, or only the camera', () => {
    const r = withEffects({ g1: { type: 'cameraMove', kind: 'grade' }, g2: { type: 'cameraMove', kind: 'grade', gradeScope: 'camera' } })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.config.effects['g1']).toMatchObject({ gradeScope: 'all' })
    expect(r.config.effects['g2']).toMatchObject({ gradeScope: 'camera' })
  })
})
