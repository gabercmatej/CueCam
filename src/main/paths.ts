/**
 * Where the app finds its files. In dev everything is in the project folder, as before. A packaged
 * app keeps the things you edit (config, reactions/, effects/clips/) in a user folder, created on
 * first run from defaults bundled in the app; the models stay inside the app.
 */
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface AppPaths {
  /** The folder holding the config and media (the project folder in dev). */
  folder: string
  config: string
  reactions: string
  clips: string
  /** Model and wasm files (assets/ in dev, the built renderer in the app). */
  assets: string
}

export function pathsIn(folder: string, assets: string): AppPaths {
  return {
    folder,
    config: join(folder, 'skillcam.config.json'),
    reactions: join(folder, 'reactions'),
    clips: join(folder, 'effects', 'clips'),
    assets
  }
}

/**
 * Copies each default (config, reactions/, effects/clips/) from `defaults` into `paths` if it isn't
 * there yet. Never overwrites: what you edited stays. Deleting one of the three restores its default
 * on the next launch. Each is copied to a temporary name and renamed into place, so an interrupted
 * copy never leaves a half-filled folder that counts as present. Returns what was copied and what failed.
 */
export function seedUserFolder(paths: AppPaths, defaults: AppPaths): { copied: string[]; failed: string[] } {
  mkdirSync(paths.folder, { recursive: true })
  const copied: string[] = []
  const failed: string[] = []
  for (const [key, name] of [
    ['config', 'skillcam.config.json'],
    ['reactions', 'reactions'],
    ['clips', 'effects/clips']
  ] as const) {
    if (existsSync(paths[key]) || !existsSync(defaults[key])) continue
    const temp = `${paths[key]}.seeding`
    try {
      rmSync(temp, { recursive: true, force: true })
      mkdirSync(dirname(paths[key]), { recursive: true })
      cpSync(defaults[key], temp, { recursive: true })
      renameSync(temp, paths[key])
      copied.push(name)
    } catch (err) {
      rmSync(temp, { recursive: true, force: true })
      failed.push(`${name}: ${(err as Error).message}`)
    }
  }
  return { copied, failed }
}
