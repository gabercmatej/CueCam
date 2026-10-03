// AudioWorklet: batches mono mic samples into fixed-size chunks and posts them to the main thread.
// Loaded via `?worker&url`, so it is bundled on its own and runs in the AudioWorkletGlobalScope.

declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: { processorOptions?: unknown })
}
declare function registerProcessor(name: string, ctor: new (options: { processorOptions: MicCaptureOptions }) => AudioWorkletProcessor): void

export interface MicCaptureOptions {
  chunkSize: number
}

class MicCapture extends AudioWorkletProcessor {
  private readonly size: number
  private buffer: Float32Array
  private filled = 0

  constructor(options: { processorOptions: MicCaptureOptions }) {
    super(options)
    const size = Math.floor(options.processorOptions.chunkSize)
    if (!(size > 0)) throw new Error(`mic-capture: invalid chunkSize ${options.processorOptions.chunkSize}`)
    this.size = size
    this.buffer = new Float32Array(size)
  }

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0]
    if (!channel) return true
    let offset = 0
    while (offset < channel.length) {
      const n = Math.min(channel.length - offset, this.buffer.length - this.filled)
      this.buffer.set(channel.subarray(offset, offset + n), this.filled)
      this.filled += n
      offset += n
      if (this.filled === this.buffer.length) {
        // Transferring detaches the buffer (its length becomes 0), so size the next one from this.size.
        this.port.postMessage(this.buffer, [this.buffer.buffer])
        this.buffer = new Float32Array(this.size)
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor('mic-capture', MicCapture)
