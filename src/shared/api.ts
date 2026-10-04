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
}
