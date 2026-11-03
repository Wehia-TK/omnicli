import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import { join } from 'node:path'
import { coreApi } from '../core/api'
import { onDbChange, openDatabase } from '../core/db'
import { initProjects, stopAllRuns } from '../core/projects'
import { initTerminal, stopAllTerminals } from '../core/terminal'

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
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#08090f',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: '#a1a1aa',
      height: 36
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
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
      }
    }
  })

  initTerminal((ev) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('terminal-output', ev)
    }
  })

  ipcMain.handle('api', async (_event, path: string, args: unknown[]) => {
    if (path === 'app.chooseFolder') {
      const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
      return r.canceled ? null : r.filePaths[0] ?? null
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
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
