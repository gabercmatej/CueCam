/**
 * Audio: effect sounds, the raw mic, and the mix sent into a call.
 *
 *   effect sounds/clips → master ─┐
 *   raw mic → mic gain ───────────┴→ mix → destination (sink: BlackHole while sending to the call)
 *   raw mic → clap onset worklet (always; see clapOnset.ts)
 *   master → monitor tap → monitor context → your headphones (only while sending to the call)
 *
 * While "send to call" is on and an output named like `call.device` exists, the context's sink is that
 * device and the mic is mixed in; the call app picks BlackHole as its microphone. Otherwise the sink is
 * the local output (`device`) and the mic is not connected: the mic is never played to your own output.
 *
 * The mic stream has echo cancellation, noise suppression and auto gain OFF: the call app runs its own
 * on the BlackHole input (doing it twice pumps and warbles), Chromium's processing adds a 10 ms block,
 * it would smear the clap transient, and with headphones there is no echo. Speech recognition has its
 * own stream (speech.ts); nothing here ever reaches it or the clap detector except the raw mic.
 */
import type { Onset } from './clapOnset'
import type { ClapOnsetSettings } from './clapOnset'
import clapWorkletUrl from './clapOnset.worklet.ts?worker&url'
import type { ClapWorkletIn, ClapWorkletOut } from './clapOnset.worklet'
import { reactionUrl } from '../urls'
import { ClockOffset } from './clockOffset'

export interface CallSettings {
  /** Send mic + effect sounds to the call device. The Control switch overrides it until the config changes it. */
  enabled: boolean
  /** Part of the call device's output name. */
  device: string
  micVolume: number
  /** Hear the effect sounds yourself (in your headphones) while sending to the call. */
  monitor: boolean
  monitorVolume: number
}

export interface AudioSettings {
  volume: number
  muted: boolean
  /** Part of an output device's name; undefined = the system default. Local output and monitor. */
  device?: string
  call: CallSettings
}

export interface MicEvents {
  /** A finished sound onset on the raw mic (clap or rejected), stamped on the performance.now clock. */
  onOnset(onset: Onset, at: number): void
}

type SinkContext = AudioContext & { setSinkId?(id: string | { type: 'none' }): Promise<void>; sinkId?: string }

/** Meter window: ~43 ms at 48 kHz, read every stats tick. */
const METER_SIZE = 2048

export class AudioEngine {
  private readonly ctx: SinkContext = new AudioContext({ latencyHint: 'interactive' })
  private readonly master = this.ctx.createGain()
  private readonly mix = this.ctx.createGain()
  private readonly micGain = this.ctx.createGain()
  private readonly mixMeter = this.ctx.createAnalyser()
  private readonly meterBuf = new Float32Array(METER_SIZE)
  private readonly buffers = new Map<string, Promise<AudioBuffer | null>>()
  private readonly videoGains = new WeakMap<HTMLMediaElement, GainNode>()
  private settings: AudioSettings | null = null
  private sendToCall = false
  /** Monitor volume in use (0 = off): the config's value, or the Control slider's until the config changes it. */
  private monitorLevel = 0
  private routing: Promise<void> = Promise.resolve()
  private routeAgain = false
  private micTrack: MediaStreamTrack | null = null
  private clapNode: AudioWorkletNode | null = null
  /** The raw mic start in progress or done (true = mic and clap detector running), so it never runs twice at once. */
  private micStart: Promise<boolean> | null = null
  /** Audio clock → performance.now, so a sound is stamped when it happened, not when its message arrived. */
  private readonly clock = new ClockOffset()
  private monitor: { ctx: SinkContext; gain: GainNode; tap: MediaStreamAudioDestinationNode } | null = null
  /** Effect sounds playing now, so disarming can fade them out. */
  private readonly playing = new Set<GainNode>()
  /** Bumped by fadeOutSounds: a sound still decoding when it ran must not start afterwards. */
  private soundGeneration = 0
  /** The local output's device id ('' = system default) and whether it is the call device itself. */
  private local = { id: '', isCallDevice: false }
  /** The arm/disarm cue's own context, on the local output only (created on first use, suspended when idle). */
  private cue: { ctx: SinkContext; sinkId: string; idle: ReturnType<typeof setTimeout> | undefined } | null = null

