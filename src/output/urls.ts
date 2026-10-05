/**
 * Where the Output page finds its files. The Electron app serves models from the renderer root (one
 * level above output/index.html) and media over skillcam://; the web demo's adapter sets plain URLs
 * (window.skillcam.urls). Read at call time, so importing this never touches `window` (unit tests).
 */
import { mediaUrl } from '../shared/media'

const urls = (): { assets: string; reactions: string; clips: string } | undefined =>
  (globalThis as { window?: Window }).window?.skillcam?.urls

/** Absolute URL of a file under the models/wasm root (mediapipe/…, vosk/…). */
export const assetUrl = (path: string): string => new URL(path, urls()?.assets ?? new URL('../', document.baseURI)).href

/** URL of a file inside reactions/. */
export const reactionUrl = (path: string): string => mediaUrl(path, urls()?.reactions)

/** URL of a file inside effects/clips/. */
export const clipUrl = (file: string): string => `${urls()?.clips ?? 'skillcam://clips/'}${encodeURIComponent(file)}`

/** The web demo, not the Electron app (for wording in messages). */
export const inBrowser = (): boolean => (globalThis as { window?: Window }).window?.skillcam?.platform === 'web'
