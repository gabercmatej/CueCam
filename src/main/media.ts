/** reactions/ on disk: resolving config paths (files or folders) to media files, safely inside the folder. */
import { type FSWatcher, readdirSync, statSync, watch } from 'node:fs'
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

/**
 * Calls `onChange` with the paths (relative, "/" separators) that changed under `root`, batched
 * over `debounceMs` (a copy or an editor save fires several events). Recursive: folders inside
 * `root` count. A missing `root` is watched never (returns a no-op).
 */
export function watchMedia(root: string, onChange: (paths: string[]) => void, debounceMs = 300): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const changed = new Set<string>()
  let watcher: FSWatcher
  try {
    watcher = watch(root, { recursive: true }, (_event, name) => {
      if (!name) return
      const rel = String(name).split(sep).join('/')
      if (rel.split('/').some((part) => part.startsWith('.'))) return
      changed.add(rel)
      clearTimeout(timer)
      timer = setTimeout(() => {
        const paths = [...changed]
        changed.clear()
        onChange(paths)
      }, debounceMs)
    })
  } catch (err) {
    console.warn(`[media] not watching ${root}: ${(err as Error).message}`)
    return () => {}
  }
  // E.g. the folder itself deleted or renamed: stop watching instead of crashing main.
  watcher.on('error', (err) => {
    console.warn(`[media] stopped watching ${root}: ${err.message}`)
    watcher.close()
  })
  return () => {
    clearTimeout(timer)
    watcher.close()
  }
}
