import { describe, expect, it } from 'vitest'
import { mediaUrl, resolveFromList } from './media'

const FILES = ['thumbs up/b.png', 'thumbs up/a.jpg', 'thumbs up/.hidden.png', 'thumbs up/notes.txt', 'thumbs up/deep/c.png', 'rock/riff.mp3', 'boom.mp4']

describe('resolveFromList (web demo manifest)', () => {
  it('lists the media files directly in a folder, sorted, hidden and non-media skipped', () => {
    expect(resolveFromList(FILES, ['thumbs up'])).toEqual({ 'thumbs up': ['thumbs up/a.jpg', 'thumbs up/b.png'] })
  })

  it('resolves a file to itself and anything unknown to nothing', () => {
    expect(resolveFromList(FILES, ['rock/riff.mp3', 'boom.mp4', 'nope', 'thumbs up/notes.txt'])).toEqual({
      'rock/riff.mp3': ['rock/riff.mp3'],
      'boom.mp4': ['boom.mp4'],
      nope: [],
      'thumbs up/notes.txt': []
    })
  })

  it('accepts a trailing slash on folders', () => {
    expect(resolveFromList(FILES, ['rock/'])).toEqual({ 'rock/': ['rock/riff.mp3'] })
  })
})

describe('mediaUrl', () => {
  it('encodes each segment, under the app scheme by default or a given base', () => {
    expect(mediaUrl('lets go/Yippie #memes.mp4')).toBe('skillcam://media/lets%20go/Yippie%20%23memes.mp4')
    expect(mediaUrl('a b/c.png', './reactions/')).toBe('./reactions/a%20b/c.png')
  })
})
