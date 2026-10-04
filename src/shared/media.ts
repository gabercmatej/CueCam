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

/** skillcam://media/… URL for a path inside reactions/ (each segment encoded: names have spaces, #, parentheses). */
export const mediaUrl = (path: string): string => `skillcam://media/${path.split('/').map(encodeURIComponent).join('/')}`
