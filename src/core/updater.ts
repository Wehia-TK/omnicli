import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { UpdateInfo } from '@shared/types'

/**
 * Self-update for the source checkout Omni CLI runs from (`npm run dev` / Start Omni CLI.bat).
 *
 * "An update" = anything the running process doesn't have yet:
 *  - commits made since launch (plain file edits that aren't committed are NOT updates),
 *  - commits on the upstream branch that haven't been pulled (only when a remote is configured).
 */

let root = ''
let packaged = false
let launchedAt = Date.now()
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
  if (!packaged && existsSync(join(root, '.git'))) {
    const head = await git(['rev-parse', 'HEAD'])
    launchHead = head.ok ? head.out : ''
  }
}

/** Files changed by commits made since launch (uncommitted edits and file timestamps are deliberately ignored). */
async function changedSinceLaunch(): Promise<string[]> {
  if (!launchHead) return []
  const r = await git(['diff', '--name-only', launchHead, 'HEAD'])
  if (!r.ok) return []
  const watched = (f: string): boolean => WATCH_FILES.includes(f) || WATCH_DIRS.some((d) => f.startsWith(d + '/'))
  return r.out.split('\n').map((f) => f.trim()).filter((f) => f && watched(f)).sort()
}

/** Renderer files are hot-reloaded only when electron-vite dev is attached; otherwise a build + restart applies them. */
const needsRestartFor = (file: string): boolean => (process.env.ELECTRON_RENDERER_URL ? !file.startsWith('src/renderer/') : true)

const parseLog = (raw: string): { hash: string; subject: string }[] =>
  raw
    .split('\n')
    .filter(Boolean)
    .map((l) => ({ hash: l.split('\t')[0], subject: l.split('\t').slice(1).join('\t') }))

/**
 * The ref teammates merge into: the branch's upstream, else the remote's default branch (origin/HEAD → origin/main → origin/master, for older repos).
 * Returns '' when there is no remote to compare against.
 */
async function trackingRef(): Promise<string> {
  const upstream = await git(['rev-parse', '--abbrev-ref', '@{u}'])
  if (upstream.ok && upstream.out) return upstream.out
  if (!(await git(['remote', 'get-url', 'origin'])).ok) return ''
  const head = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (head.ok && head.out) return head.out
  for (const ref of ['origin/main', 'origin/master']) if ((await git(['rev-parse', '--verify', '--quiet', ref])).ok) return ref
  return ''
}

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
    if (!root || !existsSync(join(root, '.git'))) return { ...base, reason: 'Omni CLI is not running from a git checkout, so there is nothing to compare against.' }

    const [branchR, headR, files] = await Promise.all([git(['symbolic-ref', '--short', 'HEAD']), git(['rev-parse', 'HEAD']), changedSinceLaunch()])
    const head = headR.ok ? headR.out : ''
    const localCommits = launchHead && head && head !== launchHead ? parseLog((await git(['log', '--format=%h%x09%s', `${launchHead}..HEAD`])).out) : []

    let remoteCommits: { hash: string; subject: string }[] = []
    let remote = ''
    if (fetchRemote && (await git(['remote', 'get-url', 'origin'])).ok) {
      await git(['fetch', '--quiet', '--prune', 'origin'], 30_000)
      // follow a renamed default branch (e.g. master -> main) so origin/HEAD isn't stale
      await git(['remote', 'set-head', 'origin', '--auto'], 15_000)
    }
    const tracking = await trackingRef()
    if (tracking) {
      remote = tracking
      remoteCommits = parseLog((await git(['log', '--format=%h%x09%s', `HEAD..${tracking}`])).out)
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

  /** Pull (if behind), reinstall deps if package files changed, typecheck, then restart Omni CLI. */
  apply: async (): Promise<{ restarting: true; steps: string[] }> => {
    if (applying) throw new Error('An update is already being applied')
    applying = true
    const steps: string[] = []
    try {
      const info = await updater.check(true)
      if (!info.supported) throw new Error(info.reason)

      if (info.remoteCommits.length) {
        // Fast-forward when possible; if local commits/edits diverged (several people working at once), replay them on top.
        const ff = await git(['merge', '--ff-only', info.remote], 120_000)
        if (ff.ok) {
          steps.push(`Pulled ${info.remoteCommits.length} commit(s) from ${info.remote}`)
        } else {
          const rb = await git(['rebase', '--autostash', info.remote], 120_000)
          if (!rb.ok) {
            await git(['rebase', '--abort'])
            throw new Error(
              `Could not merge ${info.remote} into your changes (conflicts). Nothing was changed — resolve it in a terminal with "git pull --rebase".\n${rb.out.split('\n').slice(-3).join(' ')}`
            )
          }
          steps.push(`Pulled ${info.remoteCommits.length} commit(s) from ${info.remote} and replayed your local work on top`)
        }
      }

      const depsChanged =
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
        throw new Error(`The new code has type errors, so Omni CLI kept running the current version:\n${(errs.length ? errs : tc.out.split('\n')).slice(0, 6).join('\n')}`)
      }
      steps.push('Typecheck passed')

      const bld = await sh('npm', ['run', 'build'], 5 * 60_000)
      if (!bld.ok) {
        throw new Error(`Build failed, so Omni CLI kept running the current version:\n${bld.out.split('\n').slice(-6).join('\n')}`)
      }
      steps.push('Built app bundle')

      setTimeout(() => restart(), 600)
      return { restarting: true, steps: [...steps, 'Restarting…'] }
    } finally {
      applying = false
    }
  }
}
