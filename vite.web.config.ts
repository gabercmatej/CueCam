import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// The web demo (src/web): the same Output page as the Electron renderer, on a web adapter.
// `npm run build:web` (scripts/build-web.mjs) runs this, then adds the models, media and manifests.
export default defineConfig({
  root: resolve('src/web'),
  // Relative URLs: the site is served from a subpath (GitHub Pages: /<repo>/).
  base: './',
  // Models and media are copied by the build script (only the files the web needs).
  publicDir: false,
  // The perception worker loads MediaPipe's ES-module wasm loader, so workers must be module workers.
  worker: { format: 'es' },
  build: { outDir: resolve('dist-web'), emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 8000 }
})
