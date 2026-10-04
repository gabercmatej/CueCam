/** reactions/ on disk: resolving config paths (files or folders) to media files, safely inside the folder. */
import { readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { isMediaFile } from '../shared/media'

/** `rel` resolved inside `root`, or null if it would escape it. */
export function insideRoot(root: string, rel: string): string | null {
  const file = resolve(root, rel)
  return file.startsWith(root + sep) ? file : null
}

/**
 * Each config entry → the media files it means, as paths relative to `root` with "/" separators:
 * a file is itself, a folder is every media file directly in it (sorted, hidden files skipped), and
 * anything missing or outside `root` is an empty list (the renderer shows a placeholder).
 */
export function resolveMedia(root: string, entries: readonly string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const entry of entries) {
    const path = insideRoot(root, entry)
    out[entry] = []
    if (!path) continue
    try {
      const st = statSync(path)
      if (st.isFile()) {
        if (isMediaFile(path)) out[entry] = [toRel(root, path)]
      } else if (st.isDirectory()) {
        out[entry] = readdirSync(path)
          .filter((name) => !name.startsWith('.') && isMediaFile(name))
          .sort()
          .map((name) => toRel(root, join(path, name)))
      }
    } catch {
      // Missing: stays empty.
    }
  }
  return out
}

const toRel = (root: string, path: string): string => relative(root, path).split(sep).join('/')
