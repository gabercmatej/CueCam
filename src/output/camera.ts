export const FRAME_WIDTH = 1280
export const FRAME_HEIGHT = 720

/** Opens the webcam at 1280×720 / 30 fps and resolves once frames are flowing. */
export async function openCamera(): Promise<HTMLVideoElement> {
  const stream = await withRetry(() => requestCamera(), 3, 1000)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.srcObject = stream
  await video.play()

  const settings = stream.getVideoTracks()[0]?.getSettings()
  console.log(`[camera] ${settings?.width}×${settings?.height} @ ${settings?.frameRate} fps (${settings?.deviceId?.slice(0, 8)})`)
  return video
}

/**
 * Right after launch macOS sometimes reports no camera yet (seen as NotFoundError on the
 * first attempt, fine a second later), so transient device errors get a couple of retries.
 */
async function withRetry<T>(attempt: () => Promise<T>, tries: number, delayMs: number): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await attempt()
    } catch (err) {
      const transient = err instanceof DOMException && ['NotFoundError', 'NotReadableError', 'AbortError'].includes(err.name)
      if (!transient || i >= tries) throw err
      console.warn(`[camera] ${err.name}: ${err.message}; retrying (${i}/${tries - 1})`)
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
}

function requestCamera(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      width: { ideal: FRAME_WIDTH },
      height: { ideal: FRAME_HEIGHT },
      frameRate: { ideal: 30, max: 30 }
    }
  })
}
