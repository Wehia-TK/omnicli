import { app, BrowserWindow, dialog, ipcMain, nativeImage, Notification, session, shell } from 'electron'
import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { coreApi } from '../core/api'
import { canOpenPath, isAllowedWebviewSrc, isAppUrl, isValidApiPath, resolveApiMethod, safeExternalUrl, samePath } from './security'
import { initAccounts } from '../core/accounts'
import { onDbChange, openDatabase } from '../core/db'
import { initApprovals } from '../core/approvals'
import { refreshGraphWatchers, stopGraphWatchers } from '../core/graphwatch'
import { initProjects, projects, stopAllRuns } from '../core/projects'
import { initScheduler, phoneNotify } from '../core/scheduler'
import { initWorkspace } from '../core/workspace'
import { initTerminal, stopAllTerminals } from '../core/terminal'
import { initUpdater } from '../core/updater'
import { voice } from '../core/voice'
import appIconPng from '../../resources/icon.png?asset'
import appIconIco from '../../resources/icon.ico?asset'

const APP_ID = 'com.omnicli.app'
const APP_NAME = 'Omni CLI'

app.setName(APP_NAME)
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_ID)
} else if (process.platform === 'darwin') {
  const macPaths = ['/opt/homebrew/bin', '/usr/local/bin', join(app.getPath('home'), '.local', 'bin')]
  const existing = (process.env.PATH || '').split(':')
  const toAdd = macPaths.filter((p) => existsSync(p) && !existing.includes(p))
  if (toAdd.length > 0) {
    process.env.PATH = `${toAdd.join(':')}:${process.env.PATH || ''}`
  }
}

/** Shortcuts are a convenience: never let them stop the app from starting (getPath can throw on unusual profiles). */
function ensureWindowsShortcut(appRoot: string): void {
  try {
    writeWindowsShortcuts(appRoot)
  } catch (e) {
    console.warn('[shortcuts]', (e as Error).message)
  }
}

/** Ensure Windows taskbar jump-list, Start Menu & folder shortcuts launch Electron directly (no cmd.exe). */
function writeWindowsShortcuts(appRoot: string): void {
  if (process.platform !== 'win32') return
  const programsDir = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  const staleElectronLnk = join(programsDir, 'Electron.lnk')
  const staleAiHubLnk = join(programsDir, 'AI Hub.lnk')
  const localAiHubLnk = join(appRoot, 'AI Hub.lnk')
  try {
    if (existsSync(staleElectronLnk)) {
      const info = shell.readShortcutLink(staleElectronLnk)
      if (info.target && info.target.toLowerCase() === process.execPath.toLowerCase()) {
        unlinkSync(staleElectronLnk)
      }
    }
    if (existsSync(staleAiHubLnk)) unlinkSync(staleAiHubLnk)
    if (existsSync(localAiHubLnk)) unlinkSync(localAiHubLnk)
  } catch {
    // ignore
  }
  const opts = {
    target: process.execPath,
    args: app.isPackaged ? '' : `"${appRoot}"`,
    cwd: appRoot,
    description: APP_NAME,
    icon: appIconIco,
    iconIndex: 0,
    appUserModelId: APP_ID
  }
  const targets = [join(programsDir, `${APP_NAME}.lnk`)]
  if (!app.isPackaged) {
    targets.push(join(appRoot, `${APP_NAME}.lnk`))
  }
  const taskbarLnk = join(app.getPath('appData'), 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar', `${APP_NAME}.lnk`)
  if (existsSync(taskbarLnk)) {
    targets.push(taskbarLnk)
  }
  for (const lnk of targets) {
    try {
      shell.writeShortcutLink(lnk, 'create', opts)
    } catch {
      // ignore
    }
  }
}

let mainWindow: BrowserWindow | null = null

// ───────────────────────────── Security boundaries ─────────────────────────────

const RENDERER_HTML = join(__dirname, '../renderer/index.html')
const PICKER_PRELOAD = join(__dirname, '../preload/picker.js')
const appUrl = (raw: string): boolean => isAppUrl(raw, RENDERER_HTML, process.env.ELECTRON_RENDERER_URL)

/** Links leave the app through the system browser, and only web / mail links (never file:// or custom schemes). */
function openExternalSafe(raw: string): void {
  const url = safeExternalUrl(raw)
  if (url) void shell.openExternal(url)
}

/**
 * The renderer holds a bridge that can run commands, so no other page may ever load inside an app window:
 * popups and off-app navigations open in the system browser instead, and the preview <webview> can't escalate itself.
 */
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url)
    return { action: 'deny' }
  })
  if (contents.getType() === 'webview') return // the browser preview may navigate wherever the user points it
  contents.on('will-navigate', (ev, url) => {
    if (appUrl(url)) return
    ev.preventDefault()
    openExternalSafe(url)
  })
  contents.on('will-redirect', (ev, url) => {
    if (!appUrl(url)) ev.preventDefault()
  })
  contents.on('will-attach-webview', (ev, prefs, params) => {
    if (prefs.preload && !samePath(prefs.preload, PICKER_PRELOAD)) delete prefs.preload
    prefs.nodeIntegration = false
    prefs.nodeIntegrationInSubFrames = false
    prefs.contextIsolation = true
    prefs.sandbox = true
    prefs.webSecurity = true
    if (!isAllowedWebviewSrc(params.src)) ev.preventDefault()
  })
})