  /** For the Control window. */
  status = {
    /** Where effect sounds (and while sending, the mic) go. */
    output: 'system default',
    /** null = not sending; else why or where. */
    call: 'off' as string,
    callActive: false,
    monitor: 'off',
    mic: 'starting…',
    /** Raw mic peak (dBFS) over the last ~100 ms, from the clap worklet. */
    micDb: -120,
    /** The clap detector's bright-band peak and its rise reference (dBFS). */
    brightDb: -120,
    floorDb: -120
  }

  /** `micOnDemand`: the raw mic (call mix + clap detector) waits for startMic() instead of starting now. */
  constructor(
    private readonly micEvents: MicEvents,
    micOnDemand = false
  ) {
    this.master.connect(this.mix)
    this.micGain.connect(this.mix)
    this.mix.connect(this.ctx.destination)
    this.mixMeter.fftSize = METER_SIZE
    this.mix.connect(this.mixMeter)
    // Not connected to the mix until a call is active.
    this.micGain.disconnect()
    // Autoplay is allowed for this window (main/index.ts), but a context can still start suspended.
    void this.ctx.resume()
    // A device change can move the sink before route() runs (Chromium falls back to the default output
    // when the sink device disappears): cut the mic at once; route() reconnects it if the call is still on.
    const deviceLost = (): void => {
      this.micGain.disconnect()
      this.route()
    }
    navigator.mediaDevices.addEventListener('devicechange', deviceLost)
    this.ctx.addEventListener('error', deviceLost)
    if (!micOnDemand) void this.startMic()
  }

  /** The effect context's state and sample rate (dev diagnostics). */
  get contextInfo(): string {
    return `${this.ctx.state} @ ${this.ctx.sampleRate} Hz`
  }

  get sendingToCall(): boolean {
    return this.sendToCall
  }

  configure(settings: AudioSettings): void {
    const prev = this.settings
    this.settings = settings
    this.master.gain.value = settings.muted ? 0 : settings.volume
    this.micGain.gain.value = settings.call.micVolume
    // The config's switch and monitor volume apply when they change (or first); the Control window's
    // switch and slider override them in between, so an unrelated config edit doesn't undo them.
    const send = !prev || prev.call.enabled !== settings.call.enabled ? settings.call.enabled : this.sendToCall
    const configMonitor = settings.call.monitor ? settings.call.monitorVolume : 0
    const prevMonitor = prev ? (prev.call.monitor ? prev.call.monitorVolume : 0) : NaN
    const level = configMonitor !== prevMonitor ? configMonitor : this.monitorLevel
    const reroute =
      !prev || send !== this.sendToCall || (level > 0) !== (this.monitorLevel > 0) || prev.device !== settings.device || prev.call.device !== settings.call.device
    this.sendToCall = send
    this.monitorLevel = level
    if (this.monitor) this.monitor.gain.gain.value = level
    if (reroute) this.route()
  }

  /** The Control window's "send to call" switch. */
  setSendToCall(on: boolean): void {
    if (on === this.sendToCall) return
    this.sendToCall = on
    this.route()
  }

  /** The Control window's monitor volume (0 = off: the monitor context is closed). */
  setMonitorVolume(volume: number): void {
    const wasOn = this.monitorLevel > 0
    this.monitorLevel = volume
    if (this.monitor) this.monitor.gain.gain.value = volume
    if (wasOn !== volume > 0) this.route()
    else if (this.monitor) this.status.monitor = this.status.monitor.replace(/\d+%$/, `${Math.round(volume * 100)}%`)
  }

  get monitorVolume(): number {
    return this.monitorLevel
  }

  setClapSettings(settings: ClapOnsetSettings): void {
    this.clapSettings = settings
    this.clapNode?.port.postMessage({ type: 'settings', settings } satisfies ClapWorkletIn)
  }
  private clapSettings: ClapOnsetSettings | null = null

  /** Mix peak (dBFS) over the last ~43 ms. Call at the stats rate, not per frame. */
  mixDb(): number {
    this.mixMeter.getFloatTimeDomainData(this.meterBuf)
    let peak = 0
    for (let i = 0; i < this.meterBuf.length; i++) {
      const v = Math.abs(this.meterBuf[i]!)
      if (v > peak) peak = v
    }
    return peak > 0 ? 20 * Math.log10(peak) : -120
  }

