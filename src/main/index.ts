import { join } from 'node:path'
import { app, BrowserWindow, session, systemPreferences } from 'electron'

const OUTPUT_WIDTH = 1280
const OUTPUT_HEIGHT = 720

async function requestMediaAccess(): Promise<void> {
  if (process.platform !== 'darwin') return
  for (const media of ['camera', 'microphone'] as const) {
    const before = systemPreferences.getMediaAccessStatus(media)
    const granted = before === 'granted' || (await systemPreferences.askForMediaAccess(media))
    console.log(`[permissions] ${media}: ${before} → ${granted ? 'granted' : 'denied'}`)
  }
}

function lockDownSession(): void {
  // Only camera/mic are ever needed. Everything else is denied.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media')

  // No network, ever (BUILD_PLAN §13). Backs up the CSP; MediaPipe tries to phone home for telemetry.
  // In dev, the Vite server on localhost is the only allowed origin.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const { protocol, hostname } = new URL(details.url)
    const local = ['file:', 'data:', 'blob:', 'devtools:', 'mediastream:'].includes(protocol)
    const devServer = !app.isPackaged && (hostname === 'localhost' || hostname === '127.0.0.1')
    if (!local && !devServer) console.warn(`[network] blocked ${details.method} ${details.url}`)
    callback({ cancel: !local && !devServer })
  })
}

function createOutputWindow(): BrowserWindow {
  const win = new BrowserWindow({
    title: 'Skillcam Output',
    width: OUTPUT_WIDTH,
    height: OUTPUT_HEIGHT,
    useContentSize: true,
    resizable: false,
    backgroundColor: '#000000',
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Keep rendering at full rate when another app (the call) has focus.
      backgroundThrottling: false
    }
  })

  win.once('ready-to-show', () => win.show())
  // Nothing in Skillcam opens windows or links; never hand a URL to the OS.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.on('console-message', ({ level, message }) => {
    console.log(`[output:${level}] ${message}`)
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(`${devUrl}/output/index.html`)
  else void win.loadFile(join(import.meta.dirname, '../renderer/output/index.html'))

  return win
}

void app.whenReady().then(async () => {
  lockDownSession()
  await requestMediaAccess()
  createOutputWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createOutputWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
