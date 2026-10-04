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

export const CORNERS = ['auto', 'top-left', 'top-right', 'bottom-left', 'bottom-right'] as const
export type Corner = (typeof CORNERS)[number]

const Anchor = z.enum(ANCHORS)
const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a #rrggbb colour')
const Volume = z.number().min(0).max(1)

/**
 * A path inside reactions/ ("thumbs up/cat.png"), or a folder there ("thumbs up"): a folder means
 * every media file in it, and one is picked at random each time (never the same twice in a row).
 */
const MediaPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/') && !p.split(/[\\/]/).includes('..'), 'must be a path inside reactions/ (no "..", not absolute)')
const MediaFiles = z.union([MediaPath, z.array(MediaPath).min(1)]).transform((f) => (Array.isArray(f) ? f : [f]))

/** Chroma key for green-screen video. Absent = detected from the clip's first frame (a green border means keyed). */
const KeyOptions = {
  key: z.boolean().optional(),
  keyColor: HexColor.optional(),
  /** Colours within this chroma distance of the key become transparent (0–1, OBS-like). Default: from the key colour (≤ 0.4). */
  similarity: z.number().min(0).max(1).optional(),
  /** Width of the soft edge above `similarity`. */
  smoothness: z.number().min(0).max(1).default(0.08),
  /** How strongly the key colour's spill on the subject is removed (0–1). */
  spill: z.number().min(0).max(1).default(0.6)
}

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

/** Images (png/jpg/webp), GIFs, WebM (with alpha) and MP4 (green screen) from reactions/. */
const MediaEffect = z.object({
  type: z.literal('media'),
  files: MediaFiles,
  /**
   * corner: a reaction card in a corner (pops in, holds, fades; several stack);
   * anchor: placed at `anchor` (and with `follow`, tracks the hand that triggered it);
   * fullscreen: covers the whole frame.
   */
  placement: z.enum(['corner', 'anchor', 'fullscreen']).default('corner'),
  /** Corner placement: which corner. auto = the one farthest from your face. */
  corner: z.enum(CORNERS).default('auto'),
  anchor: Anchor.default('center'),
  layer: z.enum(['back', 'front']).default('front'),
  /** Corner: the card's longest side ÷ frame height (default 0.3). Anchor: height ÷ frame height (default 1). */
  size: z.number().positive().max(4).optional(),
  /** Anchor "hand": keep following the hand that triggered it (predicted every frame). */
  follow: z.boolean().default(false),
  /** Size by the hand instead: height = handScale × hand size (wrist to middle knuckle). */
  handScale: z.number().positive().max(40).optional(),
  /** The point of the media (0–1, from its top left) that sits on the anchor. Default: the anchor's natural alignment. */
  origin: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).optional(),
  /** Use only this part of the source: [x, y, width, height] as fractions (e.g. a small fireball in a wide clip). */
  crop: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().gt(0).max(1), z.number().gt(0).max(1)]).optional(),
  /** How long it stays. Default: 2.5 s for images and GIFs, the clip's length for video. */
  holdMs: z.number().int().positive().max(60_000).optional(),
  /** Fade-out at the end. */
  fadeMs: z.number().int().nonnegative().max(5000).default(250),
  /** Video sound: per-effect volume and mute (video clips only; images are silent). */
  volume: Volume.default(1),
  muted: z.boolean().default(false),
  ...KeyOptions
})

/** A sound effect (mp3/wav/ogg/m4a) from reactions/; a folder picks one at random. */
const SoundEffect = z.object({
  type: z.literal('sound'),
  files: MediaFiles,
  volume: Volume.default(1),
  muted: z.boolean().default(false)
})

/** Light painting: draws a glowing line at the pinch point while the triggering hand stays pinched; release clears it. */
const LightPaintEffect = z.object({
  type: z.literal('lightPaint'),
  /** "rainbow" cycles the hue along the stroke. */
  color: z.union([z.literal('rainbow'), HexColor]).default('rainbow'),
  /** Line width in stage px (1280×720 units). */
  width: z.number().positive().max(80).default(14),
  /** How fast the drawing fades out after release. */
  fadeMs: z.number().int().nonnegative().max(5000).default(300)
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
  fadeMs: z.number().int().nonnegative().max(5000).default(250),
  /** Grade: colour only the camera, or everything (camera and effects). */
  gradeScope: z.enum(['camera', 'all']).default('all')
})

