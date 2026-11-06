import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import type { CliId, SkillInfo } from '@shared/types'
import { get } from './db'

/** Where each CLI loads skills from (SKILL.md folders). */
function skillRoots(projectFolder?: string): { dir: string; native: CliId[]; scope: SkillInfo['scope'] }[] {
  const home = homedir()
  const roots: { dir: string; native: CliId[]; scope: SkillInfo['scope'] }[] = [
    { dir: join(home, '.claude', 'skills'), native: ['claude'], scope: 'user' },
    { dir: join(home, '.gemini', 'antigravity-cli', 'skills'), native: ['agy'], scope: 'user' },
    { dir: join(home, '.gemini', 'antigravity', 'skills'), native: ['agy'], scope: 'user' },
    { dir: join(home, '.gemini', 'skills'), native: ['agy'], scope: 'user' },
    { dir: join(home, '.codex', 'skills'), native: ['codex'], scope: 'user' },
    { dir: join(home, '.copilot', 'skills'), native: ['copilot'], scope: 'user' }
  ]
  if (projectFolder) {
    roots.unshift(
      { dir: join(projectFolder, '.claude', 'skills'), native: ['claude'], scope: 'project' },
      { dir: join(projectFolder, '.agents', 'skills'), native: ['agy', 'codex'], scope: 'project' }
    )
  }
  return roots
}

/** Minimal YAML front-matter reader for `name:` and `description:` (quoted or plain, single line). */
function readFrontMatter(file: string): { name: string; description: string } | null {
  try {
    const head = readFileSync(file, 'utf8').slice(0, 4000)
    const m = head.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    const block = m?.[1] ?? ''
    const field = (k: string): string => {
      const r = block.match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1]?.trim() ?? ''
      return r.replace(/^["']|["']$/g, '')
    }
    return { name: field('name'), description: field('description') }
  } catch {
    return null
  }
}

let cache: { key: string; at: number; value: SkillInfo[] } | null = null

function scan(projectFolder?: string): SkillInfo[] {
  const key = projectFolder ?? ''
  if (cache && cache.key === key && Date.now() - cache.at < 30_000) return cache.value
  const byName = new Map<string, SkillInfo>()
  for (const root of skillRoots(projectFolder)) {
    if (!existsSync(root.dir)) continue
    let dirs: string[] = []
    try {
      dirs = readdirSync(root.dir).filter((d) => {
        try {
          return statSync(join(root.dir, d)).isDirectory()
        } catch {
          return false
        }
      })
    } catch {
      continue
    }
    for (const d of dirs) {
      const file = join(root.dir, d, 'SKILL.md')
      if (!existsSync(file)) continue
      const fm = readFrontMatter(file)
      const name = (fm?.name || d).trim()
      const existing = byName.get(name)
      if (existing) {
        for (const n of root.native) if (!existing.native.includes(n)) existing.native.push(n)
        continue
      }
      byName.set(name, {
        name,
        description: (fm?.description || '').slice(0, 300),
        path: file,
        native: [...root.native],
        scope: root.scope
      })
    }
  }
  const value = [...byName.values()].sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === 'project' ? -1 : 1))
  cache = { key, at: Date.now(), value }
  return value
}

export const skills = {
  /** Skills available to a project: its own `.claude/skills` / `.agents/skills` plus every CLI's user-level skills. */
  list: (projectId?: number): SkillInfo[] => {
    const folder = projectId ? get<{ folder: string }>('SELECT folder FROM projects WHERE id = ?', projectId)?.folder : undefined
    return scan(folder || undefined)
  },
  listAll: (): SkillInfo[] => (cache?.value.length ? cache.value : scan()),

  /** Install folders: where `install` puts skills for each CLI. */
  targets: (): { cli: CliId; dir: string }[] => INSTALL_DIRS(),

  install: (url: string, targets: CliId[]) => installSkills(url, targets),

  /** Delete a user-level skill folder (only inside a known skills directory). */
  remove: (path: string): true => {
    const dir = resolve(dirname(path))
    const allowed = skillRoots().some((r) => dir.startsWith(resolve(r.dir) + sep))
    if (!allowed || !existsSync(join(dir, 'SKILL.md'))) throw new Error('Only installed user skills can be removed here')
    rmSync(dir, { recursive: true, force: true })
    cache = null
    return true
  },
  read: (path: string): string => {
    if (!/SKILL\.md$/i.test(path) || !existsSync(path)) throw new Error('Skill file not found')
    return readFileSync(path, 'utf8')
  }
}

// ───────────────────────────── Installing skills from a link ─────────────────────────────

const INSTALL_DIRS = (): { cli: CliId; dir: string }[] => {
  const home = homedir()
  return [
    { cli: 'claude', dir: join(home, '.claude', 'skills') },
    { cli: 'agy', dir: join(home, '.gemini', 'antigravity-cli', 'skills') },
    { cli: 'codex', dir: join(home, '.codex', 'skills') }
  ]
}

