import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { UpdateInfo } from '@shared/types'

/**
 * Self-update for the source checkout AI Hub runs from (`npm run dev` / Start AI Hub.bat).
 *
 * "An update" = anything the running process doesn't have yet:
 *  - source files edited since launch (e.g. an AI just changed this app) that need a restart
 *    (main / preload / core / shared / package files — renderer edits are already hot-reloaded),
 *  - commits made since launch,
 *  - commits on the upstream branch that haven't been pulled (only when a remote is configured).
 */

let root = ''
let packaged = false
let launchedAt = Date.now()
let baselineAt = Date.now()
let launchHead = ''
let restart: () => void = () => undefined
let applying = false

/** Paths watched for changes (relative to the repo root). */
const WATCH_DIRS = ['src', 'resources', 'build']
const WATCH_FILES = ['package.json', 'package-lock.json', 'electron.vite.config.ts', 'tsconfig.json']

function sh(cmd: string, args: string[], timeoutMs = 60_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, shell: cmd === 'npm', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => resolve({ ok: !err, out: (err ? `${stdout}\n${stderr}` : stdout).trim() })
    )
  })
}
const git = (args: string[], timeoutMs?: number): Promise<{ ok: boolean; out: string }> => sh('git', ['-C', root, ...args], timeoutMs)

export async function initUpdater(opts: { root: string; packaged: boolean; restart: () => void }): Promise<void> {
  root = opts.root
  packaged = opts.packaged
  restart = opts.restart
  launchedAt = Date.now()
  baselineAt = launchedAt
  if (!packaged && !process.env.ELECTRON_RENDERER_URL) {
    try {
      const outStat = await stat(join(root, 'out', 'main', 'index.js'))
      baselineAt = Math.min(launchedAt, outStat.mtimeMs)
    } catch {
      // fallback to launchedAt
    }
  }
  if (!packaged && existsSync(join(root, '.git'))) {
    const head = await git(['rev-parse', 'HEAD'])
    launchHead = head.ok ? head.out : ''
  }
}

async function changedSinceLaunch(): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (depth < 8) await walk(full, depth + 1)
      } else {
        try {
          if ((await stat(full)).mtimeMs > baselineAt) out.push(relative(root, full).replace(/\\/g, '/'))
        } catch {
          // deleted meanwhile
        }
      }
    }
  }
  for (const d of WATCH_DIRS) await walk(join(root, d), 0)
  for (const f of WATCH_FILES) {
    try {
      if ((await stat(join(root, f))).mtimeMs > baselineAt) out.push(f)
    } catch {
      // missing
    }
  }
  return out.sort()
}

/** Renderer files are hot-reloaded only when electron-vite dev is attached; otherwise a build + restart applies them. */
const needsRestartFor = (file: string): boolean => (process.env.ELECTRON_RENDERER_URL ? !file.startsWith('src/renderer/') : true)

const parseLog = (raw: string): { hash: string; subject: string }[] =>
  raw
    .split('\n')
    .filter(Boolean)
    .map((l) => ({ hash: l.split('\t')[0], subject: l.split('\t').slice(1).join('\t') }))

