/** What we ask the camera for: its native 1080p at 30 fps, uncropped and unscaled by Chromium. */
export const CAMERA_REQUEST = { width: 1920, height: 1080, fps: 30 }

/**
 * Virtual cameras are never a source: OBS Virtual Camera is our own output (a feedback loop,
 * re-encoded), and the others are re-processed feeds. macOS lists OBS's first, so the system
 * default camera is exactly the wrong one once OBS is installed.
 */
const VIRTUAL = /\b(obs|virtual|snap camera|mmhmm|camo|ecamm|xsplit|manycam|nvidia broadcast|zoom)\b/i

/**
 * Picks the camera: the first whose name contains `preferred` (case-insensitive), otherwise the
 * first camera that isn't virtual. Null = nothing usable (let the browser choose).
 */
export function pickCamera(devices: readonly Pick<MediaDeviceInfo, 'kind' | 'label' | 'deviceId'>[], preferred?: string): string | null {
  const cams = devices.filter((d) => d.kind === 'videoinput')
  if (preferred) {
    const want = preferred.toLowerCase()
    const match = cams.find((d) => d.label.toLowerCase().includes(want))
    if (match) return match.deviceId
    console.warn(`[camera] no camera matching "${preferred}" among: ${cams.map((d) => d.label).join(', ')}`)
  }
  return cams.find((d) => d.label && !VIRTUAL.test(d.label))?.deviceId ?? null
}

/** Opens the chosen camera at its native 1080p / 30 fps and resolves once frames are flowing. */
export async function openCamera(preferred?: string): Promise<HTMLVideoElement> {
  const stream = await withRetry(() => requestCamera(preferred), 3, 1000)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.srcObject = stream
  await video.play()

  const track = stream.getVideoTracks()[0]
  const s = track?.getSettings()
  const caps = track?.getCapabilities?.()
  console.log(
    `[camera] "${track?.label}" granted ${s?.width}×${s?.height} @ ${s?.frameRate} fps, resizeMode ${(s as { resizeMode?: string } | undefined)?.resizeMode ?? '?'}` +
      ` (asked ${CAMERA_REQUEST.width}×${CAMERA_REQUEST.height} @ ${CAMERA_REQUEST.fps}; device max ${caps?.width?.max}×${caps?.height?.max} @ ${caps?.frameRate?.max})`
  )
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

async function requestCamera(preferred?: string): Promise<MediaStream> {
  // Labels are only listed once camera access was granted (main asks at startup).
  const deviceId = pickCamera(await navigator.mediaDevices.enumerateDevices(), preferred)
  const video: MediaTrackConstraints & { resizeMode?: string } = {
    width: { ideal: CAMERA_REQUEST.width },
    height: { ideal: CAMERA_REQUEST.height },
    frameRate: { ideal: CAMERA_REQUEST.fps, max: CAMERA_REQUEST.fps },
    // Prefer a native sensor mode over Chromium cropping/scaling a different one.
    resizeMode: 'none',
    ...(deviceId ? { deviceId: { exact: deviceId } } : {})
  }
  return navigator.mediaDevices.getUserMedia({ audio: false, video })
}
