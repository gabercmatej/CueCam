import type { ConfigResult } from './config'

/** What the preload exposes on `window.skillcam`. */
export interface SkillcamApi {
  platform: string
  getConfig(): Promise<ConfigResult>
  onConfig(callback: (result: ConfigResult) => void): void
}
