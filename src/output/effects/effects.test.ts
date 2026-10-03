import { describe, expect, it } from 'vitest'
import { resolveAnchors } from './anchors'
import { cameraTransform, type ActiveMove } from './cameraMove'
import { spawnBurst, stepParticle, PRESETS } from './particleSim'

const W = 1280
const H = 720

describe('resolveAnchors', () => {
  it('uses the trigger position for hand anchors', () => {
    expect(resolveAnchors('hand', { position: { x: 900, y: 300 }, hands: [] }, W, H)).toEqual([{ x: 900, y: 300, angle: -Math.PI / 2 }])
  })

  it('falls back to the first visible hand, then the center', () => {
    expect(resolveAnchors('hand', { hands: [{ x: 10, y: 20 }] }, W, H)[0]).toMatchObject({ x: 10, y: 20 })
    expect(resolveAnchors('hand', { hands: [] }, W, H)[0]).toMatchObject({ x: 640, y: 360 })
  })

  it('puts between-hands at the midpoint of two hands when no position is given', () => {
    expect(resolveAnchors('between-hands', { hands: [{ x: 100, y: 100 }, { x: 300, y: 300 }] }, W, H)[0]).toMatchObject({ x: 200, y: 200 })
  })

  it('aims bottom-corner cannons up and inward', () => {
    const [left, right] = resolveAnchors('bottom-corners', { hands: [] }, W, H)
    expect(left).toMatchObject({ x: 0, y: H })
    expect(right).toMatchObject({ x: W, y: H })
    expect(Math.cos(left!.angle)).toBeGreaterThan(0)
    expect(Math.sin(left!.angle)).toBeLessThan(0)
    expect(Math.cos(right!.angle)).toBeLessThan(0)
  })
})

describe('cameraTransform', () => {
  it('is identity with no moves', () => {
    expect(cameraTransform([], 0, () => 0.5)).toEqual({ scale: 1, focus: { x: 0, y: 0 }, offset: { x: 0, y: 0 }, rotation: 0 })
  })

  it('zooms in, holds, and returns to 1 at the end', () => {
    const zoom: ActiveMove = { kind: 'zoom', start: 0, durationMs: 1000, intensity: 0, amount: 2, focus: { x: 100, y: 50 } }
    expect(cameraTransform([zoom], 500, () => 0.5).scale).toBeCloseTo(2)
    expect(cameraTransform([zoom], 500, () => 0.5).focus).toEqual({ x: 100, y: 50 })
    expect(cameraTransform([zoom], 1000, () => 0.5).scale).toBeCloseTo(1)
    expect(cameraTransform([zoom], 100, () => 0.5).scale).toBeGreaterThan(1)
  })

  it('shakes within an amplitude that decays to zero', () => {
    const shake: ActiveMove = { kind: 'shake', start: 0, durationMs: 600, intensity: 1, amount: 1, focus: { x: 0, y: 0 } }
    const early = cameraTransform([shake], 0, () => 1).offset
    const late = cameraTransform([shake], 590, () => 1).offset
    expect(Math.abs(early.x)).toBeGreaterThan(10)
    expect(Math.abs(late.x)).toBeLessThan(1)
  })
})

describe('particle sim', () => {
  it('spawns the requested count around the anchor direction', () => {
    const ps = spawnBurst(PRESETS.confetti, { x: 0, y: 720, angle: -Math.PI / 3 }, 50, 'cannon', Math.random)
    expect(ps).toHaveLength(50)
    for (const p of ps) expect(p.vy).toBeLessThan(0)
  })

  it('applies gravity and ages particles until they die', () => {
    const [p] = spawnBurst(PRESETS.confetti, { x: 0, y: 0, angle: 0 }, 1, 'burst', () => 0.5)
    const vy0 = p!.vy
    expect(stepParticle(p!, 0.1)).toBe(true)
    expect(p!.vy).toBeGreaterThan(vy0)
    expect(stepParticle(p!, 100)).toBe(false)
  })
})
