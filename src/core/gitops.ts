import { spawn, spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GitStatusInfo } from '@shared/types'
import { get, nowLocal, run } from './db'
import { syncKnowledgeToDir } from './knowledge'

const getFolder = (projectId: number): { folder: string; name: string; url: string } => {
  const p = get<{ folder: string; name: string; git_remote_url: string }>('SELECT folder, name, git_remote_url FROM projects WHERE id = ?', projectId)
  if (!p) throw new Error('That project no longer exists')
  if (!p.folder || !existsSync(p.folder)) throw new Error(`Set a valid folder for ${p.name} first`)
  return { folder: p.folder, name: p.name, url: p.git_remote_url ?? '' }
}

function gitSync(cwd: string, args: string[], allowFail = false): string {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
  if (r.error) throw new Error((r.error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Git is not installed or not on PATH' : r.error.message)
  if (r.status !== 0 && !allowFail) throw new Error((r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ') || `git ${args[0]} failed`)
  return r.status === 0 ? r.stdout : ''
}

/** Long-running git (push) without blocking the main process; never waits on a terminal prompt. */
function gitAsync(cwd: string, args: string[], timeoutMs = 5 * 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', cwd, ...args], {
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (out += d.toString()))
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('git push timed out — check your network or sign-in'))
    }, timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else {
        const msg = out.trim().split('\n').slice(-4).join(' ')
        reject(
          new Error(
            /authentication|could not read username|permission denied|403/i.test(msg)
              ? `GitHub rejected the sign-in. Run \`gh auth login\` (or sign in through Git Credential Manager) and try again. (${msg})`
              : msg || `git ${args[0]} failed`
          )
        )
      }
    })
  })
}

const isRepo = (folder: string): boolean => gitSync(folder, ['rev-parse', '--is-inside-work-tree'], true).trim() === 'true'

/** Accept https, ssh (git@host:owner/repo) and bare "github.com/owner/repo" links. */
function normalizeRemote(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '')
  if (!url) throw new Error('Paste the repository link first')
  if (/^(github|gitlab)\.com\//i.test(url)) url = `https://${url}`
  if (/^https?:\/\/(www\.)?github\.com\/[^/]+\/[^/]+$/i.test(url) && !url.endsWith('.git')) url = `${url}.git`
  if (!/^(https?:\/\/|git@|ssh:\/\/)/i.test(url)) throw new Error('That does not look like a git repository link (https://… or git@…)')
  return url
}

const DEFAULT_GITIGNORE = ['node_modules/', 'out/', 'dist/', 'build/', 'release/', '.env', '.env.*', '*.log', '.DS_Store', 'Thumbs.db', '.ai-kb/', 'graphify-out/', ''].join('\n')

export const gitops = {
  status: (projectId: number): GitStatusInfo => {
    const { folder, url } = getFolder(projectId)
    const empty: GitStatusInfo = { isRepo: false, branch: '', hasCommits: false, dirtyFiles: 0, remoteUrl: '', savedRemoteUrl: url, ahead: 0, behind: 0, upstream: '' }
    if (!isRepo(folder)) return empty
    const hasCommits = Boolean(gitSync(folder, ['rev-parse', '--verify', 'HEAD'], true).trim())
    const branch = gitSync(folder, ['symbolic-ref', '--short', 'HEAD'], true).trim() || gitSync(folder, ['rev-parse', '--abbrev-ref', 'HEAD'], true).trim()
    const dirtyFiles = gitSync(folder, ['status', '--porcelain'], true).split('\n').filter(Boolean).length
    const remoteUrl = gitSync(folder, ['remote', 'get-url', 'origin'], true).trim()
    const upstream = hasCommits ? gitSync(folder, ['rev-parse', '--abbrev-ref', '@{u}'], true).trim() : ''
    let ahead = 0
    let behind = 0
    if (upstream) {
      const [b, a] = gitSync(folder, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`], true).trim().split(/\s+/).map(Number)
      behind = b || 0
      ahead = a || 0
    }
    return { isRepo: true, branch, hasCommits, dirtyFiles, remoteUrl, savedRemoteUrl: url || remoteUrl, ahead, behind, upstream }
  },

  /** `git init` on `main`, a sensible .gitignore if none exists, and an initial commit. */
  init: (projectId: number): GitStatusInfo => {
    const { folder } = getFolder(projectId)
    if (isRepo(folder)) throw new Error('This folder is already a git repository')
    const r = spawnSync('git', ['-C', folder, 'init', '-b', 'main'], { encoding: 'utf8', windowsHide: true })
    if (r.status !== 0) gitSync(folder, ['init'])
    if (!existsSync(join(folder, '.gitignore'))) writeFileSync(join(folder, '.gitignore'), DEFAULT_GITIGNORE, 'utf8')
    syncKnowledgeToDir(projectId, folder) // also adds .ai-kb to .git/info/exclude
    gitSync(folder, ['add', '-A'])
    if (gitSync(folder, ['status', '--porcelain'], true).trim()) {
      const c = spawnSync('git', ['-C', folder, 'commit', '-m', 'Initial commit'], { encoding: 'utf8', windowsHide: true })
      if (c.status !== 0 && /user\.(email|name)|identity/i.test(c.stderr)) {
        throw new Error('Repository created, but git needs your name/email to commit. Run: git config --global user.name "You" && git config --global user.email you@example.com')
      }
    }
    run('UPDATE projects SET folder = folder WHERE id = ?', projectId) // notify UI
    return gitops.status(projectId)
  },

  /** Remember a repository link for this project (kept until changed manually). */
  setRemote: (projectId: number, url: string): GitStatusInfo => {
    const clean = url.trim() ? normalizeRemote(url) : ''
    run('UPDATE projects SET git_remote_url = ? WHERE id = ?', clean, projectId)
    return gitops.status(projectId)
  },

  /** Commit everything (if needed), point `origin` at the link, and push the current branch. */
  push: async (projectId: number, url?: string, message?: string): Promise<GitStatusInfo & { pushed: string }> => {
    const { folder, url: saved } = getFolder(projectId)
    const remote = normalizeRemote(url?.trim() || saved || gitSync(folder, ['remote', 'get-url', 'origin'], true).trim())
    run('UPDATE projects SET git_remote_url = ? WHERE id = ?', remote, projectId)

    if (!isRepo(folder)) gitops.init(projectId)
    gitSync(folder, ['add', '-A'])
    if (gitSync(folder, ['status', '--porcelain'], true).trim()) {
      gitSync(folder, ['commit', '-m', message?.trim() || `Update from AI Hub (${nowLocal().replace('T', ' ')})`])
    }
    if (!gitSync(folder, ['rev-parse', '--verify', 'HEAD'], true).trim()) throw new Error('Nothing to push yet — the repository has no commits')

    const current = gitSync(folder, ['remote', 'get-url', 'origin'], true).trim()
    if (!current) gitSync(folder, ['remote', 'add', 'origin', remote])
    else if (current !== remote) gitSync(folder, ['remote', 'set-url', 'origin', remote])

    const branch = gitSync(folder, ['symbolic-ref', '--short', 'HEAD'], true).trim() || 'main'
    await gitAsync(folder, ['push', '-u', 'origin', `HEAD:refs/heads/${branch}`])
    run('UPDATE projects SET git_remote_url = git_remote_url WHERE id = ?', projectId) // notify UI
    return { ...gitops.status(projectId), pushed: `${branch} → ${remote}` }
  }
}
