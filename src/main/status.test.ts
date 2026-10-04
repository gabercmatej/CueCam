import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { missingAssets, REQUIRED_ASSETS } from './status'

describe('missingAssets', () => {
  it('lists missing and empty files, nothing when all are there', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skillcam-assets-'))
    expect(missingAssets(dir)).toEqual(REQUIRED_ASSETS.map((a) => a.file))
    for (const { file } of REQUIRED_ASSETS) {
      mkdirSync(dirname(join(dir, file)), { recursive: true })
      writeFileSync(join(dir, file), 'x')
    }
    expect(missingAssets(dir)).toEqual([])
    writeFileSync(join(dir, 'vosk/vosk-model-small-en-us-0.15.tar.gz'), '')
    expect(missingAssets(dir)).toEqual(['vosk/vosk-model-small-en-us-0.15.tar.gz'])
  })
})
