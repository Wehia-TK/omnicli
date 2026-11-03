import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CliId, SkillInfo } from '@shared/types'
import { get } from './db'

/** Where each CLI loads skills from (SKILL.md folders). */
function skillRoots(projectFolder?: string): { dir: string; native: CliId[]; scope: SkillInfo['scope'] }[] {
  const home = homedir()
  const roots: { dir: string; native: CliId[]; scope: SkillInfo['scope'] }[] = [
    { dir: join(home, '.claude', 'skills'), native: ['claude'], scope: 'user' },
    { dir: join(home, '.gemini', 'antigravity-cli', 'skills'), native: ['agy'], scope: 'user' },
    { dir: join(home, '.gemini', 'antigravity', 'skills'), native: ['agy'], scope: 'user' },
    { dir: join(home, '.gemini', 'skills'), native: ['agy', 'gemini'], scope: 'user' },
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
  read: (path: string): string => {
    if (!/SKILL\.md$/i.test(path) || !existsSync(path)) throw new Error('Skill file not found')
    return readFileSync(path, 'utf8')
  }
}
