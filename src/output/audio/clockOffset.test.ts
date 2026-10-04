import { describe, expect, it } from 'vitest'
import { ClockOffset } from './clockOffset'

describe('ClockOffset', () => {
  it('ignores delivery delay: a late message does not shift the mapping', () => {
    const c = new ClockOffset()
    // Audio clock = performance.now − 1000; delivery normally 1 ms, one message delayed 80 ms.
    for (let i = 0; i < 20; i++) c.observe(i * 0.1, 1000 + i * 100 + (i === 10 ? 80 : 1))
    expect(c.toPerformance(1500)).toBeCloseTo(2501, 0)
  })

  it('a sound reported late by a busy main thread is still stamped when it happened', () => {
    const c = new ClockOffset()
    for (let i = 0; i < 10; i++) c.observe(i * 0.1, 1000 + i * 100 + 1)
    // Onset at audio 1.05 s (performance 2050); its message is posted at audio 1.1 s and arrives 90 ms late.
    c.observe(1.1, 2100 + 90)
    // Within the minimum's slow creep (2 ms/s), nowhere near the 90 ms delivery delay.
    expect(Math.abs(c.toPerformance(1050) - 2051)).toBeLessThan(2)
  })

  it('follows a jump in the audio clock (context suspended and resumed) at once', () => {
    const c = new ClockOffset()
    for (let i = 0; i < 10; i++) c.observe(i * 0.1, 1000 + i * 100)
    // Suspended for 5 s: the audio clock continues from 1.0 s while performance.now jumped ahead.
    for (let i = 0; i < 5; i++) c.observe(1 + i * 0.1, 7000 + i * 100 + 1)
    expect(c.toPerformance(1200)).toBeCloseTo(7201, 0)
  })
})
