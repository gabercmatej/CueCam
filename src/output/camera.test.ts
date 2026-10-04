import { describe, expect, it } from 'vitest'
import { pickCamera } from './camera'

const dev = (label: string, kind: MediaDeviceKind = 'videoinput') => ({ kind, label, deviceId: `id:${label}` })
// macOS lists OBS's virtual camera first once OBS is installed (seen on Matej's MacBook Air).
const devices = [dev('MacBook Air Microphone', 'audioinput'), dev('OBS Virtual Camera'), dev('MacBook Air Camera (0000:0001)'), dev('iPhone Camera')]

describe('pickCamera', () => {
  it('never picks OBS Virtual Camera (our own output) by default', () => {
    expect(pickCamera(devices)).toBe('id:MacBook Air Camera (0000:0001)')
  })

  it('honours a preferred name, case-insensitively', () => {
    expect(pickCamera(devices, 'iphone')).toBe('id:iPhone Camera')
  })

  it('falls back to the first real camera when the preferred one is missing', () => {
    expect(pickCamera(devices, 'Logitech')).toBe('id:MacBook Air Camera (0000:0001)')
  })

  it('skips other virtual cameras and ignores non-video devices', () => {
    expect(pickCamera([dev('Snap Camera'), dev('Camo'), dev('FaceTime HD Camera')])).toBe('id:FaceTime HD Camera')
    expect(pickCamera([dev('MacBook Air Microphone', 'audioinput')])).toBeNull()
  })
})