function run(cmd: string, args: string[], cwd?: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    let out = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (out += d.toString()))
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('error', (e) => (clearTimeout(timer), rej(e)))
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) res(out)
      else rej(new Error(out.trim().split('\n').slice(-3).join(' ') || `${cmd} failed`))
    })
  })
}

/** Every folder under `root` (up to 5 levels) that contains a SKILL.md. */
function findSkillDirs(root: string): string[] {
  const hits: string[] = []
  const walk = (d: string, depth: number): void => {
    if (depth > 5 || hits.length >= 60) return
    if (existsSync(join(d, 'SKILL.md'))) {
      hits.push(d)
      return // a skill's own sub-folders are its resources, not more skills
    }
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(join(d, e.name), depth + 1)
  }
  walk(root, 0)
  return hits
}

const safeName = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'skill'

/**
 * Install skills from:
 *  - a GitHub repo, folder or SKILL.md link (github.com/owner/repo[/tree|blob/branch/path]) — sparse, shallow clone
 *  - a direct link to a SKILL.md / markdown file
 *  - a link to a .zip containing one or more skill folders
 * Every folder with a SKILL.md is copied into each chosen CLI's skills directory.
 */
async function installSkills(rawUrl: string, targets: CliId[]): Promise<{ installed: string[]; into: CliId[] }> {
  const url = rawUrl.trim()
  if (!/^https:\/\//i.test(url)) throw new Error('Paste a full link starting with https://')
  const dirs = INSTALL_DIRS().filter((d) => targets.includes(d.cli))
  if (!dirs.length) throw new Error('Choose at least one AI to install the skill for')
  const tmp = mkdtempSync(join(tmpdir(), 'aihub-skill-'))
  try {
    let sources: string[] = []
    const gh = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:\/(tree|blob)\/([^/]+)\/?([^#?]*))?\/?(?:[#?].*)?$/i)
    if (gh) {
      const [, owner, repo, kind, branch, subPath] = gh
      const path = (kind === 'blob' ? dirname(subPath).replace(/^\.$/, '') : subPath ?? '').replace(/\/+$/, '')
      if (path.split('/').some((seg) => seg === '..') || (branch && branch.startsWith('-'))) throw new Error('That GitHub link is not valid')
      const repoDir = join(tmp, 'repo')
      const cloneArgs = ['clone', '--depth', '1', '--filter=blob:none', '--sparse', ...(branch ? ['-b', branch] : []), `https://github.com/${owner}/${repo}.git`, repoDir]
      try {
        await run('git', cloneArgs)
      } catch (e) {
        throw new Error(`Could not download ${owner}/${repo}: ${(e as Error).message}`)
      }
      await run('git', ['-C', repoDir, 'sparse-checkout', ...(path ? ['set', '--no-cone', `/${path}/`] : ['disable'])])
      sources = findSkillDirs(path ? join(repoDir, ...path.split('/')) : repoDir)
    } else if (/\.zip(\?|$)/i.test(url)) {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
      if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`)
      const zip = join(tmp, 'skill.zip')
      writeFileSync(zip, Buffer.from(await res.arrayBuffer()))
      const out = join(tmp, 'unzipped')
      if (process.platform === 'win32') {
        await run('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${out.replace(/'/g, "''")}' -Force`])
      } else {
        mkdirSync(out, { recursive: true })
        await run('unzip', ['-q', '-o', zip, '-d', out])
      }
      sources = findSkillDirs(out)
    } else {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
      if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`)
      const text = await res.text()
      if (/<html[\s>]/i.test(text.slice(0, 500))) throw new Error('That link is a web page, not a SKILL.md file. Use the GitHub link or the "Raw" file link.')
      const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ''
      const name = fm.match(/^name:\s*["']?([^"'\n]+)/m)?.[1] ?? url.split('/').filter(Boolean).slice(-2, -1)[0] ?? 'skill'
      const dir = join(tmp, safeName(name))
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), text, 'utf8')
      sources = [dir]
    }
    if (!sources.length) throw new Error('No SKILL.md was found at that link')

    const installed: string[] = []
    for (const src of sources) {
      const fm = readFileSync(join(src, 'SKILL.md'), 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ''
      const name = safeName(fm.match(/^name:\s*["']?([^"'\n]+)/m)?.[1] ?? src.split(/[\\/]/).pop() ?? 'skill')
      for (const d of dirs) {
        const dest = join(d.dir, name)
        mkdirSync(d.dir, { recursive: true })
        rmSync(dest, { recursive: true, force: true })
        cpSync(src, dest, { recursive: true, filter: (p) => !p.split(/[\\/]/).includes('.git') })
      }
      installed.push(name)
    }
    cache = null
    return { installed, into: dirs.map((d) => d.cli) }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
