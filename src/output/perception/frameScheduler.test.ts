import { describe, expect, it } from 'vitest'
import { FrameScheduler } from './frameScheduler'

const FRAME = 1000 / 30
/** Offers `n` camera frames; the tracker answers `latencyMs` after each send. Returns the sent frame indices. */
function drive(s: FrameScheduler, n: number, latencyMs: number): number[] {
  const sent: number[] = []
  let doneAt: number | null = null
  let sentAt = 0
  for (let i = 0; i < n; i++) {
    const now = i * FRAME
    if (doneAt !== null && now >= doneAt) {
      s.done(sentAt)
      doneAt = null
    }
    if (s.offer(now)) {
      sent.push(i)
      sentAt = now
      doneAt = now + latencyMs
    }
  }
  return sent
}

describe('FrameScheduler', () => {
  it('sends every Nth frame while the tracker keeps up', () => {
    expect(drive(new FrameScheduler(1), 6, 10)).toEqual([0, 1, 2, 3, 4, 5])
    expect(drive(new FrameScheduler(2), 7, 20)).toEqual([0, 2, 4, 6])
  })

  it('never queues: a busy tracker skips frames, and the next frame goes out once it is free', () => {
    const s = new FrameScheduler(1)
    expect(drive(s, 6, 50)).toEqual([0, 2, 4])
    expect(s.busySkips).toBe(3)
  })

  it('stops waiting on a result that never arrives', () => {
    const s = new FrameScheduler(1, 500)
    expect(s.offer(0)).toBe(true)
    expect(s.offer(100)).toBe(false)
    expect(s.offer(600)).toBe(true)
  })

  it('picks up a new stride immediately', () => {
    const s = new FrameScheduler(1)
    s.offer(0)
    s.done(0)
    s.trackEvery = 3
    expect([1, 2, 3, 4].map((i) => (s.offer(i * FRAME) ? (s.done(i * FRAME), i) : -1))).toEqual([-1, -1, 3, -1])
  })

  it('ignores a late answer to a frame it already gave up on', () => {
    const s = new FrameScheduler(1, 500)
    s.offer(0)
    expect(s.offer(600)).toBe(true) // gave up on frame 0
    s.done(0) // frame 0 finally answers: frame 600 is still in flight
    expect(s.busy).toBe(true)
    expect(s.offer(633)).toBe(false)
    s.done(600)
    expect(s.offer(666)).toBe(true)
  })
})