let broadcastTimer: ReturnType<typeof setTimeout> | null = null

/** Coalesce DB-change pings: a streaming run writes many rows per second, the UI only needs ~4 refreshes/s. */
function broadcastChanged(): void {
  if (broadcastTimer) return
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('changed')
    }
  }, 250)
}

function createWindow(): void {
  const isDarwin = process.platform === 'darwin'
  const winIcon = nativeImage.createFromPath(process.platform === 'win32' ? appIconIco : appIconPng)
  mainWindow = new BrowserWindow({
    title: APP_NAME,
    width: 1360,
    height: 880,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#08090f',
    icon: winIcon,
    frame: false,
    titleBarStyle: isDarwin ? 'hiddenInset' : undefined,
    trafficLightPosition: isDarwin ? { x: 12, y: 12 } : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: true
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })

  mainWindow.on('maximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-maximized-change', true)
    }
  })

  mainWindow.on('unmaximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-maximized-change', false)
    }
  })

  if (process.platform === 'win32') {
    try {
      const appRoot = app.getAppPath()
      const relaunchCommand = app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${appRoot}"`
      mainWindow.setAppDetails({
        appId: APP_ID,
        appIconPath: appIconIco,
        appIconIndex: 0,
        relaunchCommand,
        relaunchDisplayName: APP_NAME
      })
      mainWindow.setIcon(winIcon)
    } catch {
      // ignore
    }
  }

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(RENDERER_HTML)
  }
}

const isRelaunch = process.argv.includes('--relaunch')

/**
 * Only one Omni CLI may run at a time (a second launch just focuses the first). A restart spawns the new
 * process while the old one is still shutting down, so a relaunched instance waits for the lock to free up.
 */