const Effect = z.discriminatedUnion('type', [ParticlesEffect, ClipEffect, MediaEffect, SoundEffect, LightPaintEffect, CameraMoveEffect])

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
  cooldownMs: z.number().int().nonnegative().optional(),
  /** Gesture rules: a separate cooldown per hand (two fists at once fire twice). */
  perHand: z.boolean().default(false),
  /**
   * Word rules: "partial" fires from Vosk's partial result (fast, ~0–300 ms after the word); "final" waits
   * for the final result (~0.5–1 s after you stop talking) and needs `minConfidence`, so speech that only
   * briefly looked like the word never fires it.
   */
  confirm: z.enum(['partial', 'final']).default('partial'),
  /** Word rules with `confirm: "final"`: the lowest per-word confidence (0–1) that still fires. */
  minConfidence: z.number().min(0).max(1).default(0.9),
  /**
   * Word rules with `confirm: "final"`: the word must end the phrase, i.e. be the last word of the
   * utterance or be followed by at least this much silence. "bye" fires, "by tomorrow" doesn't.
   */
  pauseAfterMs: z.number().int().min(0).max(5000).optional()
})

/** Sending your voice + effect sounds into a call through a virtual device (docs/audio-setup.md). */
const Call = z.object({
  /** Send the mix to `device`. The Control window's switch overrides it until this value changes. */
  enabled: z.boolean().default(true),
  /** The virtual device's output, by part of its name. Missing = no call audio, effects play locally. */
  device: z.string().min(1).default('BlackHole'),
  /** Your voice's level in the mix (1 = unchanged). */
  micVolume: z.number().min(0).max(2).default(1),
  /** While sending: hear the effect sounds yourself, on `audio.device` (never your own voice). */
  monitor: z.boolean().default(true),
  monitorVolume: Volume.default(0.3)
})

const Audio = z.object({
  /** Master volume for every effect sound. */
  volume: Volume.default(1),
  muted: z.boolean().default(false),
  /** Your local output (and the monitor while sending to a call): part of its name. Default: the system output. */
  device: z.string().min(1).optional(),
  call: Call.prefault({})
})

/**
 * Clap = hands meeting fast (camera) AND a clap-like sound on the raw mic, within `windowMs`.
 * The sound thresholds are shown live in the Control window for tuning (see audio/clapOnset.ts).
 */
const Clap = z.object({
  windowMs: z.number().int().min(20).max(500).default(150),
  /** false = the camera alone fires Clap (no sound needed). */
  requireSound: z.boolean().default(true),
  /** Bright band (above 2 kHz) rising this many dB over the previous ~30 ms, within ~3 ms. */
  minRiseDb: z.number().min(3).max(60).default(15),
  /** Bright-band peak, dBFS. Raise it if soft touches count; lower it if real claps don't. */
  minLevelDb: z.number().min(-90).max(0).default(-38),
  /** Share of the peak's energy above 2 kHz (voice is mostly below). */
  minBrightness: z.number().min(0).max(1).default(0.3),
  /** The sound must fall `decayDb` below its peak within this long. */
  maxDurationMs: z.number().int().min(10).max(500).default(80),
  decayDb: z.number().min(3).max(40).default(12)
})

const Speech = z.object({
  /**
   * Add decoy words (common English, plus words that sound like each trigger) to the recognizer's
   * grammar, so ordinary speech lands on them instead of on the nearest trigger word.
   */
  decoys: z.boolean().default(true)
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
    audio: Audio.prefault({}),
    speech: Speech.prefault({}),
    clap: Clap.prefault({}),
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
      if (rule.pauseAfterMs !== undefined && !(rule.when.word && !rule.when.gesture && rule.confirm === 'final')) {
        ctx.addIssue({ code: 'custom', path: ['rules', i, 'pauseAfterMs'], message: 'pauseAfterMs needs a word rule (no gesture) with "confirm": "final"' })
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
