/**
 * Effect audio: one AudioContext → master gain → the chosen output device (setSinkId). Sound
 * effects are decoded AudioBuffers (they start on the next audio quantum, no media-element
 * startup delay); video clips' audio is routed through the same graph with a gain per clip.
 * Routing everything through one context is what lets Phase 3c send effect audio into a call by
 * picking a virtual device.
 */
import { mediaUrl } from '../../shared/media'

export interface AudioSettings {
  volume: number
  muted: boolean
  /** Part of an output device's name; undefined = the system default. */
  device?: string
}

type SinkContext = AudioContext & { setSinkId?(id: string): Promise<void> }

export class AudioEngine {
  private readonly ctx: SinkContext = new AudioContext({ latencyHint: 'interactive' })
  private readonly master = this.ctx.createGain()
  private readonly buffers = new Map<string, Promise<AudioBuffer | null>>()
  private readonly videoGains = new WeakMap<HTMLMediaElement, GainNode>()
  private device: string | undefined = undefined
  /** Which output is in use, for the Control window. */
  deviceLabel = 'system default'

  constructor() {
    this.master.connect(this.ctx.destination)
    // Autoplay is allowed for this window (main/index.ts), but a context can still start suspended.
    void this.ctx.resume()
  }

  configure(settings: AudioSettings): void {
    this.master.gain.value = settings.muted ? 0 : settings.volume
    if (settings.device !== this.device) {
      this.device = settings.device
      void this.applyDevice(settings.device)
    }
  }

  private async applyDevice(name: string | undefined): Promise<void> {
    if (!this.ctx.setSinkId) {
      this.deviceLabel = 'system default (setSinkId unsupported)'
      return
    }
    try {
      if (!name) {
        await this.ctx.setSinkId('')
        this.deviceLabel = 'system default'
        return
      }
      const outputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput')
      const want = name.toLowerCase()
      const match = outputs.find((d) => d.label.toLowerCase().includes(want))
      if (!match) {
        console.warn(`[audio] no output device matching "${name}" among: ${outputs.map((d) => d.label).join(', ')}`)
        await this.ctx.setSinkId('')
        this.deviceLabel = `system default ("${name}" not found)`
        return
      }
      await this.ctx.setSinkId(match.deviceId)
      this.deviceLabel = match.label
      console.log(`[audio] output → ${match.label}`)
    } catch (err) {
      console.warn('[audio] could not switch output device', err)
    }
  }

  /** Fetches and decodes a sound from reactions/ (once per path). */
  load(path: string): Promise<AudioBuffer | null> {
    let buffer = this.buffers.get(path)
    if (!buffer) {
      buffer = fetch(mediaUrl(path))
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((data) => this.ctx.decodeAudioData(data))
        .catch((err: unknown) => {
          console.warn(`[audio] cannot load reactions/${path}`, err)
          return null
        })
      this.buffers.set(path, buffer)
    }
    return buffer
  }

  /** Plays a loaded sound. False if it isn't decoded (yet) or failed. */
  async play(path: string, volume: number): Promise<boolean> {
    const buffer = await this.load(path)
    if (!buffer) return false
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    const gain = this.ctx.createGain()
    gain.gain.value = volume
    source.connect(gain).connect(this.master)
    source.onended = () => gain.disconnect()
    source.start()
    return true
  }

  /**
   * Routes a video element's sound through the engine (once per element) and sets its volume.
   * The element itself must stay unmuted: its output only reaches the speakers through here.
   */
  setVideoVolume(video: HTMLMediaElement, volume: number): void {
    let gain = this.videoGains.get(video)
    if (!gain) {
      gain = this.ctx.createGain()
      this.ctx.createMediaElementSource(video).connect(gain).connect(this.master)
      this.videoGains.set(video, gain)
      video.muted = false
    }
    gain.gain.value = volume
    if (this.ctx.state === 'suspended') void this.ctx.resume()
  }
}
