import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, ipcMain, net, powerSaveBlocker, protocol, screen, session, systemPreferences } from 'electron'
import type { ConfigResult } from '../shared/config'
import { loadConfig, watchConfig } from './config'
import { ConfigState } from './configState'

/** Output size in real pixels for `video.outputHeight` (16:9). */
const outputPixels = (height: 1080 | 720): { width: number; height: number } => ({ width: (height * 16) / 9, height })
/** window.open name the Output page uses for the Control window (src/control/panel.ts). */
const CONTROL_WINDOW_NAME = 'skillcam-control'

// The Output must keep rendering at full rate while a call app covers it (OBS captures it
// even when hidden). Chromium otherwise throttles occluded and background windows.
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

// Dev: the project root. Packaged paths for config + clips are a Phase 5 decision.
const ROOT = app.getAppPath()
const CONFIG_FILE = join(ROOT, 'skillcam.config.json')
const CLIPS_DIR = join(ROOT, 'effects', 'clips')

// skillcam://clips/<file> serves effects/clips/ to the renderer in dev and packaged builds alike.
protocol.registerSchemesAsPrivileged([
  { scheme: 'skillcam', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
])

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
    const { protocol: scheme, hostname } = new URL(details.url)
    const local = ['file:', 'data:', 'blob:', 'devtools:', 'mediastream:', 'skillcam:'].includes(scheme)
    const devServer = !app.isPackaged && (hostname === 'localhost' || hostname === '127.0.0.1')
    if (!local && !devServer) console.warn(`[network] blocked ${details.method} ${details.url}`)
    callback({ cancel: !local && !devServer })
  })
}

function serveClips(): void {
  protocol.handle('skillcam', async (request) => {
    const url = new URL(request.url)
    const name = decodeURIComponent(url.pathname.slice(1))
    const file = resolve(CLIPS_DIR, name)
    if (url.hostname !== 'clips' || !/^\w[\w.-]*$/.test(name) || !file.startsWith(CLIPS_DIR + sep)) {
      return new Response('Not found', { status: 404 })
    }
    try {
      const res = await net.fetch(pathToFileURL(file).toString(), { headers: request.headers })
      // Clips are drawn into WebGL, which refuses cross-origin video unless CORS allows it.
      const headers = new Headers(res.headers)
      headers.set('Access-Control-Allow-Origin', '*')
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

const SECURE_PREFERENCES = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  // Keep rendering at full rate when another app (the call) has focus.
  backgroundThrottling: false
} as const

function hardenContents(contents: Electron.WebContents, name: string): void {
  contents.on('will-navigate', (event) => event.preventDefault())
  contents.on('console-message', ({ level, message }) => {
    console.log(`[${name}:${level}] ${message}`)
  })
}

/**
 * Window size in points so that it holds exactly `px` real pixels on this display: on a Retina
 * screen 1920×1080 px is a 960×540 pt window. OBS window capture grabs real pixels, so this is
 * what makes the capture 1:1 instead of an upscaled canvas.
 */
function pointsFor(px: { width: number; height: number }, scaleFactor: number): { width: number; height: number } {
  return { width: Math.round(px.width / scaleFactor), height: Math.round(px.height / scaleFactor) }
}

/**
 * The Output window: exactly 1920×1080 (or 1280×720) real pixels, frameless, canvas only. OBS
 * captures it by its title. Its page drives the Control window too: it opens it with window.open
 * (same origin, same renderer process), so one camera and one tracker serve both windows.
 */
function createOutputWindow(px: { width: number; height: number }): BrowserWindow {
  const size = pointsFor(px, screen.getPrimaryDisplay().scaleFactor)
  const win = new BrowserWindow({
    title: 'Skillcam Output',
    ...size,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    // No shadow or rounded corners leaking into the capture.
    hasShadow: false,
    roundedCorners: false,
    backgroundColor: '#000000',
    show: false,
    webPreferences: { preload: join(import.meta.dirname, '../preload/index.cjs'), ...SECURE_PREFERENCES }
  })

  // Moved to a display with another scale factor (e.g. Retina laptop ↔ 1× monitor): keep the real pixel count.
  const refit = (): void => {
    const display = screen.getDisplayMatching(win.getBounds())
    const want = pointsFor(px, display.scaleFactor)
    const [w, h] = win.getContentSize()
    if (w !== want.width || h !== want.height) {
      win.setContentSize(want.width, want.height)
      const [gw, gh] = win.getContentSize()
      if (gw !== want.width || gh !== want.height) {
        // macOS keeps windows inside the screen: on a 1× 1080p monitor a 1920×1080 pt window doesn't fit.
        console.warn(
          `[output] window clamped to ${gw}×${gh} pt (wanted ${want.width}×${want.height} pt for ${px.width}×${px.height} px at ${display.scaleFactor}×): ` +
            'OBS will capture fewer pixels. Move the window to the Retina display or set video.outputHeight to 720.'
        )
      } else {
        console.log(`[output] window ${want.width}×${want.height} pt for ${px.width}×${px.height} px`)
      }
    }
  }
  win.once('ready-to-show', () => {
    // The first size used the primary display's scale; the window may have opened on another one.
    refit()
    win.show()
  })
  win.on('moved', refit)
  screen.on('display-metrics-changed', refit)
  win.on('closed', () => screen.off('display-metrics-changed', refit))
  // The page title must stay "Skillcam Output" for OBS's window list.
  win.on('page-title-updated', (event) => event.preventDefault())
  hardenContents(win.webContents, 'output')

  // Only the Control window may be opened, and only as a blank same-origin page the Output fills in.
  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (frameName !== CONTROL_WINDOW_NAME || url !== 'about:blank') return { action: 'deny' }
    const [x, y] = win.getPosition()
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        title: 'Skillcam Control',
        width: 664,
        height: 780,
        x: (x ?? 0) + 40,
        y: (y ?? 0) + 40,
        backgroundColor: '#111214',
        webPreferences: { ...SECURE_PREFERENCES }
      }
    }
  })
  win.webContents.on('did-create-window', (child) => {
    child.on('page-title-updated', (event) => event.preventDefault())
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    hardenContents(child.webContents, 'control')
  })
  // The Output is the engine; closing it ends the app (the Control window can't run alone).
  win.on('closed', () => app.quit())

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(`${devUrl}/output/index.html`)
  else void win.loadFile(join(import.meta.dirname, '../renderer/output/index.html'))

  return win
}

function logConfig(result: ConfigResult): void {
  if (result.ok) console.log(`[config] loaded: ${result.config.rules.length} rules, ${Object.keys(result.config.effects).length} effects`)
  else console.error(`[config] invalid, keeping the last good config:\n${result.error}`)
}

void app.whenReady().then(async () => {
  lockDownSession()
  serveClips()

  const config = new ConfigState()
  const initial = loadConfig(CONFIG_FILE)
  config.update(initial)
  logConfig(initial)
  ipcMain.handle('config:get', () => config.current)
  watchConfig(CONFIG_FILE, (result) => {
    config.update(result)
    logConfig(result)
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('config:changed', config.current)
  })

  await requestMediaAccess()
  // App Nap would throttle the whole app while the call app is in front.
  powerSaveBlocker.start('prevent-app-suspension')
  // Read at startup: the renderer sizes its canvas from the same value.
  const px = outputPixels(config.current.ok ? config.current.config.video.outputHeight : 1080)
  createOutputWindow(px)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createOutputWindow(px)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
