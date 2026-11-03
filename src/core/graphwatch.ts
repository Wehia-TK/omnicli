import { spawn } from 'node:child_process'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { all } from './db'
import { getSettings } from './settings'

/**
 * Keep each project's graphify code graph fresh: watch the folder and run `graphify update` (AST only,
 * no tokens) a little after edits settle. Only projects that already have graphify-out/ are watched.
 */
const watchers = new Map<string, FSWatcher>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const busy = new Set<string>()

const IGNORE = /(^|[\\/])(node_modules|\.git|graphify-out|\.ai-kb|out|dist|build|release|[^\\/]*-worktrees)([\\/]|$)/
const CODE = /\.(tsx?|jsx?|mjs|cjs|py|rs|go|java|kt|cs|cpp|cc|c|h|swift|rb|php|dart|vue|svelte|gd|lua)$/i

export function updateGraphNow(folder: string): void {
  if (busy.has(folder) || !existsSync(join(folder, 'graphify-out'))) return
  busy.add(folder)
  const child = spawn(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'graphify', 'update', folder], { cwd: folder, windowsHide: true, stdio: 'ignore' })
  const done = (): void => {
    busy.delete(folder)
  }
  child.on('error', done)
  child.on('close', done)
}

function schedule(folder: string): void {
  clearTimeout(timers.get(folder))
  timers.set(
    folder,
    setTimeout(() => updateGraphNow(folder), 20_000)
  )
}

export function refreshGraphWatchers(): void {
  const wanted = new Set<string>()
  if (getSettings().useGraphify && getSettings().graphifyWatch) {
    for (const p of all<{ folder: string }>("SELECT folder FROM projects WHERE archived_at IS NULL AND folder != ''")) {
      if (existsSync(join(p.folder, 'graphify-out', 'graph.json'))) wanted.add(p.folder)
    }
  }
  for (const [folder, w] of watchers) {
    if (!wanted.has(folder)) {
      w.close()
      watchers.delete(folder)
    }
  }
  for (const folder of wanted) {
    if (watchers.has(folder)) continue
    try {
      const w = watch(folder, { recursive: true }, (_ev, file) => {
        const f = String(file ?? '')
        if (f && CODE.test(f) && !IGNORE.test(f)) schedule(folder)
      })
      w.on('error', () => watchers.delete(folder))
      watchers.set(folder, w)
    } catch {
      // folder not watchable
    }
  }
}

export function stopGraphWatchers(): void {
  for (const w of watchers.values()) w.close()
  watchers.clear()
}
