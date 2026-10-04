import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pathsIn, seedUserFolder } from './paths'

function bundled(): string {
  const root = mkdtempSync(join(tmpdir(), 'skillcam-defaults-'))
  writeFileSync(join(root, 'skillcam.config.json'), '{"default":true}')
  mkdirSync(join(root, 'reactions', 'thumbs up'), { recursive: true })
  writeFileSync(join(root, 'reactions', 'thumbs up', 'cat.png'), 'png')
  mkdirSync(join(root, 'effects', 'clips'), { recursive: true })
  writeFileSync(join(root, 'effects', 'clips', 'boom.webm'), 'webm')
  return root
}

describe('seedUserFolder', () => {
  it('creates the user folder from the defaults on first run', () => {
    const defaults = pathsIn(bundled(), '')
    const user = pathsIn(join(mkdtempSync(join(tmpdir(), 'skillcam-user-')), 'Skillcam'), '')
    expect(seedUserFolder(user, defaults)).toEqual({ copied: ['skillcam.config.json', 'reactions', 'effects/clips'], failed: [] })
    expect(readFileSync(user.config, 'utf8')).toBe('{"default":true}')
    expect(readFileSync(join(user.reactions, 'thumbs up', 'cat.png'), 'utf8')).toBe('png')
    expect(readFileSync(join(user.clips, 'boom.webm'), 'utf8')).toBe('webm')
  })

  it('never overwrites what is there, and restores only what was deleted', () => {
    const defaults = pathsIn(bundled(), '')
    const user = pathsIn(mkdtempSync(join(tmpdir(), 'skillcam-user-')), '')
    writeFileSync(user.config, '{"mine":true}')
    mkdirSync(user.reactions)
    writeFileSync(join(user.reactions, 'own.gif'), 'gif')
    expect(seedUserFolder(user, defaults).copied).toEqual(['effects/clips'])
    expect(readFileSync(user.config, 'utf8')).toBe('{"mine":true}')
    expect(existsSync(join(user.reactions, 'thumbs up'))).toBe(false)
    expect(seedUserFolder(user, defaults).copied).toEqual([])
  })

  it('replaces a leftover half copy and leaves no temp folder', () => {
    const defaults = pathsIn(bundled(), '')
    const user = pathsIn(mkdtempSync(join(tmpdir(), 'skillcam-user-')), '')
    mkdirSync(`${user.reactions}.seeding`)
    writeFileSync(join(`${user.reactions}.seeding`, 'half.png'), '')
    seedUserFolder(user, defaults)
    expect(existsSync(`${user.reactions}.seeding`)).toBe(false)
    expect(existsSync(join(user.reactions, 'half.png'))).toBe(false)
    expect(existsSync(join(user.reactions, 'thumbs up', 'cat.png'))).toBe(true)
  })

  it('skips defaults that are not bundled', () => {
    const defaults = pathsIn(mkdtempSync(join(tmpdir(), 'skillcam-empty-')), '')
    const user = pathsIn(mkdtempSync(join(tmpdir(), 'skillcam-user-')), '')
    expect(seedUserFolder(user, defaults).copied).toEqual([])
  })
})
