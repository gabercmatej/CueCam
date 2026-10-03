interface FrameSource {
  requestVideoFrameCallback(callback: (now: number) => void): number
}

/**
 * Runs `step` once per new video frame. The next callback is registered before the
 * step runs, so one throw (e.g. GPU context loss) cannot stop the loop for good.
 */
export function onEachVideoFrame(video: FrameSource, step: (now: number) => void, onError: (err: unknown) => void): void {
  const tick = (now: number): void => {
    video.requestVideoFrameCallback(tick)
    try {
      step(now)
    } catch (err) {
      onError(err)
    }
  }
  video.requestVideoFrameCallback(tick)
}
