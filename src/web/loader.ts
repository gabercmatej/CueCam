/**
 * Downloads files with byte progress. The perception worker and vosk-browser fetch the same URLs
 * themselves afterwards and get them from the browser's HTTP cache, so this only adds a progress bar.
 * Sizes come from the build (asset-sizes.json): a compressed response's Content-Length would be wrong.
 */
export interface SizedFile {
  path: string
  bytes: number
}

export type Progress = (loaded: number, total: number) => void

export async function downloadAll(files: readonly SizedFile[], base: string, onProgress: Progress): Promise<void> {
  const total = files.reduce((n, f) => n + f.bytes, 0)
  let loaded = 0
  onProgress(0, total)
  await Promise.all(
    files.map(async (f) => {
      const res = await fetch(new URL(f.path, base))
      if (!res.ok || !res.body) throw new Error(`${f.path}: HTTP ${res.status}`)
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        loaded += value.byteLength
        onProgress(Math.min(loaded, total), total)
      }
    })
  )
  onProgress(total, total)
}

export const megabytes = (bytes: number): string => (bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)
