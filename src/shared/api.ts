import type { ConfigResult } from './config'

/** What the preload exposes on `window.skillcam`. */
export interface SkillcamApi {
  platform: string
  getConfig(): Promise<ConfigResult>
  onConfig(callback: (result: ConfigResult) => void): void
  /** Config media paths (files or folders inside reactions/) → the files each one means (empty = missing). */
  resolveMedia(entries: string[]): Promise<Record<string, string[]>>
}
