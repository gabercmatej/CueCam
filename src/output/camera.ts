export const FRAME_WIDTH = 1280
export const FRAME_HEIGHT = 720

/** Opens the webcam at 1280×720 / 30 fps and resolves once frames are flowing. */
export async function openCamera(): Promise<HTMLVideoElement> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      width: { ideal: FRAME_WIDTH },
      height: { ideal: FRAME_HEIGHT },
      frameRate: { ideal: 30, max: 30 }
    }
  })
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.srcObject = stream
  await video.play()

  const settings = stream.getVideoTracks()[0]?.getSettings()
  console.log(`[camera] ${settings?.width}×${settings?.height} @ ${settings?.frameRate} fps (${settings?.deviceId?.slice(0, 8)})`)
  return video
}
