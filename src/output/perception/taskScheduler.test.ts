import { describe, expect, it } from 'vitest'
import { TaskScheduler } from './taskScheduler'

const FRAME = 1000 / 30
const handsOnly = (every: number, stallMs?: number) => new TaskScheduler({ hands: every, segment: 0, face: 0 }, stallMs)

/** Offers `n` camera frames; the worker answers `latencyMs` after each send. Returns the sent frame indices. */
function drive(s: TaskScheduler, n: number, latencyMs: number, log?: string[]): number[] {
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
      log?.push(`${i}:${(['hands', 'segment', 'face'] as const).filter((t) => s.due[t]).join('+')}`)
      sentAt = now
      doneAt = now + latencyMs
    }
  }
  return sent
}

describe('TaskScheduler (single task: the Phase 2 frame scheduler)', () => {
  it('sends every Nth frame while the worker keeps up', () => {
    expect(drive(handsOnly(1), 6, 10)).toEqual([0, 1, 2, 3, 4, 5])
    expect(drive(handsOnly(2), 7, 20)).toEqual([0, 2, 4, 6])
  })

  it('never queues: a busy worker skips frames, and the next frame goes out once it is free', () => {
    const s = handsOnly(1)
    expect(drive(s, 6, 50)).toEqual([0, 2, 4])
    expect(s.busySkips).toBe(3)
  })

  it('stops waiting on a result that never arrives', () => {
    const s = handsOnly(1, 500)
    expect(s.offer(0)).toBe(true)
    expect(s.offer(100)).toBe(false)
    expect(s.offer(600)).toBe(true)
  })

  it('picks up a new stride immediately', () => {
    const s = handsOnly(1)
    s.offer(0)
    s.done(0)
    s.every.hands = 3
    expect([1, 2, 3, 4].map((i) => (s.offer(i * FRAME) ? (s.done(i * FRAME), i) : -1))).toEqual([-1, -1, 3, -1])
  })

  it('ignores a late answer to a frame it already gave up on', () => {
    const s = handsOnly(1, 500)
    s.offer(0)
    expect(s.offer(600)).toBe(true) // gave up on frame 0
    s.done(0) // frame 0 finally answers: frame 600 is still in flight
    expect(s.busy).toBe(true)
    expect(s.offer(633)).toBe(false)
    s.done(600)
    expect(s.offer(666)).toBe(true)
  })
})

describe('TaskScheduler (several tasks share one worker)', () => {
  it('runs each task at its own stride, batching tasks that fall due on the same frame', () => {
    const log: string[] = []
    drive(new TaskScheduler({ hands: 2, segment: 0, face: 3 }), 7, 10, log)
    expect(log).toEqual(['0:hands+face', '2:hands', '3:face', '4:hands', '6:hands+face'])
  })

  it('interleaves segmentation with hand tracking instead of stacking them', () => {
    const log: string[] = []
    drive(new TaskScheduler({ hands: 2, segment: 2, face: 0 }), 8, 10, log)
    // The first frame runs everything (a first mask right away); from then on they alternate.
    expect(log).toEqual(['0:hands+segment', '2:hands', '3:segment', '4:hands', '5:segment', '6:hands', '7:segment'])
  })

  it('stacks them when hands take every frame: there is no free frame to yield to', () => {
    const log: string[] = []
    drive(new TaskScheduler({ hands: 1, segment: 2, face: 0 }), 5, 10, log)
    expect(log).toEqual(['0:hands+segment', '1:hands', '2:hands+segment', '3:hands', '4:hands+segment'])
  })

  it('an overdue segmentation goes along with the hands instead of yielding again', () => {
    const s = new TaskScheduler({ hands: 2, segment: 2, face: 0 })
    // Frame 0 runs both; the worker then stays busy for frames 1–3 (segmentation overdue by frame 4).
    expect(s.offer(0)).toBe(true)
    expect([1, 2, 3].map((i) => s.offer(i * FRAME))).toEqual([false, false, false])
    s.done(0)
    expect(s.offer(4 * FRAME)).toBe(true)
    expect(s.due).toMatchObject({ hands: true, segment: true })
  })

  it('a task that falls due while the worker is busy runs on the next free frame, not later', () => {
    const log: string[] = []
    drive(new TaskScheduler({ hands: 2, segment: 0, face: 3 }), 7, 40, log)
    // Face falls due at frame 3, but frame 2's run (66 → 106 ms) is still busy at 100 ms; it goes with frame 4.
    expect(log).toEqual(['0:hands+face', '2:hands', '4:hands+face', '6:hands'])
  })

  it('a disabled task never runs, and nothing is sent when no task is due', () => {
    const s = new TaskScheduler({ hands: 0, segment: 0, face: 0 })
    expect(s.offer(0)).toBe(false)
    expect(s.busy).toBe(false)
  })

  it('enabling a task makes it due on the next frame', () => {
    const s = new TaskScheduler({ hands: 2, segment: 0, face: 0 })
    expect(s.offer(0)).toBe(true)
    s.done(0)
    s.every.segment = 4
    expect(s.offer(FRAME)).toBe(true)
    expect(s.due).toEqual({ hands: false, segment: true, face: false })
  })

  it('a task due on a busy frame keeps its yield rule: hands are never starved', () => {
    const log: string[] = []
    drive(new TaskScheduler({ hands: 2, segment: 2, face: 3 }), 9, 10, log)
    expect(log.filter((l) => l.includes('hands')).length).toBe(5)
    expect(log.filter((l) => l.includes('segment')).length).toBe(4)
  })
})
