import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {},
  preload: {
    // Sandboxed preloads must be CommonJS.
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } }
  },
  renderer: {
    root: resolve('src'),
    // Model + wasm files are served from assets/ and copied verbatim into the build.
    publicDir: resolve('assets'),
    // The tracker worker loads MediaPipe's ES-module wasm loader, so workers must be module workers.
    worker: { format: 'es' },
    build: {
      rollupOptions: {
        input: { output: resolve('src/output/index.html') }
      }
    }
  }
})
