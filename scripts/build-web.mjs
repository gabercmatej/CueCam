// Builds the web demo into dist-web/: Vite (vite.web.config.ts), then only the model/wasm files the
// browser loads, reactions/ and effects/clips/, the config, and two manifests:
//   media-manifest.json  every file in reactions/ (the browser can't list folders)
//   asset-sizes.json     byte sizes of the model downloads, for the loading progress bars
// Run `npm run fetch-assets` once before.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

const OUT = 'dist-web'
const MODELS = [
  'mediapipe/wasm/vision_wasm_module_internal.js',
  'mediapipe/wasm/vision_wasm_module_internal.wasm',
  'mediapipe/gesture_recognizer.task',
  'mediapipe/selfie_segmenter_landscape.tflite',
  'mediapipe/blaze_face_short_range.tflite'
]
const VOICE = ['vosk/vosk-model-small-en-us-0.15.tar.gz']
/** GitHub Pages refuses files over 100 MB; the whole site must stay under 1 GB. */
const MAX_FILE = 100e6
const MAX_SITE = 1e9

const missing = [...MODELS, ...VOICE].filter((f) => !existsSync(join('assets', f)))
if (missing.length) {
  console.error(`Missing assets/${missing.join(', assets/')}. Run npm run fetch-assets first.`)
  process.exit(1)
}

execFileSync('npx', ['vite', 'build', '--config', 'vite.web.config.ts'], { stdio: 'inherit' })

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith('.')) return []
    const path = join(dir, e.name)
    return e.isDirectory() ? walk(path) : [path]
  })
}
const copy = (from, to) => {
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to, { recursive: true })
}
for (const f of [...MODELS, ...VOICE]) copy(join('assets', f), join(OUT, f))
// File names lose "#", "?" and "%": static servers disagree on %23 in paths (Vite's preview serves its
// index page instead). The config names folders, which keep their names.
const webSafe = (name) => name.replace(/[#?%]/g, '').replace(/\s{2,}/g, ' ').trim()
for (const file of walk('reactions')) {
  const rel = relative('reactions', file).split(sep)
  copy(file, join(OUT, 'reactions', ...rel.slice(0, -1), webSafe(rel.at(-1))))
}
if (existsSync('effects/clips')) copy('effects/clips', join(OUT, 'clips'))
copy('skillcam.config.json', join(OUT, 'skillcam.config.json'))

const toPosix = (p) => p.split(sep).join('/')
const media = walk(join(OUT, 'reactions')).map((p) => toPosix(relative(join(OUT, 'reactions'), p))).sort()
writeFileSync(join(OUT, 'media-manifest.json'), JSON.stringify(media, null, 1))
const sized = (files) => files.map((path) => ({ path, bytes: statSync(join(OUT, path)).size }))
writeFileSync(join(OUT, 'asset-sizes.json'), JSON.stringify({ models: sized(MODELS), voice: sized(VOICE) }, null, 1))
// Not needed with the Actions deploy, but keeps a branch-based Pages deploy from running Jekyll.
writeFileSync(join(OUT, '.nojekyll'), '')

const all = walk(OUT).map((p) => ({ p, size: statSync(p).size }))
const total = all.reduce((n, f) => n + f.size, 0)
const big = all.filter((f) => f.size > MAX_FILE)
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`
console.log(`\ndist-web: ${all.length} files, ${mb(total)} · ${media.length} reactions files`)
for (const f of all.sort((a, b) => b.size - a.size).slice(0, 5)) console.log(`  ${mb(f.size).padStart(9)}  ${toPosix(relative(OUT, f.p))}`)
if (big.length || total > MAX_SITE) {
  console.error(`Over GitHub Pages limits: ${big.map((f) => f.p).join(', ') || `site ${mb(total)}`}`)
  process.exit(1)
}
