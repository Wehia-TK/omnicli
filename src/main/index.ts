import { app, BrowserWindow, dialog, ipcMain, nativeImage, Notification, shell } from 'electron'
import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { coreApi } from '../core/api'
import { onDbChange, openDatabase } from '../core/db'
import { initApprovals } from '../core/approvals'
import { refreshGraphWatchers, stopGraphWatchers } from '../core/graphwatch'
import { initProjects, projects, stopAllRuns } from '../core/projects'
import { initScheduler, phoneNotify } from '../core/scheduler'
import { initWorkspace } from '../core/workspace'
import { initTerminal, stopAllTerminals } from '../core/terminal'
import { initUpdater, relaunchDevSession } from '../core/updater'
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

/** Ensure Windows taskbar jump-list, Start Menu & folder shortcuts launch Electron directly (no cmd.exe). */
function ensureWindowsShortcut(appRoot: string): void {
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
      sandbox: false,
      contextIsolation: true,
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
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // Self-update: compares the running code with the source checkout it was launched from
  const appRoot = app.getAppPath()
  ensureWindowsShortcut(appRoot)
  initUpdater({
    root: appRoot,
    packaged: app.isPackaged,
    restart: () => {
      if (app.isPackaged) {
        app.relaunch()
      } else {
        relaunchDevSession(appRoot)
      }
      app.quit()
    }
  }).catch((e) => console.warn('[updater]', (e as Error).message))

  const dataDir = join(app.getPath('userData'), 'data')
  openDatabase(dataDir)
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

  initTerminal((ev) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('terminal-output', ev)
    }
  })

  ipcMain.handle('api', async (_event, path: string, args: unknown[]) => {
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
      return `file:///${join(__dirname, '../preload/picker.js').split('\\').join('/')}`
    }
    if (path === 'app.openPath') {
      const target = String(args[0] ?? '')
      if (target) await shell.openPath(target)
      return true
    }

    const parts = path.split('.')
    let cur: unknown = coreApi
    for (const p of parts) {
      cur = (cur as Record<string, unknown>)?.[p]
    }
    if (typeof cur !== 'function') {
      throw new Error(`Unknown API method: ${path}`)
    }
    return await (cur as (...a: unknown[]) => unknown)(...args)
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  stopAllRuns()
  stopAllTerminals()
  stopGraphWatchers()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
