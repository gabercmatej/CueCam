// Renders build/icon.svg to build/icon.png (1024 px) with Electron's own Chromium (draws the SVG
// into a canvas, so no window needs to paint). scripts/make-icon.sh then makes all sizes + .icns.
import { readFileSync, writeFileSync } from 'node:fs'
import { app, BrowserWindow } from 'electron'

const svg = readFileSync(new URL('../build/icon.svg', import.meta.url), 'utf8')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false })
  await win.loadURL('about:blank')
  const dataUrl = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = c.height = 1024
      c.getContext('2d').drawImage(img, 0, 0, 1024, 1024)
      resolve(c.toDataURL('image/png'))
    }
    img.onerror = () => reject(new Error('svg failed to load'))
    img.src = 'data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}'
  })`)
  writeFileSync(new URL('../build/icon.png', import.meta.url), Buffer.from(dataUrl.split(',')[1], 'base64'))
  console.log('build/icon.png')
  app.quit()
})