async function acquireSingleInstance(): Promise<boolean> {
  const attempts = isRelaunch ? 60 : 1
  for (let i = 0; i < attempts; i++) {
    if (app.requestSingleInstanceLock()) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

app.whenReady().then(async () => {
  if (!(await acquireSingleInstance())) {
    app.quit()
    return
  }
  // Self-update: compares the running code with the source checkout it was launched from
  const appRoot = app.getAppPath()
  ensureWindowsShortcut(appRoot)
  initUpdater({
    root: appRoot,
    packaged: app.isPackaged,
    restart: () => {
      // A dev-server URL from `npm run dev` would be stale after the restart — load the fresh build instead
      delete (process.env as Record<string, string | undefined>).ELECTRON_RENDERER_URL
      app.relaunch({ args: [...process.argv.slice(1).filter((a) => a !== '--relaunch'), '--relaunch'] })
      app.quit()
    }
  }).catch((e) => console.warn('[updater]', (e as Error).message))

  const dataDir = join(app.getPath('userData'), 'data')
  openDatabase(dataDir)
  initAccounts(dataDir)
  onDbChange(broadcastChanged)

  initProjects(dataDir, {
    changed: broadcastChanged,
    notify: (title, body, route) => {
      if (Notification.isSupported()) {
        const n = new Notification({ title, body })
        n.on('click', () => {
          if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore()
            mainWindow.focus()
            mainWindow.webContents.send('navigate', route)
          }
        })
        n.show()
        setTimeout(() => ensureWindowsShortcut(appRoot), 300)
      }
    }
  })

  initWorkspace(dataDir)
  initApprovals(dataDir, (req) => {
    broadcastChanged()
    if (!req) return
    const t = projects.taskInfo(req.taskId)
    const title = `${t?.projectName ?? 'Omni CLI'}: approval needed`
    if (Notification.isSupported() && !mainWindow?.isFocused()) {
      const n = new Notification({ title, body: req.summary.slice(0, 160) })
      n.on('click', () => {
        mainWindow?.show()
        mainWindow?.focus()
        if (t) mainWindow?.webContents.send('navigate', `projects/${t.projectId}/${req.taskId}`)
      })
      n.show()
      setTimeout(() => ensureWindowsShortcut(appRoot), 300)
    }
    phoneNotify(title, req.summary)
  })
  initScheduler((sch) => {
    projects.createAndRun({
      projectId: sch.project_id,
      prompt: sch.prompt,
      kind: 'task',
      cli: sch.cli,
      model: sch.model,
      effort: sch.effort,
      permissionMode: sch.permission_mode,
      checkoutMode: 'worktree',
      startImmediately: true
    })
  })
  refreshGraphWatchers()

  // The UI only ever needs the microphone (voice input); every other permission request is refused
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(permission === 'media' || permission === 'clipboard-sanitized-write' || permission === 'fullscreen')
  )

  initTerminal((ev) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('terminal-output', ev)
    }
  })

  ipcMain.handle('api', async (event, path: unknown, rawArgs: unknown) => {
    // Only Omni CLI's own top-level page may use the bridge (not the preview webview, iframes or a navigated-away page)
    const frame = event.senderFrame
    if (event.sender.getType() !== 'window' || !frame || frame !== event.sender.mainFrame || !appUrl(frame.url)) {
      throw new Error('Blocked: API call from an untrusted frame')
    }
    if (!isValidApiPath(path)) throw new Error('Invalid API method')
    const args = Array.isArray(rawArgs) ? rawArgs : []
    if (path === 'window.minimize') {
      const win = BrowserWindow.getFocusedWindow() ?? mainWindow
      win?.minimize()
      return true
    }
    if (path === 'window.maximize') {
      const win = BrowserWindow.getFocusedWindow() ?? mainWindow
      if (win?.isMaximized()) {
        win.unmaximize()
      } else {
        win?.maximize()
      }
      return win?.isMaximized() ?? false
    }
    if (path === 'window.close') {
      const win = BrowserWindow.getFocusedWindow() ?? mainWindow
      win?.close()
      return true
    }
    if (path === 'window.isMaximized') {
      const win = BrowserWindow.getFocusedWindow() ?? mainWindow
      return win?.isMaximized() ?? false
    }

    if (path === 'app.chooseFolder') {
      const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
      return r.canceled ? null : r.filePaths[0] ?? null
    }
    if (path === 'app.setTheme') {
      const dark = args[0] !== 'light'
      try {
        mainWindow?.setBackgroundColor(dark ? '#08090f' : '#eef1f9')
      } catch {
        // ignore
      }
      return true
    }
    if (path === 'app.pickerPreload') {
      return pathToFileURL(PICKER_PRELOAD).href
    }
    if (path === 'app.openPath') {
      const target = String(args[0] ?? '')
      if (!target || !canOpenPath(target)) throw new Error('Only folders, images and text files can be opened from here')
      const err = await shell.openPath(target)
      if (err) throw new Error(err)
      return true
    }
    if (path === 'app.openExternal') {
      openExternalSafe(String(args[0] ?? ''))
      return true
    }

    const fn = resolveApiMethod(coreApi, path)
    if (!fn) throw new Error(`Unknown API method: ${path}`)
    return await fn(...args)
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  stopAllRuns()
  stopAllTerminals()
  voice.shutdown()
  stopGraphWatchers()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
