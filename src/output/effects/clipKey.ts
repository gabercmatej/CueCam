import type { EffectConfig } from '../../shared/config'

type ClipConfig = Extract<EffectConfig, { type: 'clip' }>

export interface KeySettings {
  keyColor: string
  similarity: number
  smoothness: number
  spill: number
}

export const DEFAULT_KEY_COLOR = '#00ff00'

/**
 * Whether a clip is chroma-keyed, and how. Alpha WebM carries its own transparency and needs
 * none; a clip is keyed when the config says `"key": true` or names a `keyColor`
 * (`"key": false` always wins).
 */
export function keySettings(cfg: ClipConfig): KeySettings | null {
  if (cfg.key === false || (cfg.key !== true && cfg.keyColor === undefined)) return null
  return { keyColor: cfg.keyColor ?? DEFAULT_KEY_COLOR, similarity: cfg.similarity, smoothness: cfg.smoothness, spill: cfg.spill }
}
