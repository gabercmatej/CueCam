import { describe, expect, it } from 'vitest'
import { waitForModelLoad, type ModelEvents } from './modelLoad'

function fakeModel() {
  const listeners = new Map<string, (m: never) => void>()
  const model: ModelEvents = { on: (event, l) => void listeners.set(event, l as (m: never) => void) }
  const emit = (event: string, message: unknown) => listeners.get(event)?.(message as never)
  return { model, emit }
}

describe('waitForModelLoad', () => {
  it('resolves on a successful load event', async () => {
    const { model, emit } = fakeModel()
    const p = waitForModelLoad(model)
    emit('load', { event: 'load', result: true })
    await expect(p).resolves.toBeUndefined()
  })

  it('rejects at once on a failed load', async () => {
    const { model, emit } = fakeModel()
    const p = waitForModelLoad(model)
    emit('load', { event: 'load', result: false })
    await expect(p).rejects.toThrow(/failed to load/)
  })

  it('rejects at once on a worker error, with its message', async () => {
    const { model, emit } = fakeModel()
    const p = waitForModelLoad(model)
    emit('error', { event: 'error', error: 'HTTP error! status: 404' })
    await expect(p).rejects.toThrow(/404/)
  })
})
