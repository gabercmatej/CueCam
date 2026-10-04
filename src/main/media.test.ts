import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { insideRoot, resolveMedia, watchMedia } from './media'

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'skillcam-media-'))
  mkdirSync(join(root, 'thumbs up'))
  for (const f of ['b cat.png', 'a #1.jpg', '.DS_Store', 'notes.txt']) writeFileSync(join(root, 'thumbs up', f), '')
  mkdirSync(join(root, 'rock'))
  writeFileSync(join(root, 'rock', 'dog.gif'), '')
  writeFileSync(join(root, 'rock', 'yeah.mp3'), '')
  return root
}

describe('resolveMedia', () => {
  it('expands a folder to its media files, sorted, skipping hidden and non-media files', () => {
    const root = fixture()
    expect(resolveMedia(root, ['thumbs up'])).toEqual({ 'thumbs up': ['thumbs up/a #1.jpg', 'thumbs up/b cat.png'] })
  })

  it('keeps a file as itself and gives missing entries an empty list', () => {
    const root = fixture()
    expect(resolveMedia(root, ['rock/yeah.mp3', 'nope', 'rock/missing.png'])).toEqual({ 'rock/yeah.mp3': ['rock/yeah.mp3'], nope: [], 'rock/missing.png': [] })
  })

  it('never resolves outside the root', () => {
    const root = fixture()
    expect(resolveMedia(root, ['../etc'])).toEqual({ '../etc': [] })
    expect(insideRoot(root, '../x')).toBeNull()
    expect(insideRoot(root, 'rock/dog.gif')).toBe(join(root, 'rock', 'dog.gif'))
  })
})

describe('watchMedia', () => {
  it('reports changed files in subfolders once per batch, as relative paths, skipping hidden files', async () => {
    const root = fixture()
    const batches: string[][] = []
    const stop = watchMedia(root, (paths) => batches.push(paths.sort()), 100)
    await new Promise((r) => setTimeout(r, 100))
    writeFileSync(join(root, 'thumbs up', 'b cat.png'), 'new content')
    writeFileSync(join(root, 'rock', 'new.gif'), 'x')
    writeFileSync(join(root, 'rock', '.DS_Store'), 'x')
    await new Promise((r) => setTimeout(r, 600))
    stop()
    // FSEvents may also report the fixture's own files late, as an earlier batch; the two writes come together.
    expect(batches.at(-1)).toEqual(expect.arrayContaining(['rock/new.gif', 'thumbs up/b cat.png']))
    expect(batches.flat().some((p) => p.includes('.DS_Store'))).toBe(false)
  })

  it('is a no-op for a folder that does not exist', () => {
    expect(() => watchMedia('/nonexistent/skillcam', () => {})()).not.toThrow()
  })
})
