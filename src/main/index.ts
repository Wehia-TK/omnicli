import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import { join } from 'node:path'
import { coreApi } from '../core/api'
import { onDbChange, openDatabase } from '../core/db'
import { initApprovals } from '../core/approvals'
import { refreshGraphWatchers, stopGraphWatchers } from '../core/graphwatch'
import { initProjects, projects, stopAllRuns } from '../core/projects'
import { initScheduler, phoneNotify } from '../core/scheduler'
import { initWorkspace } from '../core/workspace'
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
      contextIsolation: true,
      webviewTag: true
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

  initWorkspace(dataDir)
  initApprovals(dataDir, (req) => {
    broadcastChanged()
    if (!req) return
    const t = projects.taskInfo(req.taskId)
    const title = `${t?.projectName ?? 'AI Hub'}: approval needed`
    if (Notification.isSupported() && !mainWindow?.isFocused()) {
      const n = new Notification({ title, body: req.summary.slice(0, 160) })
      n.on('click', () => {
        mainWindow?.show()
        mainWindow?.focus()
        if (t) mainWindow?.webContents.send('navigate', `projects/${t.projectId}/${req.taskId}`)
      })
      n.show()
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
    if (path === 'app.chooseFolder') {
      const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
      return r.canceled ? null : r.filePaths[0] ?? null
    }
    if (path === 'app.setTheme') {
      const dark = args[0] !== 'light'
      try {
        mainWindow?.setTitleBarOverlay({ color: '#00000000', symbolColor: dark ? '#a1a1aa' : '#3f3f46', height: 36 })
        mainWindow?.setBackgroundColor(dark ? '#08090f' : '#eef1f9')
      } catch {
        // overlay not supported
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