  /** Latency figures for the Control window and the dev measurement (ms). */
  latency(): { base: number; output: number; micInput: number | null } {
    const settings = this.micTrack?.getSettings() as (MediaTrackSettings & { latency?: number }) | undefined
    return {
      base: this.ctx.baseLatency * 1000,
      output: (this.ctx.outputLatency ?? 0) * 1000,
      micInput: settings?.latency !== undefined ? settings.latency * 1000 : null
    }
  }

  /**
   * Opens the raw mic for the call mix, then the clap detector on it (at construction, unless
   * `micOnDemand`). Never throws: resolves true when both run. A mic that opened stays open if only
   * the detector fails (call audio still works); calling again retries what failed, never twice at once.
   */
  startMic(): Promise<boolean> {
    this.micStart ??= this.openMic().then((ok) => {
      if (!ok) this.micStart = null
      return ok
    })
    return this.micStart
  }

  private micSource: MediaStreamAudioSourceNode | null = null

  private async openMic(): Promise<boolean> {
    try {
      if (!this.micSource) {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: false,
          audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        })
        this.micTrack = stream.getAudioTracks()[0] ?? null
        this.micSource = this.ctx.createMediaStreamSource(stream)
        this.micSource.connect(this.micGain)
      }
      const source = this.micSource
      await this.ctx.audioWorklet.addModule(clapWorkletUrl)
      const node = new AudioWorkletNode(this.ctx, 'clap-onset', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' })
      node.port.onmessage = (e: MessageEvent<ClapWorkletOut>) => {
        const msg = e.data
        this.clock.observe(msg.contextTime, performance.now())
        if (msg.type === 'onset') {
          const onsetMs = msg.contextTime * 1000 - msg.ageMs
          this.micEvents.onOnset(msg.onset, this.clock.toPerformance(onsetMs) - (this.latency().micInput ?? 0))
        } else {
          this.status.micDb = msg.micDb
          this.status.brightDb = msg.peakDb
          this.status.floorDb = msg.floorDb
        }
      }
      node.onprocessorerror = (e) => {
        this.status.mic += ' · CLAP DETECTOR CRASHED'
        console.error('[audio] clap onset worklet error', e)
      }
      source.connect(node)
      this.clapNode = node
      if (this.clapSettings) this.setClapSettings(this.clapSettings)
      const s = this.micTrack?.getSettings()
      this.status.mic = `${this.micTrack?.label ?? 'mic'} · raw (no AEC/NS/AGC)${s?.sampleRate ? ` · ${s.sampleRate / 1000} kHz` : ''}`
      this.route()
      return true
    } catch (err) {
      this.status.mic = `FAILED: ${String(err)}`
      console.error('[audio] raw mic failed to start (no call audio, no clap sound)', err)
      return false
    }
  }

  /** Re-applies the routing; serialized, and coalesced if asked again while running. */
  private route(): void {
    if (this.routeAgain) return
    this.routeAgain = true
    this.routing = this.routing.then(async () => {
      this.routeAgain = false
      try {
        await this.applyRoute()
      } catch (err) {
        console.warn('[audio] routing failed', err)
      }
    })
  }

  private async applyRoute(): Promise<void> {
    const s = this.settings
    if (!s) return
    const outputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput')
    const find = (name: string | undefined): MediaDeviceInfo | undefined =>
      name ? outputs.find((d) => d.label.toLowerCase().includes(name.toLowerCase())) : undefined
    const local = find(s.device)
    const localId = local?.deviceId ?? ''
    // With no device named, the local output is the system default: make sure that isn't the call device.
    const localName = local?.label ?? outputs.find((d) => d.deviceId === 'default')?.label ?? ''
    this.local = { id: localId, isCallDevice: !!s.call.device && localName.toLowerCase().includes(s.call.device.toLowerCase()) }
    const localLabel = local?.label ?? (s.device ? `system default ("${s.device}" not found)` : 'system default')
    const callDevice = find(s.call.device)
    const active = this.sendToCall && !!callDevice && !!this.micTrack

    if (!this.ctx.setSinkId) {
      this.status.output = 'system default (setSinkId unsupported)'
      this.status.call = 'unavailable (setSinkId unsupported)'
      this.status.callActive = false
      return
    }
    // The mic goes to the mix only while the sink is the call device, never to your own output: cut it
    // before the sink moves away from the call device, connect it only after the sink is the call device.
    this.micGain.disconnect()
    await this.ctx.setSinkId(active ? callDevice.deviceId : localId)
    if (active) this.micGain.connect(this.mix)

    if (active && this.monitorLevel > 0) await this.startMonitor(localId, this.monitorLevel)
    else this.stopMonitor()

    this.status.callActive = active
    this.status.output = active ? callDevice.label : localLabel
    this.status.call = !this.sendToCall
      ? 'off'
      : !callDevice
        ? `"${s.call.device}" not found: effects play locally, no call audio`
        : !this.micTrack
          ? 'no mic'
          : `ON → ${callDevice.label}`
    this.status.monitor = this.monitor ? `${localLabel} at ${Math.round(this.monitorLevel * 100)}%` : 'off'
    console.log(`[audio] output → ${this.status.output} · call ${this.status.call} · monitor ${this.status.monitor}`)
  }

  private async startMonitor(sinkId: string, volume: number): Promise<void> {
    if (!this.monitor) {
      const ctx: SinkContext = new AudioContext({ latencyHint: 'interactive' })
      const tap = this.ctx.createMediaStreamDestination()
      const gain = ctx.createGain()
      ctx.createMediaStreamSource(tap.stream).connect(gain).connect(ctx.destination)
      this.master.connect(tap)
      this.monitor = { ctx, gain, tap }
    }
    this.monitor.gain.gain.value = volume
    if (this.monitor.ctx.state === 'suspended') await this.monitor.ctx.resume()
    if (this.monitor.ctx.setSinkId && this.monitor.ctx.sinkId !== sinkId) await this.monitor.ctx.setSinkId(sinkId)
  }

  private stopMonitor(): void {
    if (!this.monitor) return
    this.master.disconnect(this.monitor.tap)
    void this.monitor.ctx.close()
    this.monitor = null
  }

  /** Fetches and decodes a sound from reactions/ (once per path, until `forget`). `url` may carry a version. */
  load(path: string, url = reactionUrl(path)): Promise<AudioBuffer | null> {
    let buffer = this.buffers.get(path)
    if (!buffer) {
      buffer = fetch(url)
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

  /** Drops a decoded sound (its file changed or no effect uses it any more); the next load fetches it again. */
  forget(path: string): void {
    this.buffers.delete(path)
  }

  /** Whether a sound decoded (null while loading). */
  async loaded(path: string): Promise<boolean> {
    return (await this.buffers.get(path)) != null
  }

  /** Fades every playing effect sound out over `ms` (disarm). Video sound goes with its video. */
  fadeOutSounds(ms = 150): void {
    this.soundGeneration++
    const t = this.ctx.currentTime
    for (const gain of this.playing) {
      gain.gain.cancelScheduledValues(t)
      gain.gain.setValueAtTime(gain.gain.value, t)
      gain.gain.linearRampToValueAtTime(0, t + ms / 1000)
    }
  }

  /**
   * A short two-note blip for arm (rising) / disarm (falling), only on your local output: its own
   * context, never the effect context (BlackHole while sending) or the monitor tap, so the call never
   * hears it. Skipped if the local output is the call device itself.
   */
  playCue(armed: boolean): void {
    if (this.local.isCallDevice) return
    if (!this.cue) this.cue = { ctx: new AudioContext({ latencyHint: 'interactive' }), sinkId: '', idle: undefined }
    const cue = this.cue
    clearTimeout(cue.idle)
    void (async () => {
      if (cue.ctx.setSinkId && cue.sinkId !== this.local.id) {
        await cue.ctx.setSinkId(this.local.id).catch((err: unknown) => console.warn('[audio] cue output', err))
        cue.sinkId = this.local.id
      }
      if (cue.ctx.state === 'suspended') await cue.ctx.resume()
      const ctx = cue.ctx
      const notes = armed ? [660, 990] : [660, 440]
      const t0 = ctx.currentTime + 0.01
      notes.forEach((freq, i) => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.value = freq
        const start = t0 + i * 0.09
        gain.gain.setValueAtTime(0, start)
        gain.gain.linearRampToValueAtTime(0.12, start + 0.008)
        gain.gain.exponentialRampToValueAtTime(0.0005, start + 0.12)
        osc.connect(gain).connect(ctx.destination)
        osc.start(start)
        osc.stop(start + 0.13)
        osc.onended = () => gain.disconnect()
      })
      // An idle running context still wakes the audio thread: suspend it after the blip.
      cue.idle = setTimeout(() => void cue.ctx.suspend(), 1000)
    })()
  }

  /** Plays a loaded sound. False if it isn't decoded (yet) or failed. */
  async play(path: string, volume: number): Promise<boolean> {
    const generation = this.soundGeneration
    const buffer = await this.load(path)
    if (!buffer || generation !== this.soundGeneration) return false
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    const gain = this.ctx.createGain()
    gain.gain.value = volume
    source.connect(gain).connect(this.master)
    this.playing.add(gain)
    source.onended = () => {
      gain.disconnect()
      this.playing.delete(gain)
    }
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

  /** A video element that will be thrown away: disconnect its sound from the graph. */
  releaseVideo(video: HTMLMediaElement): void {
    this.videoGains.get(video)?.disconnect()
    this.videoGains.delete(video)
  }

  /**
   * Dev: a synthetic clap (decaying noise burst, `amp` peak) straight into the clap detector only (no
   * output, never heard). Tests the worklet, its messages and the fusion without a sound in the room.
   */
  injectTestClap(amp = 0.5): boolean {
    if (!this.clapNode) return false
    const ctx = this.ctx
    const buffer = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.15), ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = amp * (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.008))
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(this.clapNode)
    src.onended = () => src.disconnect()
    src.start()
    return true
  }

  /**
   * Dev: measures the mix → call-app path, silently. A 2 ms click goes into the mix only (never the
   * monitor, so nobody here hears it), is recorded back from the call device's input (BlackHole's
   * loopback) and found by the clap onset detector. `renderToInput` is from the moment the click is
   * rendered to the moment it arrives at a BlackHole reader (Web Audio output buffer + BlackHole + the
   * reader's input), which is what a call app sees. Add the mic's input latency for mic → call app.
   */
  async measureCallLatency(runs = 6): Promise<{ renderToInputMs: number[]; micInputMs: number | null; baseMs: number; outputMs: number; totalMs: number }> {
    if (!this.status.callActive || !this.settings) throw new Error(`call audio is not active (${this.status.call})`)
    const want = this.settings.call.device.toLowerCase()
    const input = (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === 'audioinput' && d.label.toLowerCase().includes(want))
    if (!input) throw new Error(`no input named like "${this.settings.call.device}"`)
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: input.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }
    })
    const rec = new AudioContext({ latencyHint: 'interactive' })
    try {
      await rec.audioWorklet.addModule(clapWorkletUrl)
      const node = new AudioWorkletNode(rec, 'clap-onset', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' })
      node.port.postMessage({
        type: 'settings',
        settings: { minRiseDb: 12, minLevelDb: -50, minBrightness: 0, maxDurationMs: 200, decayDb: 6 }
      } satisfies ClapWorkletIn)
      rec.createMediaStreamSource(stream).connect(node)
      let onset: ((at: number) => void) | null = null
      node.port.onmessage = (e: MessageEvent<ClapWorkletOut>) => {
        if (e.data.type === 'onset' && e.data.onset.verdict === 'clap') onset?.(performance.now() - e.data.ageMs)
      }
      await new Promise((r) => setTimeout(r, 600)) // let the detector learn the floor
      const renderToInputMs: number[] = []
      for (let i = 0; i < runs; i++) {
        const heard = new Promise<number | null>((resolve) => {
          onset = resolve
          setTimeout(() => resolve(null), 1000)
        })
        const renderedAt = this.injectClick()
        const at = await heard
        if (at !== null) renderToInputMs.push(at - renderedAt)
        await new Promise((r) => setTimeout(r, 300))
      }
      const l = this.latency()
      const sorted = [...renderToInputMs].sort((a, b) => a - b)
      const median = sorted[sorted.length >> 1] ?? NaN
      return { renderToInputMs, micInputMs: l.micInput, baseMs: l.base, outputMs: l.output, totalMs: (l.micInput ?? 0) + median }
    } finally {
      stream.getTracks().forEach((t) => t.stop())
      void rec.close()
    }
  }

  /**
   * Dev: a 2 ms click into the mix only (the call device; never the monitor), 100 ms from now. Returns
   * when it is rendered, on the performance.now clock.
   */
  private injectClick(): number {
    const ctx = this.ctx
    const buffer = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.002), ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.8
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(this.mix)
    src.onended = () => src.disconnect()
    // currentTime is the next frame to be rendered (now, within one 2.7 ms quantum).
    src.start(ctx.currentTime + 0.1)
    return performance.now() + 100
  }
}
