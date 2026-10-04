#!/usr/bin/env node
// Dev-only diagnostics over the Chrome DevTools Protocol, so measurements never need a person at the camera.
// Start the app with:  npm run dev -- --remoteDebuggingPort 9222
//
//   node scripts/perf-probe.mjs sample [seconds=10]     mean/min/max of window.__skillcam.perf
//   node scripts/perf-probe.mjs eval '<expression>'      evaluate in the Output page (awaits promises), print JSON
//   node scripts/perf-probe.mjs shot <file.png>          screenshot of the Output page
//   node scripts/perf-probe.mjs feed <file.wav> [speed]  feed a 16 kHz mono 16-bit WAV into speech recognition
//                                                        (silently, instead of the mic); prints the word events
const PORT = process.env.CDP_PORT ?? '9222'
/** PAGE="Skillcam Control" targets the Control window instead (for `shot` and `eval`). */
const TITLE = process.env.PAGE ?? 'Skillcam Output'
const [cmd = 'sample', arg] = process.argv.slice(2)

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.title === TITLE)
if (!page) throw new Error(`no "${TITLE}" page among: ${targets.map((t) => t.title).join(', ')}`)

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})
let nextId = 1
const pending = new Map()
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  pending.get(msg.id)?.(msg)
  pending.delete(msg.id)
}
function send(method, params = {}) {
  const id = nextId++
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) =>
    pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)))
  )
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}

if (cmd === 'eval') {
  console.log(JSON.stringify(await evaluate(arg), null, 2))
} else if (cmd === 'feed') {
  const { readFileSync } = await import('node:fs')
  const wav = readFileSync(arg)
  const data = wav.indexOf('data')
  if (data < 0 || wav.readUInt32LE(24) !== 16000 || wav.readUInt16LE(22) !== 1) throw new Error('need a 16 kHz mono 16-bit WAV')
  const pcm = wav.subarray(data + 8).toString('base64')
  const speed = Number(process.argv[4] ?? 4)
  const events = await evaluate(`window.__skillcamDev.feedSpeech(${JSON.stringify(pcm)}, ${speed})`)
  console.log(events.join('\n'))
  console.log(`--- ${events.length} word events, ${events.filter((e) => e.endsWith('FIRED')).length} fired a rule`)
} else if (cmd === 'shot') {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(arg ?? 'shot.png', Buffer.from(data, 'base64'))
  console.log(`wrote ${arg ?? 'shot.png'}`)
} else {
  const seconds = Number(arg ?? 10)
  const samples = []
  for (let t = 0; t < seconds * 2; t++) {
    samples.push(await evaluate('window.__skillcam?.perf'))
    await new Promise((r) => setTimeout(r, 500))
  }
  const keys = Object.keys(samples.find(Boolean) ?? {})
  const rows = keys.map((k) => {
    const v = samples.map((s) => s?.[k]).filter((x) => typeof x === 'number')
    const mean = v.reduce((a, b) => a + b, 0) / (v.length || 1)
    return `${k.padEnd(18)} ${mean.toFixed(2).padStart(8)}  (min ${Math.min(...v).toFixed(2)}, max ${Math.max(...v).toFixed(2)})`
  })
  console.log(rows.join('\n'))
  const last = samples.at(-1)
  if (last) console.log(JSON.stringify(await evaluate('({tracker: window.__skillcam?.tracker, hands: window.__skillcam?.hands, extra: window.__skillcam?.extra})')))
}
ws.close()
