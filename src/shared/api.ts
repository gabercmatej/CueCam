import type { ConfigResult } from './config'

/** macOS media permission, as systemPreferences.getMediaAccessStatus reports it ('unknown' elsewhere). */
export type PermissionStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'

export interface HotkeyStatus {
  accelerator: string
  /** False when another app owns the shortcut or the accelerator is invalid (see `error`). */
  registered: boolean
  error: string | null
}

/** What main knows about the app's health: the renderer shows it in the Control window. */
export interface AppStatus {
  permissions: { camera: PermissionStatus; microphone: PermissionStatus }
  /** Required model files missing from assets/ (relative paths). */
  missingAssets: string[]
  hotkey: HotkeyStatus
  /** The folder with skillcam.config.json, reactions/ and effects/clips/ (the project folder in dev). */
  folder: string
  /** Running in a browser tab (the web demo), not the Electron app: messages say so. */
  browser?: boolean
}

/** Once per stats tick (250 ms): the numbers the web demo shows next to the stage. */
export interface LiveStats {
  renderFps: number
  cameraFps: number
  trackFps: number
  /** Adaptive quality level, 0 (best) … 4. */
  quality: number
  /** Mean gesture → effect latency over the last firings (ms), 0 before the first one. */
  gestureLatencyMs: number
  /** Main-thread work per rendered frame (ms, rolling mean): updates + Pixi's CPU side. */
  mainWorkMs: number
}

/** The web demo's "What the AI sees" overlays, drawn over the effects. */
export type OverlayName = 'hands' | 'mask' | 'face' | 'stats'

export interface OverlayControl {
  readonly state: Readonly<Record<OverlayName, boolean>>
  set(name: OverlayName, on: boolean): void
  /** Called after any change (a switch, a shortcut). */
  onChange(callback: () => void): void
}

/** Files that changed on disk under a media folder (paths relative to it, "/" separators). */
export interface MediaChange {
  root: 'reactions' | 'clips'
  paths: string[]
}

/** What the preload exposes on `window.skillcam`. */
export interface SkillcamApi {
  platform: string
  getConfig(): Promise<ConfigResult>
  onConfig(callback: (result: ConfigResult) => void): void
  /** Config media paths (files or folders inside reactions/) → the files each one means (empty = missing). */
  resolveMedia(entries: string[]): Promise<Record<string, string[]>>
  getStatus(): Promise<AppStatus>
  /** Opens the config/reactions folder in Finder. */
  showFolder(): Promise<string>
  onStatus(callback: (status: AppStatus) => void): void
  /** The global arm/disarm hotkey was pressed. */
  onToggleArmed(callback: () => void): void
  /** Files were added, replaced or removed in reactions/ or effects/clips/. */
  onMediaChanged(callback: (change: MediaChange) => void): void

  // Optional: only the web demo's adapter (src/web/platform.ts) sets these. Unset = the Electron app.
  /** Base URLs (ending in "/") for models/wasm, reactions/ and effects/clips/. */
  urls?: { assets: string; reactions: string; clips: string }
  /** Resolves once the model files are downloaded (cached): tracking starts after it. */
  modelsReady?: Promise<void>
  /**
   * Mic, speech and the clap detector start only on request: the Output page hands over the starter.
   * It rejects if speech fails; `clap` is false if only the clap detector failed (calling again retries).
   */
  setVoiceStarter?(start: () => Promise<{ clap: boolean }>): void
  /** The Output page failed to start at all (the web page shows it; Electron logs it as before). */
  fatal?(message: string): void
  /** Live numbers for the page around the stage. */
  stats?(stats: LiveStats): void
  /** "What the AI sees" overlays (web only: the desktop Output never draws them). */
  overlays?: OverlayControl
}
