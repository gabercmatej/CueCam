import type { ConfigResult } from '../shared/config'

/**
 * Main's view of the config: the last good one wins, and the latest error rides along,
 * so a window that loads after a bad save still gets working rules.
 */
export class ConfigState {
  private lastGood: Extract<ConfigResult, { ok: true }>['config'] | null = null
  private error: string | null = null

  update(result: ConfigResult): void {
    if (result.ok) {
      this.lastGood = result.config
      this.error = null
    } else {
      this.error = result.error
    }
  }

  get current(): ConfigResult {
    if (!this.lastGood) return { ok: false, error: this.error ?? 'no config loaded' }
    return this.error ? { ok: true, config: this.lastGood, error: this.error } : { ok: true, config: this.lastGood }
  }
}
