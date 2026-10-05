# Web demo

A Chrome/Edge version of Skillcam on GitHub Pages: camera, hand tracking, gestures, every visual effect, the reactions media, light painting, segmentation, and (on request) voice triggers and clap. Live: https://gabercmatej.github.io/skillcam-real-time-gesture-recognition/

It is the same Output page the Electron app runs (`src/output/main.ts`), not a fork. A web adapter stands in for Electron.

## How it fits together

| Electron | Web demo (`src/web/`) |
|---|---|
| Preload (`window.skillcam`, IPC to main) | `platform.ts` installs the same `SkillcamApi` from static files |
| Config read + watched by main | `fetch('skillcam.config.json')`, validated with the same zod schema; call audio forced off, output 720p |
| `media:resolve` lists `reactions/` folders | `media-manifest.json` written at build time; `resolveFromList` applies the same rules |
| `skillcam://media/…`, `skillcam://clips/…` | Plain same-origin URLs (`urls.ts` reads the base from the adapter) |
| Control window (`window.open`) | `ControlPanel.mount()`: the same panel in the page, without preview, call audio, Finder and global hotkey |
| Global hotkey ⇧⌘K | `K` in the tab |
| Mic, speech and clap detector start at launch | Start on "Enable voice & clap" (`setVoiceStarter`; `AudioEngine` with `micOnDemand`) |
| Unmirrored Output (for OBS) | Mirrored (`OUTPUT_VIEW.mirror = true`, everything flips together) |
| — | "What the AI sees" overlays (below), web only |

The optional members of `SkillcamApi` (`urls`, `modelsReady`, `setVoiceStarter`, `stats`, `overlays`, `mount`) are unset in Electron, so the desktop app behaves exactly as before.

## Loading in stages

1. **Start camera** asks for the camera at once, while the tracking models download with a byte-accurate progress bar (`loader.ts`, sizes from `asset-sizes.json`): MediaPipe wasm 11.8 MB + gesture model 8.4 MB + segmenter and face detector 0.5 MB. The worker then gets them from the HTTP cache.
2. The camera picture shows as soon as it is allowed. Tracking starts when the models are in.
3. The reactions media (9 MB) load after the models (`resolveMedia` waits for them), so they don't compete with tracking.
4. Voice only on click: mic permission first, then the 41 MB Vosk model with progress, then the speech worker, the raw mic and the clap detector. Until then Speech shows "Off". Clap needs the sound as well as the camera, so it's off too.

Messages: unsupported browser (non-Chromium, mobile, no WebGL 2 / VideoFrame), camera blocked / missing / busy (with Try again), mic blocked, model download failed, and a "still loading" note after 15 s.

## "What the AI sees" overlays

Toggles in the panel, remembered in localStorage, with shortcuts: **H** hand skeleton (on by default), **M** segmentation mask, **F** face box, **S** stats. Drawn in Pixi on top of the effects, inside the scene (they shake with the picture), from the landmarks predicted for the frame on screen.

- Skeleton: per hand a fixed set of sprites (a soft glow line and a thin core per bone, a dot per landmark), only transforms change per frame, one batched draw. Cyan for your left hand, amber for your right. The live gesture name floats under the wrist; a firing gesture pulses its skeleton for 420 ms.
- Mask: one extra quad sampling the existing mask texture with the person layer's blur and feathered edge, tinted violet.
- Face box: rounded, dashed while the face is held but not seen. Redrawn only when it moves.
- Stats: render fps, gesture → effect latency, quality level, in the stage's corner.

## Build and deploy

- `npm run build:web` (`scripts/build-web.mjs`): Vite with `vite.web.config.ts` (root `src/web`, `base: './'`), then copies only the wasm variant the worker loads (`vision_wasm_module_internal`, not the other two), the three models, the Vosk model, `reactions/` (file names lose `#`, `?` and `%`; static servers disagree on `%23`), `effects/clips/` and the config, and writes the two manifests. It fails if a file is over 100 MB or the site over 1 GB.
- `npm run preview:web` serves `dist-web/` on port 4173.
- `.github/workflows/pages.yml`: on push to `main`: `npm ci` (no Electron binary), cached models, `fetch-assets`, tests, `build:web`, deploy to Pages.

**GitHub Pages checks:** site 78.5 MB (limit 1 GB), largest file 41.2 MB (limit 100 MB), soft bandwidth 100 GB/month (≈1,300 full first visits with voice, ≈3,000 without). Pages serves `.tar.gz` as `application/gzip` with no `Content-Encoding` (checked on vosk-browser's own Pages demo), so Vosk gets the archive as-is. `.wasm` is served as `application/wasm`. No COOP/COEP needed (no wasm threads).

## Polish not done yet

- Split vosk-browser (6.2 MB raw, 2.5 MB gzipped, mostly its inlined wasm) out of the main chunk so it loads only with voice.
- Placeholders for media while they load; a "loading effects" chip.
- Own or licensed reaction media for the public site (the current ones are third-party placeholders).
- Mobile layout and a phone-friendly lite mode; Safari/Firefox once they support VideoFrame transfer and worker WebGL.
- Echo: default effect sounds lower, or a headphones prompt when voice turns on.
- An impeccable design pass on the page (onboarding, empty states, motion).
