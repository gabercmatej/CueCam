/** Media file kinds by extension (reactions/). */
export type MediaKind = 'image' | 'gif' | 'video' | 'audio'

const KINDS: Record<string, MediaKind> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'gif',
  webm: 'video',
  mp4: 'video',
  m4v: 'video',
  mov: 'video',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  m4a: 'audio',
  aac: 'audio'
}

export function mediaKind(path: string): MediaKind | null {
  const dot = path.lastIndexOf('.')
  return dot < 0 ? null : (KINDS[path.slice(dot + 1).toLowerCase()] ?? null)
}

export const isMediaFile = (path: string): boolean => mediaKind(path) !== null

/**
 * URL for a path inside reactions/ (each segment encoded: names have spaces, #, parentheses). The
 * Electron app serves them as skillcam://media/…; the web demo passes its own base.
 */
export const mediaUrl = (path: string, base = 'skillcam://media/'): string => `${base}${path.split('/').map(encodeURIComponent).join('/')}`

/**
 * Config entries → media files, from a list of every file in reactions/ (the web demo's build-time
 * manifest), with the same rules as the app's folder listing: a file is itself, a folder is every
 * media file directly in it (sorted, hidden files skipped), anything else is an empty list.
 */
export function resolveFromList(files: readonly string[], entries: readonly string[]): Record<string, string[]> {
  const all = new Set(files)
  const out: Record<string, string[]> = {}
  for (const raw of entries) {
    const entry = raw.replace(/\/+$/, '')
    if (all.has(entry)) {
      out[raw] = isMediaFile(entry) ? [entry] : []
      continue
    }
    const prefix = `${entry}/`
    out[raw] = files
      .filter((f) => f.startsWith(prefix) && !f.slice(prefix.length).includes('/'))
      .filter((f) => !f.slice(prefix.length).startsWith('.') && isMediaFile(f))
      .sort()
  }
  return out
}
