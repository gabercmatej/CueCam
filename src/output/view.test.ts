import { describe, expect, it } from 'vitest'
import { correctHandedness, toScreen, type View } from './view'

const mirrored: View = { mirror: true, width: 1280, height: 720 }
const plain: View = { mirror: false, width: 1280, height: 720 }

describe('toScreen', () => {
  it('flips x when mirrored', () => {
    expect(toScreen(mirrored, { x: 0.25, y: 0.5 })).toEqual({ x: 960, y: 360 })
  })
  it('keeps x when not mirrored', () => {
    expect(toScreen(plain, { x: 0.25, y: 0.5 })).toEqual({ x: 320, y: 360 })
  })
})

describe('correctHandedness', () => {
  // MediaPipe labels assume a mirrored (selfie) input; we feed it the raw camera frame.
  it('swaps MediaPipe labels for a raw camera frame', () => {
    expect(correctHandedness('Left')).toBe('Right')
    expect(correctHandedness('Right')).toBe('Left')
  })
})
