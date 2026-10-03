import { describe, expect, it } from 'vitest'
import { onEachVideoFrame } from './frameLoop'

function fakeVideo() {
  let pending: ((now: number) => void) | null = null
  return {
    requestVideoFrameCallback(cb: (now: number) => void) {
      pending = cb
      return 1
    },
    frame(now: number) {
      const cb = pending
      pending = null
      cb?.(now)
    },
    get armed() {
      return pending !== null
    }
  }
}

describe('onEachVideoFrame', () => {
  it('runs the step once per frame', () => {
    const video = fakeVideo()
    const seen: number[] = []
    onEachVideoFrame(video, (now) => seen.push(now), () => {})
    video.frame(1)
    video.frame(2)
    expect(seen).toEqual([1, 2])
  })

  it('keeps running after a step throws, and reports the error', () => {
    const video = fakeVideo()
    const errors: unknown[] = []
    const seen: number[] = []
    onEachVideoFrame(
      video,
      (now) => {
        if (now === 1) throw new Error('context lost')
        seen.push(now)
      },
      (err) => errors.push(err)
    )
    video.frame(1)
    expect(video.armed).toBe(true)
    video.frame(2)
    expect(seen).toEqual([2])
    expect(errors).toHaveLength(1)
  })
})
