import { describe, expect, it } from 'vitest'
import { FACE_TUNING, FaceSmoother } from './faceSmoother'

const face = (x: number, y = 0.3, size = 0.2) => ({ x, y, width: size, height: size })

describe('FaceSmoother', () => {
  it('takes the first detection as is', () => {
    const s = new FaceSmoother()
    s.observe(face(0.4), 0)
    expect(s.get(0)).toMatchObject({ box: face(0.4), visible: true, seenAt: 0 })
  })

  it('glides toward small moves instead of jumping (10 fps detections)', () => {
    const s = new FaceSmoother()
    s.observe(face(0.4), 0)
    s.observe(face(0.5), 100)
    const x = s.get(100)!.box.x
    expect(x).toBeGreaterThan(0.45)
    expect(x).toBeLessThan(0.5)
  })

  it('snaps on a large jump (another face, or re-acquired far away)', () => {
    const s = new FaceSmoother()
    s.observe(face(0.1), 0)
    s.observe(face(0.7), 100)
    expect(s.get(100)!.box.x).toBeCloseTo(0.7)
  })

  it('holds the last box while the face is covered, then lets go', () => {
    const s = new FaceSmoother()
    s.observe(face(0.4), 0)
    s.observe(null, 100)
    expect(s.get(500)).toMatchObject({ box: face(0.4), visible: false, seenAt: 0 })
    expect(s.get(FACE_TUNING.holdMs + 1)).toBeNull()
  })

  it('snaps back to the face when it reappears after being covered', () => {
    const s = new FaceSmoother()
    s.observe(face(0.4), 0)
    s.observe(null, 100)
    s.observe(face(0.45), 600)
    expect(s.get(600)).toMatchObject({ visible: true, seenAt: 600 })
    expect(s.get(600)!.box.x).toBeCloseTo(0.45)
  })
})
