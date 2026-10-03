import type { ModelMessage } from 'vosk-browser/dist/interfaces'

export interface ModelEvents {
  on(event: ModelMessage['event'], listener: (message: ModelMessage) => void): void
}

/**
 * Resolves when a vosk-browser Model finishes loading. Unlike `createModel`, this also
 * rejects as soon as the worker reports an error (missing model file, bad archive).
 */
export function waitForModelLoad(model: ModelEvents): Promise<void> {
  return new Promise((resolve, reject) => {
    model.on('load', (message) => {
      if ('result' in message && message.result) resolve()
      else reject(new Error('Vosk model failed to load'))
    })
    model.on('error', (message) => {
      reject(new Error(`Vosk worker error: ${'error' in message ? message.error : 'unknown'}`))
    })
  })
}
