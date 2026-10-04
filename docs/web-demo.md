# Web demo: readiness assessment

Assessment only (Phase 5); nothing here is built. Goal: a browser demo on Vercel or Netlify. Camera in Chrome, gestures + voice triggers + effects including the reactions media. No OBS, BlackHole or hotkey.

## Verdict

Most of the app is already browser code. The Output page (camera, perception worker, speech worker, trigger engine, effects, PixiJS stage, Web Audio) runs in Chromium today and uses only web APIs. Electron reaches into it through two narrow seams: `window.skillcam` (8 calls) and the `skillcam://` URL scheme (2 places). Replace those with a web adapter, move the Control window into the page, and add a loading screen. **Estimate: 3–4 focused days** (≈ 5–7 evenings).

## What runs as-is

| Part | Notes |
|---|---|
| Camera (`getUserMedia`, 1080p30) | Same API. Needs HTTPS (every host provides it) and a click before the permission prompt. |
| Perception worker (MediaPipe hands, segmentation, face; GPU delegate) | Module worker + transferred `VideoFrame` + WebGL in the worker. Chrome/Edge yes. Safari and Firefox are untested and likely to break (VideoFrame transfer, WebGL in workers). Target Chromium only. |
| Speech (vosk-browser worker) | Same. It caches the extracted model in IndexedDB, so the 39 MB download happens once per browser. |
| Clap detector, mic capture (AudioWorklets) | Same. |
| Trigger engine, gestures, config schema (zod) | Pure TypeScript. |
| Effects, PixiJS stage, shaders, chroma key | Same. |
| Media playback (images, GIFs, video, sound) | Same once URLs point at static files (see below). |
| Effect audio output | `AudioContext.setSinkId` exists in Chrome. Call routing simply stays off (`audio.call.enabled: false`), and effects play on the speakers. |
| CSP | Same policy, as a header. `'unsafe-eval'` + `blob:` are still needed by vosk-browser. |

## Electron-only parts and their browser replacement

| Electron part | Where | Browser replacement | Effort |
|---|---|---|---|
| `window.skillcam.getConfig / onConfig` | `src/output/main.ts` | `fetch('skillcam.config.json')`. No hot reload (or a "reload" button). | S |
| `resolveMedia` (main lists folders on disk) | `src/output/effects/media.ts` | A `media-manifest.json` generated at build time (folder → files), with the same `resolveMedia` result shape. | S |
| `skillcam://media/…`, `skillcam://clips/…` URLs | `media.ts`, `clip.ts` | A base URL from the adapter: `/reactions/…`, `/clips/…` (same origin, so no CORS needed). | S |
| `getStatus / onStatus` (permissions, missing models, hotkey) | `main.ts`, `control/health.ts` | A static status: permissions from `navigator.permissions.query`, no hotkey. | S |
| `onToggleArmed` (global hotkey) | `main.ts` | Drop it, or use a key in the page (Space). | XS |
| `onMediaChanged` (file watching) | `main.ts` | No-op. | XS |
| `showFolder` | panel | Hidden on the web. | XS |
| Control window (`window.open('about:blank')` at startup) | `control/panel.ts` | **Popup blockers stop a `window.open` without a click, and two windows are odd in a demo.** Mount the same panel DOM in a side drawer of the page instead. The panel builds its DOM into whatever document it's given, so this is mostly layout. The mirrored preview is redundant there (the canvas is right next to it). | M |
| Main-process: window sizing for OBS, `disable-backgrounding` switches, App Nap blocker, network filter, permission handler | `src/main/index.ts` | Not needed. A hidden tab throttles rendering, which is fine for a demo. The network filter becomes the CSP's `connect-src 'self'`. | — |

A clean way to do it: a `Platform` interface with the same shape as `SkillcamApi`, with an `electron` implementation (the preload, as now) and a `web` one. Plus a second Vite entry (`web/index.html`) that sets up the web platform, shows a start button and mounts the panel in-page. The desktop app stays exactly as it is.

## Hosting requirements

- **No COOP/COEP needed.** Neither MediaPipe's `vision_wasm_module_internal` build nor vosk-browser uses WASM threads/`SharedArrayBuffer`. The Electron app has never been cross-origin isolated, and everything runs. So no special headers, and no cross-origin isolation problems with media.
- **HTTPS**: required for camera and mic. Vercel and Netlify both provide it.
- **MIME types**: `.wasm` must be served as `application/wasm` (both hosts do). Serve `.tar.gz` as-is, without on-the-fly re-compression or `Content-Encoding: gzip`, or vosk-browser receives an already-decompressed tar.
- **Caching**: long `Cache-Control: immutable` for models, wasm and hashed JS. Version model filenames when they change.
- **Per-file and bandwidth limits**: the largest file is the Vosk model (39 MB). Check the host's current static-file size limit and monthly bandwidth on the free plan. At ~70 MB per first visit, a few thousand first visits a month already add up to hundreds of GB.

## Download size on first visit

| File | Size | Needed for |
|---|---|---|
| Vosk small English model (`.tar.gz`) | 39 MB | voice triggers |
| MediaPipe wasm (`vision_wasm_module_internal`, one variant only) | 11.3 MB | all tracking |
| Gesture recognizer model | 8.0 MB | hands |
| Selfie segmenter + face detector | 0.5 MB | behind-you effects, face anchor |
| App JS (gzipped) | 2.6 MB (6.9 MB raw, mostly vosk-browser's inlined wasm) | everything |
| `reactions/` media | 8.9 MB | effects (can load lazily) |
| **Total** | **≈ 70 MB** | |

Only one of MediaPipe's three wasm variants is loaded (`_module_internal`). The other two (21 MB) must be left out of the web build.

**Load time:** ≈ 6 s at 100 Mbit/s, ≈ 12 s at 50, ≈ 1 min at 10. Repeat visits come from the cache. To make the first visit feel fast:
1. Start camera + hand tracking first (≈ 20 MB). Gestures work after a few seconds.
2. Load the Vosk model in the background, with a "voice triggers loading…" chip (they are optional in the demo).
3. Load reactions lazily, on first trigger, or after tracking is up.
4. Show a progress bar per stage. vosk-browser's download can't report progress, so fetch the file ourselves and hand it a blob URL.

## Effort estimate

| Task | Days |
|---|---|
| Platform adapter + web implementation (config, media manifest, URLs, status) | 0.5 |
| Second Vite entry + build script (manifest generation, asset subset, headers file) | 0.5 |
| In-page control drawer (reuse `ControlPanel`), start button/permission flow | 1 |
| Loading screen with staged loading and progress | 0.5 |
| Chrome/Edge testing (perf, a laptop without a GPU), mobile "not supported" message | 0.5–1 |
| Deploy (Vercel or Netlify), caching headers, README link | 0.25 |
| **Total** | **≈ 3–4 days** |

## Risks

- **Rights to the reactions media**: on a public website the third-party memes and stock clips are more exposed than in a repo. Use your own or clearly licensed clips for the demo.
- **Speaker → mic echo**: without headphones, effect sounds and the demo's own audio can reach the mic and trigger words. Default to muted effect sounds or a "use headphones" hint.
- **Weaker machines**: the adaptive quality controller already handles this, but a laptop without a dedicated GPU in a browser tab is untested.
- **Browsers other than Chromium**: show a message instead of a broken page.
