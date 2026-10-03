import { readFileSync, watch } from 'node:fs'
import { basename, dirname } from 'node:path'
import { type ConfigResult, parseConfig } from '../shared/config'

export function loadConfig(file: string): ConfigResult {
  try {
    return parseConfig(readFileSync(file, 'utf8'))
  } catch (err) {
    return { ok: false, error: `Cannot read ${basename(file)}: ${(err as Error).message}` }
  }
}

/**
 * Calls `onChange` with a freshly parsed config whenever the file is saved. Watches the
 * directory, not the file, because editors often save by replacing the file.
 */
export function watchConfig(file: string, onChange: (result: ConfigResult) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const watcher = watch(dirname(file), (_event, name) => {
    if (name !== basename(file)) return
    clearTimeout(timer)
    timer = setTimeout(() => onChange(loadConfig(file)), 150)
  })
  return () => {
    clearTimeout(timer)
    watcher.close()
  }
}
