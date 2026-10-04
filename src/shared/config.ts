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
  'bottom-center',
  'face'
] as const
export type Anchor = (typeof ANCHORS)[number]

export const PARTICLE_PRESETS = ['confetti', 'hearts', 'sparks'] as const
export type ParticlePreset = (typeof PARTICLE_PRESETS)[number]

const Anchor = z.enum(ANCHORS)
const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a #rrggbb colour')

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
  scale: z.number().positive().max(4).default(1),
  /**
   * Chroma key for green-screen clips. Alpha WebM needs none. A clip is keyed when `key` is true or a
   * `keyColor` is given.
   */
  key: z.boolean().optional(),
  keyColor: HexColor.optional(),
  /** Colours within this chroma distance of the key become transparent (0–1, OBS-like). */
  similarity: z.number().min(0).max(1).default(0.4),
  /** Width of the soft edge above `similarity`. */
  smoothness: z.number().min(0).max(1).default(0.08),
  /** How strongly the key colour's spill on the subject is removed (0–1). */
  spill: z.number().min(0).max(1).default(0.6)
})

const CameraMoveEffect = z.object({
  type: z.literal('cameraMove'),
  /** shake and zoom move the scene; grade colours the camera (saturation, tint) and darkens the edges (vignette). */
  kind: z.enum(['shake', 'zoom', 'grade']),
  /** Shake strength, 0–1. */
  intensity: z.number().min(0).max(1).default(0.6),
  durationMs: z.number().int().positive().max(10_000).default(600),
  /** Zoom factor at the peak. */
  amount: z.number().min(1).max(4).default(1.4),
  /** Zoom focus. */
  target: z.enum(['hand', 'center', 'face']).default('hand'),
  /** Grade: camera saturation at full strength (0 = black and white, 1 = unchanged). */
  saturation: z.number().min(0).max(2).default(1),
  /** Grade: tint colour and how much of it is mixed in (0 = none). */
  tint: HexColor.default('#ffb340'),
  tintAmount: z.number().min(0).max(1).default(0),
  /** Grade: vignette strength (0 = none, 1 = edges almost black). */
  vignette: z.number().min(0).max(1).default(0),
  /** Grade: fade-in and fade-out time. */
  fadeMs: z.number().int().nonnegative().max(5000).default(250)
})

const Effect = z.discriminatedUnion('type', [ParticlesEffect, ClipEffect, CameraMoveEffect])

const Rule = z.object({
  when: z
    .object({
      gesture: z.enum(GESTURES).optional(),
      word: z.string().min(1).optional(),
      /** For combos (gesture + word): both must happen within this window, in either order. */
      withinMs: z.number().int().positive().max(10_000).optional()
    })
    .refine((w) => w.gesture || w.word, 'a rule needs a gesture, a word, or both'),
  play: z.union([z.string(), z.array(z.string()).min(1)]).transform((p) => (Array.isArray(p) ? p : [p])),
  cooldownMs: z.number().int().nonnegative().optional()
})

const Performance = z.object({
  /** Run hand tracking on every Nth camera frame (1 = every frame). Adaptive quality may raise it under load, never lower it. */
  trackEvery: z.number().int().min(1).max(4).default(2),
  /** Under load, track less often, lower particle counts and cap the render rate; recover when load falls. */
  adaptive: z.boolean().default(true),
  /** Hand-tracking backend. GPU shares the GPU with rendering and the call; CPU (XNNPACK) uses spare cores. Read at startup. */
  trackerDelegate: z.enum(['GPU', 'CPU']).default('GPU'),
  /** Person segmentation (back FX render behind you). Off = back FX sit over the whole camera. */
  segmentation: z.boolean().default(true),
  /** Run segmentation on every Nth camera frame. Adaptive quality may raise it under load. */
  segmentEvery: z.number().int().min(1).max(6).default(2),
  /** Backend for segmentation and face detection. Read at startup. */
  segmentDelegate: z.enum(['GPU', 'CPU']).default('GPU'),
  /** Face detection (~10 fps) for the "face" anchor. */
  faceDetection: z.boolean().default(true),
  /** 1 = hands, segmentation and face share one worker; 2 = hands in one, segmentation + face in another. Read at startup. */
  perceptionWorkers: z.union([z.literal(1), z.literal(2)]).default(1)
})

const Video = z.object({
  /** Camera to use: part of its name (e.g. "MacBook", "iPhone"). Default: the first camera that isn't virtual (never OBS's own). */
  camera: z.string().min(1).optional(),
  /** Output resolution (16:9) in real pixels. Read at startup. */
  outputHeight: z.union([z.literal(1080), z.literal(720)]).default(1080)
})

export const ConfigSchema = z
  .object({
    hotkey: z.string().default('CommandOrControl+Shift+K'),
    performance: Performance.prefault({}),
    video: Video.prefault({}),
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
