import { inBrowser } from './urls'

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

/** Why the camera isn't working, in words for the Control window. */
export function describeCameraError(err: unknown): string {
  const name = err instanceof Error || err instanceof DOMException ? err.name : ''
  const message = err instanceof Error || err instanceof DOMException ? err.message : String(err)
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      if (inBrowser()) return 'Camera access is blocked for this page. Allow it with the icon at the left of the address bar: Skillcam picks the camera up by itself.'
      return 'Camera access is blocked. Allow it in System Settings → Privacy & Security → Camera (in dev: Electron), then restart Skillcam.'
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera found. Connect one: Skillcam picks it up by itself.'
    case 'OnlyVirtualCameras':
      return `Only virtual cameras found (${message}). Skillcam never uses those (OBS's is its own output). Connect a real camera.`
    case 'NotReadableError':
    case 'AbortError':
      return 'The camera is busy or failed to start. Close other apps using it; Skillcam keeps retrying.'
    default:
      return `The camera failed to open (${name || 'error'}: ${message}). Skillcam keeps retrying.`
  }
}

/** How often a failed camera is retried (a device change retries at once). */
const RETRY_MS = 3000

/**
 * The camera behind one long-lived <video> element. `open` resolves once frames flow, retrying (every
 * 3 s and on any device change) until a camera works, with the reason in `problem` meanwhile. A camera
 * that disconnects later is reopened into the same element, so the stage and frame loop keep running.
 */
export class LiveCamera {
  readonly video = document.createElement('video')
  state: 'opening' | 'ok' | 'error' = 'opening'
  /** Why there's no picture (state 'error'). */
  problem: string | null = null
  /** The camera works, but not the one the config asked for. */
  warning: string | null = null
  label = ''
  /** When the current camera started (performance.now), for a grace period before "no frames" counts. */
  okAt = 0
  private retry: (() => void) | null = null

  constructor(private preferred?: string) {
    this.video.muted = true
    this.video.playsInline = true
    navigator.mediaDevices.addEventListener('devicechange', () => this.retry?.())
  }

  async open(): Promise<HTMLVideoElement> {
    for (;;) {
      try {
        await this.start()
        return this.video
      } catch (err) {
        this.state = 'error'
        this.problem = describeCameraError(err)
        console.warn(`[camera] ${this.problem}`)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, RETRY_MS)
          const self = this
          function done(): void {
            clearTimeout(timer)
            self.retry = null
            resolve()
          }
          this.retry = done
        })
      }
    }
  }

  private async start(): Promise<void> {
    const stream = await withRetry(() => this.request(), 3, 1000)
    const track = stream.getVideoTracks()[0]
    this.video.srcObject = stream
    try {
      await this.video.play()
    } catch (err) {
      // Never leave a camera open (and its light on) that we aren't showing.
      stream.getTracks().forEach((t) => t.stop())
      throw err
    }
    this.state = 'ok'
    this.okAt = performance.now()
    this.problem = null
    this.label = track?.label ?? 'camera'
    // Unplugged or taken over: reopen into the same element.
    track?.addEventListener(
      'ended',
      () => {
        this.state = 'error'
        this.problem = `"${this.label}" disconnected. Reconnect it (or another camera); Skillcam picks it up by itself.`
        console.warn(`[camera] ${this.problem}`)
        stream.getTracks().forEach((t) => t.stop())
        void this.open()
      },
      { once: true }
    )
    const s = track?.getSettings()
    const caps = track?.getCapabilities?.()
    console.log(
      `[camera] "${track?.label}" granted ${s?.width}×${s?.height} @ ${s?.frameRate} fps, resizeMode ${(s as { resizeMode?: string } | undefined)?.resizeMode ?? '?'}` +
        ` (asked ${CAMERA_REQUEST.width}×${CAMERA_REQUEST.height} @ ${CAMERA_REQUEST.fps}; device max ${caps?.width?.max}×${caps?.height?.max} @ ${caps?.frameRate?.max})`
    )
  }

  private async request(): Promise<MediaStream> {
    // Labels are only listed once camera access was granted (main asks at startup).
    const devices = await navigator.mediaDevices.enumerateDevices()
    const cams = devices.filter((d) => d.kind === 'videoinput')
    const deviceId = pickCamera(devices, this.preferred)
    if (!deviceId && cams.length > 0 && cams.every((d) => d.label)) {
      const err = new Error(cams.map((d) => d.label).join(', '))
      err.name = 'OnlyVirtualCameras'
      throw err
    }
    const want = this.preferred?.toLowerCase()
    this.warning = want && !cams.some((d) => d.label.toLowerCase().includes(want)) ? `No camera matches video.camera "${this.preferred}"; using another one.` : null
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