export const updater = {
  check: async (fetchRemote = true): Promise<UpdateInfo> => {
    const base: UpdateInfo = {
      supported: false,
      available: false,
      checkedAt: Date.now(),
      launchedAt,
      branch: '',
      commit: launchHead.slice(0, 7),
      localCommits: [],
      changedFiles: [],
      liveFiles: [],
      remoteCommits: [],
      remote: '',
      reason: ''
    }
    if (packaged) return { ...base, reason: 'This is an installed build — rebuild the installer (npm run dist) from the source folder to update it.' }
    if (!root || !existsSync(join(root, '.git'))) return { ...base, reason: 'AI Hub is not running from a git checkout, so there is nothing to compare against.' }

    const [branchR, headR, files] = await Promise.all([git(['symbolic-ref', '--short', 'HEAD']), git(['rev-parse', 'HEAD']), changedSinceLaunch()])
    const head = headR.ok ? headR.out : ''
    const localCommits = launchHead && head && head !== launchHead ? parseLog((await git(['log', '--format=%h%x09%s', `${launchHead}..HEAD`])).out) : []

    let remoteCommits: { hash: string; subject: string }[] = []
    let remote = ''
    const upstream = await git(['rev-parse', '--abbrev-ref', '@{u}'])
    if (upstream.ok && upstream.out) {
      remote = upstream.out
      if (fetchRemote) await git(['fetch', '--quiet'], 30_000)
      remoteCommits = parseLog((await git(['log', '--format=%h%x09%s', 'HEAD..@{u}'])).out)
    }

    const changedFiles = files.filter(needsRestartFor)
    const liveFiles = files.filter((f) => !needsRestartFor(f))
    return {
      ...base,
      supported: true,
      available: changedFiles.length > 0 || localCommits.length > 0 || remoteCommits.length > 0,
      branch: branchR.out,
      commit: head.slice(0, 7),
      localCommits,
      changedFiles,
      liveFiles,
      remoteCommits,
      remote
    }
  },

  /** Pull (if behind), reinstall deps if package files changed, typecheck, then restart AI Hub. */
  apply: async (): Promise<{ restarting: true; steps: string[] }> => {
    if (applying) throw new Error('An update is already being applied')
    applying = true
    const steps: string[] = []
    try {
      const info = await updater.check(true)
      if (!info.supported) throw new Error(info.reason)

      if (info.remoteCommits.length) {
        const pull = await git(['pull', '--ff-only'], 120_000)
        if (!pull.ok) throw new Error(`Could not pull ${info.remote}: ${pull.out.split('\n').slice(-3).join(' ')}`)
        steps.push(`Pulled ${info.remoteCommits.length} commit(s) from ${info.remote}`)
      }

      const depsChanged =
        (await changedSinceLaunch()).some((f) => f === 'package.json' || f === 'package-lock.json') ||
        (launchHead && (await git(['diff', '--name-only', launchHead, 'HEAD', '--', 'package.json', 'package-lock.json'])).out.trim() !== '')
      if (depsChanged) {
        const inst = await sh('npm', ['install', '--no-audit', '--no-fund'], 10 * 60_000)
        if (!inst.ok) throw new Error(`npm install failed: ${inst.out.split('\n').slice(-4).join(' ')}`)
        steps.push('Installed updated dependencies')
      }

      // Don't restart into a broken build — the window would never come back
      const tc = await sh('npm', ['run', 'typecheck'], 5 * 60_000)
      if (!tc.ok) {
        const errs = tc.out.split('\n').filter((l) => /error TS/.test(l))
        throw new Error(`The new code has type errors, so AI Hub kept running the current version:\n${(errs.length ? errs : tc.out.split('\n')).slice(0, 6).join('\n')}`)
      }
      steps.push('Typecheck passed')

      const bld = await sh('npm', ['run', 'build'], 5 * 60_000)
      if (!bld.ok) {
        throw new Error(`Build failed, so AI Hub kept running the current version:\n${bld.out.split('\n').slice(-6).join('\n')}`)
      }
      steps.push('Built app bundle')

      setTimeout(() => restart(), 600)
      return { restarting: true, steps: [...steps, 'Restarting…'] }
    } finally {
      applying = false
    }
  }
}

/**
 * Restart into the freshly built `out/` bundle by spawning `electron.exe` directly
 * (GUI subsystem binary — never opens a cmd.exe or Windows Terminal window).
 */
export function relaunchDevSession(projectRoot: string): void {
  const env = { ...process.env }
  delete env.ELECTRON_RENDERER_URL
  const child = spawn(process.execPath, [projectRoot], {
    cwd: projectRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env
  })
  child.unref()
}
