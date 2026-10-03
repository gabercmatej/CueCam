/** skillcam.config.json schema (BUILD_PLAN §6). Validated in main; the renderer receives the parsed result. */
import { z } from 'zod'
import { GESTURES } from './types'

export const ANCHORS = [
  'hand',
  'between-hands',
  'bottom-corners',
  'center',
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
  'bottom-center'
] as const
export type Anchor = (typeof ANCHORS)[number]

export const PARTICLE_PRESETS = ['confetti', 'hearts', 'sparks'] as const
export type ParticlePreset = (typeof PARTICLE_PRESETS)[number]

const Anchor = z.enum(ANCHORS)

const ParticlesEffect = z.object({
  type: z.literal('particles'),
  preset: z.enum(PARTICLE_PRESETS),
  anchor: Anchor.default('hand'),
  count: z.number().int().min(1).max(1500).default(100)
})

const ClipEffect = z.object({
  type: z.literal('clip'),
  /** A file name inside effects/clips/ (no paths). */
  file: z.string().regex(/^\w[\w.-]*\.(webm|mp4)$/, 'must be a .webm or .mp4 file name inside effects/clips/'),
  layer: z.enum(['back', 'front']).default('back'),
  anchor: Anchor.default('center'),
  /** Clip height as a fraction of the frame height. */
  scale: z.number().positive().max(4).default(1)
})

const CameraMoveEffect = z.object({
  type: z.literal('cameraMove'),
  kind: z.enum(['shake', 'zoom']),
  /** Shake strength, 0–1. */
  intensity: z.number().min(0).max(1).default(0.6),
  durationMs: z.number().int().positive().max(10_000).default(600),
  /** Zoom factor at the peak. */
  amount: z.number().min(1).max(4).default(1.4),
  /** Zoom focus. */
  target: z.enum(['hand', 'center']).default('hand')
})

const Effect = z.discriminatedUnion('type', [ParticlesEffect, ClipEffect, CameraMoveEffect])

const Rule = z.object({
  when: z
    .object({
      gesture: z.enum(GESTURES).optional(),
      word: z.string().min(1).optional(),
      /** For combos (gesture + word): both must happen within this window, in either order. */
      withinMs: z.number().int().positive().optional()
    })
    .refine((w) => w.gesture || w.word, 'a rule needs a gesture, a word, or both'),
  play: z.union([z.string(), z.array(z.string()).min(1)]).transform((p) => (Array.isArray(p) ? p : [p])),
  cooldownMs: z.number().int().nonnegative().optional()
})

export const ConfigSchema = z
  .object({
    hotkey: z.string().default('CommandOrControl+Shift+K'),
    defaultCooldownMs: z.number().int().nonnegative().default(2000),
    words: z.array(z.string().min(1)).min(1),
    rules: z.array(Rule),
    effects: z.record(z.string(), Effect)
  })
  .superRefine((cfg, ctx) => {
    const words = new Set(cfg.words.map((w) => w.trim().toLowerCase()))
    cfg.rules.forEach((rule, i) => {
      for (const name of rule.play) {
        if (!(name in cfg.effects)) ctx.addIssue({ code: 'custom', path: ['rules', i, 'play'], message: `unknown effect "${name}"` })
      }
      const word = rule.when.word?.trim().toLowerCase()
      if (word && !words.has(word)) {
        ctx.addIssue({ code: 'custom', path: ['rules', i, 'when', 'word'], message: `"${rule.when.word}" is not in "words"` })
      }
    })
  })
  .transform((cfg) => ({
    ...cfg,
    rules: cfg.rules.map((r) => ({
      ...r,
      when: r.when.gesture && r.when.word ? { ...r.when, withinMs: r.when.withinMs ?? 1500 } : r.when
    }))
  }))

export type Config = z.output<typeof ConfigSchema>
export type EffectConfig = Config['effects'][string]
export type RuleConfig = Config['rules'][number]

/** `error` on an ok result: the file on disk is invalid and this is the last good config. */
export type ConfigResult = { ok: true; config: Config; error?: string } | { ok: false; error: string }

export function parseConfig(text: string): ConfigResult {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${(err as Error).message}` }
  }
  const result = ConfigSchema.safeParse(json)
  return result.success ? { ok: true, config: result.data } : { ok: false, error: z.prettifyError(result.error) }
}
