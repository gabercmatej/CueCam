/** The parts of rVFC metadata we use. `captureTime` is set for camera frames (same clock as performance.now()). */
export interface FrameMeta {
  captureTime?: number
}

interface FrameSource {
  requestVideoFrameCallback(callback: (now: number, meta?: FrameMeta) => void): number
}

/**
 * Runs `step` once per new video frame. The next callback is registered before the
 * step runs, so one throw (e.g. GPU context loss) cannot stop the loop for good.
 */
export function onEachVideoFrame(video: FrameSource, step: (now: number, meta?: FrameMeta) => void, onError: (err: unknown) => void): void {
  const tick = (now: number, meta?: FrameMeta): void => {
    video.requestVideoFrameCallback(tick)
    try {
      step(now, meta)
    } catch (err) {
      onError(err)
    }
  }
  video.requestVideoFrameCallback(tick)
}
