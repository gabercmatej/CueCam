/**
 * The web demo's stand-in for the Electron preload: the same `window.skillcam` API, served from
 * static files. Config and the reactions/ listing come from the build (skillcam.config.json,
 * media-manifest.json), media are plain same-origin URLs, and the Electron-only parts (file
 * watching, the global hotkey, Finder) are no-ops. The Output page runs unchanged on top of it.
 */
import type { AppStatus, LiveStats, MediaChange, OverlayControl, PermissionStatus, SkillcamApi } from '../shared/api'
import { type ConfigResult, parseConfig } from '../shared/config'
import { resolveFromList } from '../shared/media'
import { createOverlayControl } from './overlays'

export interface WebPlatformOptions {
  stage: HTMLElement
  panel: HTMLElement
  /** The model download (see loader.ts); tracking and the media loading wait for it. */
  modelsReady: Promise<void>
  onStats(stats: LiveStats): void
  /** The Output page could not start (no WebGL context, …). */
  onFatal(message: string): void
}

export interface WebPlatform {
  /** Toggles armed, like the app's global hotkey (the page binds K). */
  toggleArmed(): void
  /** Starts mic + speech + clap detection; rejects if the mic or the model fails. */
  startVoice(): Promise<{ clap: boolean }>
  overlays: OverlayControl
}

const base = new URL('./', document.baseURI).href

async function loadConfig(): Promise<ConfigResult> {
  try {
    const res = await fetch(new URL('skillcam.config.json', base))
    if (!res.ok) return { ok: false, error: `skillcam.config.json: HTTP ${res.status}` }
    const result = parseConfig(await res.text())
    if (result.ok) {
      // No BlackHole in a browser: effect sounds play on the speakers. 720p output is plenty for a
      // canvas shown at page size and lighter for laptops without a strong GPU.
      result.config.audio.call.enabled = false
      result.config.video.outputHeight = 720
    }
    return result
  } catch (err) {
    return { ok: false, error: `Cannot load skillcam.config.json: ${(err as Error).message}` }
  }
}

async function permission(name: 'camera' | 'microphone'): Promise<PermissionStatus> {
  try {
    const state = (await navigator.permissions.query({ name: name as PermissionName })).state
    return state === 'prompt' ? 'not-determined' : state
  } catch {
    return 'unknown'
  }
}

export function installWebPlatform(opts: WebPlatformOptions): WebPlatform {
  const config = loadConfig()
  let manifest: Promise<string[]> | null = null
  const statusListeners: ((status: AppStatus) => void)[] = []
  const armListeners: (() => void)[] = []
  let voiceStarter: (() => Promise<{ clap: boolean }>) | null = null
  const overlays = createOverlayControl(() => {
    try {
      return window.localStorage
    } catch {
      return null
    }
  })

  const status = async (): Promise<AppStatus> => ({
    permissions: { camera: await permission('camera'), microphone: await permission('microphone') },
    missingAssets: [],
    hotkey: { accelerator: 'K', registered: true, error: null },
    folder: '',
    browser: true
  })
  // A permission changed in the address bar: tell the panel.
  for (const name of ['camera', 'microphone'] as const) {
    navigator.permissions
      ?.query({ name: name as PermissionName })
      .then((p) => {
        p.onchange = () => void status().then((s) => statusListeners.forEach((cb) => cb(s)))
      })
      .catch(() => {})
  }

  const api: SkillcamApi & { mount: { stage: HTMLElement; panel: HTMLElement } } = {
    platform: 'web',
    getConfig: () => config,
    onConfig: () => {},
    async resolveMedia(entries) {
      // Media load after the tracking models, so the camera and gestures come up first.
      await opts.modelsReady.catch(() => {})
      // A failed fetch isn't kept: the next config apply asks again.
      manifest ??= fetch(new URL('media-manifest.json', base)).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<string[]>
      })
      try {
        return resolveFromList(await manifest, entries)
      } catch (err) {
        manifest = null
        throw new Error(`media-manifest.json: ${(err as Error).message}`)
      }
    },
    getStatus: status,
    showFolder: async () => '',
    onStatus: (cb) => void statusListeners.push(cb),
    onToggleArmed: (cb) => void armListeners.push(cb),
    onMediaChanged: (_cb: (change: MediaChange) => void) => {},
    urls: { assets: base, reactions: new URL('reactions/', base).href, clips: new URL('clips/', base).href },
    mount: { stage: opts.stage, panel: opts.panel },
    modelsReady: opts.modelsReady,
    setVoiceStarter: (start) => (voiceStarter = start),
    stats: opts.onStats,
    fatal: opts.onFatal,
    overlays
  }
  window.skillcam = api

  return {
    overlays,
    toggleArmed: () => armListeners.forEach((cb) => cb()),
    startVoice: () => (voiceStarter ? voiceStarter() : Promise.reject(new Error('Skillcam has not started yet')))
  }
}
