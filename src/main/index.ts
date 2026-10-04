import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, globalShortcut, ipcMain, net, powerSaveBlocker, protocol, screen, session, systemPreferences } from 'electron'
import type { AppStatus, HotkeyStatus, PermissionStatus } from '../shared/api'
import type { ConfigResult } from '../shared/config'
import { loadConfig, watchConfig } from './config'
import { ConfigState } from './configState'
import { insideRoot, resolveMedia, watchMedia } from './media'
import { missingAssets } from './status'

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
const REACTIONS_DIR = join(ROOT, 'reactions')
const ASSETS_DIR = join(ROOT, 'assets')

let output: BrowserWindow | null = null
let control: BrowserWindow | null = null
/** Set once the app is quitting, so closing the Control window really closes it (otherwise it only hides). */
let quitting = false
app.on('before-quit', () => (quitting = true))

const status: AppStatus = {
  permissions: { camera: 'unknown', microphone: 'unknown' },
  missingAssets: [],
  hotkey: { accelerator: '', registered: false, error: null }
}
function publishStatus(): void {
  output?.webContents.send('status:changed', status)
}

function readPermissions(): AppStatus['permissions'] {
  if (process.platform !== 'darwin') return { camera: 'unknown', microphone: 'unknown' }
  return {
    camera: systemPreferences.getMediaAccessStatus('camera') as PermissionStatus,
    microphone: systemPreferences.getMediaAccessStatus('microphone') as PermissionStatus
  }
}

/**
 * The arm/disarm hotkey, system-wide (works while FaceTime or WhatsApp has focus). Re-registered when
 * the config changes it. Registration fails if another app owns the shortcut or it isn't a valid accelerator.
 */
/** Holding the keys (or a bouncy press) must toggle once, not flicker. */
let lastToggleAt = 0
function toggleArmed(): void {
  const now = Date.now()
  if (now - lastToggleAt < 300) return
  lastToggleAt = now
  output?.webContents.send('armed:toggle')
}

/** The shortcut that is registered right now (it keeps working if a new one can't be registered). */
let activeHotkey: string | null = null

function registerHotkey(accelerator: string): HotkeyStatus {
  if (activeHotkey === accelerator) return { accelerator, registered: true, error: null }
  const keeps = activeHotkey ? `; ${activeHotkey} still works` : ''
  try {
    // The new one first: if it can't be had, the old one stays.
    const registered = globalShortcut.register(accelerator, toggleArmed)
    if (!registered) {
      console.warn(`[hotkey] ${accelerator}: another app is using it${keeps}`)
      return { accelerator, registered: false, error: `is used by another app${keeps}` }
    }
    if (activeHotkey) globalShortcut.unregister(activeHotkey)
    activeHotkey = accelerator
    console.log(`[hotkey] ${accelerator}: registered`)
    return { accelerator, registered: true, error: null }
  } catch (err) {
    console.warn(`[hotkey] "${accelerator}" is not a valid shortcut: ${(err as Error).message}`)
    return { accelerator, registered: false, error: `is not a valid shortcut (e.g. "CommandOrControl+Shift+K")${keeps}` }
  }
}

// skillcam://clips/<file> serves effects/clips/, skillcam://media/<path> serves reactions/, in dev and packaged builds alike.
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
  // Only camera/mic and choosing the effect-audio output device (setSinkId) are needed. Everything else is denied.
  const allowed = (permission: string): boolean => permission === 'media' || permission === 'speaker-selection'
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowed(permission))
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed(permission))

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

function fileFor(url: URL): string | null {
  let name: string
  try {
    name = decodeURIComponent(url.pathname.slice(1))
  } catch {
    return null
  }
  if (url.hostname === 'media') return insideRoot(REACTIONS_DIR, name)
  const file = resolve(CLIPS_DIR, name)
  return url.hostname === 'clips' && /^\w[\w.-]*$/.test(name) && file.startsWith(CLIPS_DIR + sep) ? file : null
}

function serveMedia(): void {
  protocol.handle('skillcam', async (request) => {
    const file = fileFor(new URL(request.url))
    if (!file) return new Response('Not found', { status: 404 })
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
    // Effect sounds play without a click in the window (it is never clicked: OBS captures it).
    webPreferences: { preload: join(import.meta.dirname, '../preload/index.cjs'), ...SECURE_PREFERENCES, autoplayPolicy: 'no-user-gesture-required' }
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
        width: 720,
        height: 940,
        minWidth: 560,
        minHeight: 480,
        x: (x ?? 0) + 40,
        y: (y ?? 0) + 40,
        backgroundColor: '#17181a',
        webPreferences: { ...SECURE_PREFERENCES }
      }
    }
  })
  win.webContents.on('did-create-window', (child) => {
    control = child
    child.on('page-title-updated', (event) => event.preventDefault())
    // Closing the Control window hides it (it can't be rebuilt without reloading the Output); the Dock icon brings it back.
    child.on('close', (event) => {
      if (quitting) return
      event.preventDefault()
      child.hide()
    })
    child.on('closed', () => (control = null))
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
  serveMedia()
  ipcMain.handle('media:resolve', (_event, entries: unknown) =>
    resolveMedia(REACTIONS_DIR, Array.isArray(entries) ? entries.filter((e): e is string => typeof e === 'string') : [])
  )

  const config = new ConfigState()
  const initial = loadConfig(CONFIG_FILE)
  config.update(initial)
  logConfig(initial)
  ipcMain.handle('config:get', () => config.current)
  watchConfig(CONFIG_FILE, (result) => {
    config.update(result)
    logConfig(result)
    // A changed hotkey, or one that failed before (the other app may have let go of it): try again.
    if (result.ok && (result.config.hotkey !== status.hotkey.accelerator || !status.hotkey.registered)) {
      status.hotkey = registerHotkey(result.config.hotkey)
      publishStatus()
    }
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('config:changed', config.current)
  })

  await requestMediaAccess()
  // App Nap would throttle the whole app while the call app is in front.
  powerSaveBlocker.start('prevent-app-suspension')
  // Read at startup: the renderer sizes its canvas from the same value.
  const px = outputPixels(config.current.ok ? config.current.config.video.outputHeight : 1080)
  status.permissions = readPermissions()
  status.missingAssets = missingAssets(ASSETS_DIR)
  if (status.missingAssets.length) console.error(`[assets] missing (run npm run fetch-assets): ${status.missingAssets.join(', ')}`)
  status.hotkey = registerHotkey(config.current.ok ? config.current.config.hotkey : 'CommandOrControl+Shift+K')
  ipcMain.handle('status:get', () => status)
  output = createOutputWindow(px)
  output.on('closed', () => (output = null))
  // A permission changed in System Settings shows up when you come back to the app.
  app.on('browser-window-focus', () => {
    const now = readPermissions()
    if (now.camera !== status.permissions.camera || now.microphone !== status.permissions.microphone) {
      status.permissions = now
      publishStatus()
    }
  })

  // Replaced, added or removed media files apply without a restart.
  watchMedia(REACTIONS_DIR, (paths) => output?.webContents.send('media:changed', { root: 'reactions', paths }))
  watchMedia(CLIPS_DIR, (paths) => output?.webContents.send('media:changed', { root: 'clips', paths }))

  app.on('activate', () => {
    // Dock icon: bring the Control window back (closing it only hides it).
    if (control) {
      control.show()
      control.focus()
    } else if (!output) output = createOutputWindow(px)
  })
})

app.on('will-quit', () => globalShortcut.unregisterAll())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
