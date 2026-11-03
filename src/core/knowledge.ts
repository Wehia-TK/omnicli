import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CliId, KnowledgeCategory, KnowledgeEntry, Project } from '@shared/types'
import { all, get, nowLocal, run, transaction } from './db'
import { getSettings } from './settings'

const CATEGORY_TITLES: Record<KnowledgeCategory, string> = {
  architecture: 'Architecture & Stack',
  conventions: 'Conventions & Verification',
  feature: 'Features & Modules',
  decisions: 'Decisions & Gotchas',
  handoff: 'Cross-AI Handoff Log'
}

export function getKnowledgeEntry(id: number): KnowledgeEntry {
  const e = get<KnowledgeEntry>('SELECT * FROM knowledge_entries WHERE id = ?', id)
  if (!e) throw new Error('Knowledge entry not found')
  return e
}

/** Sync the project's unified Knowledge Base to `<dir>/.ai-kb/PROJECT_KNOWLEDGE.md` so any CLI agent can read it directly. */
export function syncKnowledgeToDir(projectId: number, dir: string): string | null {
  if (!dir || !existsSync(dir)) return null
  if (!getSettings().syncKbToDisk) return null
  try {
    const p = get<Project>('SELECT * FROM projects WHERE id = ?', projectId)
    if (!p) return null
    const entries = all<KnowledgeEntry>(
      'SELECT * FROM knowledge_entries WHERE project_id = ? ORDER BY pinned DESC, CASE category WHEN \'architecture\' THEN 1 WHEN \'conventions\' THEN 2 WHEN \'feature\' THEN 3 WHEN \'decisions\' THEN 4 ELSE 5 END, updated_at DESC',
      projectId
    )
    const kbDir = join(dir, '.ai-kb')
    mkdirSync(kbDir, { recursive: true })
    const kbFile = join(kbDir, 'PROJECT_KNOWLEDGE.md')

    const lines: string[] = [
      `# ${p.name} — Shared AI Project Knowledge Base`,
      `> Auto-synced by AI Hub (${nowLocal()}). Accessible to Claude Code, Antigravity, OpenAI Codex, Gemini CLI, and GitHub Copilot.`,
      ''
    ]
    if (p.notes.trim()) {
      lines.push('## Project Standing Notes', p.notes.trim(), '')
    }
    if (p.check_cmd.trim()) {
      lines.push('## Verification Command', `\`\`\`bash\n${p.check_cmd.trim()}\n\`\`\``, '')
    }

    const categories: KnowledgeCategory[] = ['architecture', 'conventions', 'feature', 'decisions', 'handoff']
    for (const cat of categories) {
      const catEntries = entries.filter((e) => e.category === cat)
      if (!catEntries.length) continue
      lines.push(`## ${CATEGORY_TITLES[cat]}`, '')
      for (const e of catEntries) {
        lines.push(`### ${e.title} _(updated ${e.updated_at.slice(0, 16).replace('T', ' ')} by ${e.updated_by})_`)
        if (e.files.trim()) lines.push(`- **Key files**: \`${e.files.trim()}\``)
        lines.push('', e.content.trim(), '')
      }
    }

    writeFileSync(kbFile, lines.join('\n'), 'utf8')

    // Ensure .ai-kb is ignored in git status if this is a standard git repo
    const gitExclude = join(dir, '.git', 'info', 'exclude')
    if (existsSync(join(dir, '.git')) && statSync(join(dir, '.git')).isDirectory()) {
      try {
        const cur = existsSync(gitExclude) ? readFileSync(gitExclude, 'utf8') : ''
        if (!/^\/\.ai-kb$/m.test(cur)) {
          mkdirSync(join(dir, '.git', 'info'), { recursive: true })
          appendFileSync(gitExclude, `${cur && !cur.endsWith('\n') ? '\n' : ''}/.ai-kb\n`)
        }
      } catch {
        // ignore if git info/exclude isn't writable
      }
    }
    return kbFile
  } catch {
    return null
  }
}

/** Build the Knowledge Base context block injected into prompts for any AI subscription CLI. */
export function buildKnowledgePrompt(projectId: number, cwd?: string): string {
  const p = get<Project>('SELECT * FROM projects WHERE id = ?', projectId)
  if (!p) return ''
  if (cwd) syncKnowledgeToDir(projectId, cwd)
  if (p.folder && p.folder !== cwd) syncKnowledgeToDir(projectId, p.folder)

  const pinned = all<KnowledgeEntry>(
    'SELECT * FROM knowledge_entries WHERE project_id = ? AND pinned = 1 ORDER BY CASE category WHEN \'architecture\' THEN 1 WHEN \'conventions\' THEN 2 WHEN \'feature\' THEN 3 WHEN \'decisions\' THEN 4 ELSE 5 END, updated_at DESC LIMIT 12',
    projectId
  )
  if (!pinned.length && !p.notes.trim()) return ''

  const sections = pinned.map((e) => {
    const filesLine = e.files.trim() ? ` [Files: ${e.files.trim()}]` : ''
    return `### [${CATEGORY_TITLES[e.category]}] ${e.title}${filesLine}\n${e.content.trim().slice(0, 1200)}`
  })

  return [
    `=== SHARED PROJECT KNOWLEDGE BASE (${p.name}) ===`,
    `Full file synced at: .ai-kb/PROJECT_KNOWLEDGE.md`,
    p.notes.trim() ? `Project Notes: ${p.notes.trim()}` : '',
    ...sections,
    `=== END PROJECT KNOWLEDGE BASE ===`
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** Record an automatic handoff note in the Project Knowledge Base when an AI completes work or hands over. */
export function recordAiHandoff(
  projectId: number,
  cli: CliId,
  model: string,
  taskTitle: string,
  summary: string,
  changedFiles: string[]
): void {
  if (!getSettings().autoUpdateKb) return
  const now = nowLocal()
  const existing = get<KnowledgeEntry>(
    "SELECT * FROM knowledge_entries WHERE project_id = ? AND category = 'handoff' ORDER BY id DESC LIMIT 1",
    projectId
  )
  const bullet = [
    `- **[${now.slice(0, 16).replace('T', ' ')}] ${cli.toUpperCase()}${model ? ` (${model})` : ''} — ${taskTitle}**`,
    changedFiles.length ? `  - Changed files: \`${changedFiles.slice(0, 10).join('`, `')}\`${changedFiles.length > 10 ? ` (+${changedFiles.length - 10} more)` : ''}` : '',
    summary.trim() ? `  - Summary: ${summary.trim().replace(/\s+/g, ' ').slice(0, 320)}` : ''
  ]
    .filter(Boolean)
    .join('\n')

  if (existing) {
    const prevLines = existing.content.trim().split('\n\n').slice(0, 14)
    const nextContent = [bullet, ...prevLines].join('\n\n')
    const mergedFiles = Array.from(new Set([...changedFiles.slice(0, 8), ...existing.files.split(',').map((s) => s.trim()).filter(Boolean)]))
      .slice(0, 12)
      .join(', ')
    run(
      'UPDATE knowledge_entries SET content = ?, files = ?, updated_by = ?, updated_at = ? WHERE id = ?',
      nextContent,
      mergedFiles,
      cli,
      now,
      existing.id
    )
  } else {
    run(
      `INSERT INTO knowledge_entries (project_id, category, title, content, files, updated_by, pinned, created_at, updated_at)
       VALUES (?, 'handoff', 'Recent Cross-AI Activity & Handoffs', ?, ?, ?, 1, ?, ?)`,
      projectId,
      bullet,
      changedFiles.slice(0, 10).join(', '),
      cli,
      now,
      now
    )
  }
  const p = get<Project>('SELECT * FROM projects WHERE id = ?', projectId)
  if (p?.folder) syncKnowledgeToDir(projectId, p.folder)
}

export const knowledge = {
  list: (projectId: number): KnowledgeEntry[] =>
    all<KnowledgeEntry>(
      `SELECT * FROM knowledge_entries WHERE project_id = ?
       ORDER BY pinned DESC,
         CASE category WHEN 'architecture' THEN 1 WHEN 'conventions' THEN 2 WHEN 'feature' THEN 3 WHEN 'decisions' THEN 4 ELSE 5 END,
         updated_at DESC`,
      projectId
    ),

  save: (
    entry: Partial<KnowledgeEntry> & { project_id: number; title: string; content: string; category?: KnowledgeCategory }
  ): KnowledgeEntry => {
    if (!entry.title.trim()) throw new Error('Give the knowledge base entry a title')
    const now = nowLocal()
    const cat: KnowledgeCategory = entry.category ?? 'feature'
    const id = entry.id
      ? (run(
          `UPDATE knowledge_entries
           SET category = ?, title = ?, content = ?, files = ?, updated_by = ?, pinned = ?, updated_at = ?
           WHERE id = ?`,
          cat,
          entry.title.trim(),
          entry.content,
          (entry.files ?? '').trim(),
          entry.updated_by ?? 'user',
          entry.pinned ?? 1,
          now,
          entry.id
        ),
        entry.id)
      : run(
          `INSERT INTO knowledge_entries (project_id, category, title, content, files, updated_by, pinned, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          entry.project_id,
          cat,
          entry.title.trim(),
          entry.content,
          (entry.files ?? '').trim(),
          entry.updated_by ?? 'user',
          entry.pinned ?? 1,
          now,
          now
        )
    const p = get<Project>('SELECT * FROM projects WHERE id = ?', entry.project_id)
    if (p?.folder) syncKnowledgeToDir(entry.project_id, p.folder)
    return getKnowledgeEntry(id)
  },

  togglePin: (id: number): KnowledgeEntry => {
    const cur = getKnowledgeEntry(id)
    run('UPDATE knowledge_entries SET pinned = ?, updated_at = ? WHERE id = ?', cur.pinned ? 0 : 1, nowLocal(), id)
    const p = get<Project>('SELECT * FROM projects WHERE id = ?', cur.project_id)
    if (p?.folder) syncKnowledgeToDir(cur.project_id, p.folder)
    return getKnowledgeEntry(id)
  },

  delete: (id: number): true => {
    const cur = getKnowledgeEntry(id)
    run('DELETE FROM knowledge_entries WHERE id = ?', id)
    const p = get<Project>('SELECT * FROM projects WHERE id = ?', cur.project_id)
    if (p?.folder) syncKnowledgeToDir(cur.project_id, p.folder)
    return true
  },

  /** Scan the project's repository to populate or refresh Architecture, Conventions, and Feature entries. */
  scanRepo: (projectId: number): KnowledgeEntry[] => {
    const p = get<Project>('SELECT * FROM projects WHERE id = ?', projectId)
    if (!p) throw new Error('Project not found')
    if (!p.folder || !existsSync(p.folder)) throw new Error('Set a valid project folder first to scan its codebase')

    const now = nowLocal()
    const pkgPath = join(p.folder, 'package.json')
    const readmePath = join(p.folder, 'README.md')
    let stackLines: string[] = [`- **Folder**: \`${p.folder}\``]
    let scriptsLines: string[] = []
    const keyFiles: string[] = []

    if (existsSync(pkgPath)) {
      keyFiles.push('package.json')
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
          name?: string
          description?: string
          scripts?: Record<string, string>
          dependencies?: Record<string, string>
          devDependencies?: Record<string, string>
        }
        if (pkg.name) stackLines.push(`- **Package**: \`${pkg.name}\`${pkg.description ? ` — ${pkg.description}` : ''}`)
        const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
        if (deps.length) stackLines.push(`- **Key Dependencies**: \`${deps.slice(0, 18).join('`, `')}\``)
        if (pkg.scripts) {
          for (const [k, v] of Object.entries(pkg.scripts)) {
            scriptsLines.push(`- \`npm run ${k}\`: \`${v}\``)
          }
        }
      } catch {
        // ignore invalid package.json
      }
    }

    // List top-level and src directories
    try {
      const top = readdirSync(p.folder, { withFileTypes: true })
        .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'out' && e.name !== 'release' && e.name !== 'dist')
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      stackLines.push(`- **Top-level layout**: \`${top.slice(0, 20).join('`, `')}\``)

      const srcDir = join(p.folder, 'src')
      if (existsSync(srcDir) && statSync(srcDir).isDirectory()) {
        const srcItems = readdirSync(srcDir, { withFileTypes: true }).map((e) => (e.isDirectory() ? `src/${e.name}/` : `src/${e.name}`))
        stackLines.push(`- **Source tree (\`src/\`)**: \`${srcItems.slice(0, 20).join('`, `')}\``)
      }
    } catch {
      // ignore read errors
    }

    if (existsSync(readmePath)) {
      keyFiles.push('README.md')
      try {
        const readme = readFileSync(readmePath, 'utf8').trim().slice(0, 1000)
        if (readme) stackLines.push('', '### README Excerpt', readme)
      } catch {
        // ignore
      }
    }

    transaction(() => {
      const arch = get<KnowledgeEntry>(
        "SELECT * FROM knowledge_entries WHERE project_id = ? AND category = 'architecture' ORDER BY id LIMIT 1",
        projectId
      )
      if (arch) {
        run(
          'UPDATE knowledge_entries SET content = ?, files = ?, updated_by = ?, updated_at = ? WHERE id = ?',
          stackLines.join('\n'),
          keyFiles.join(', '),
          'scanner',
          now,
          arch.id
        )
      } else {
        run(
          `INSERT INTO knowledge_entries (project_id, category, title, content, files, updated_by, pinned, created_at, updated_at)
           VALUES (?, 'architecture', 'Repository Architecture & Stack', ?, ?, 'scanner', 1, ?, ?)`,
          projectId,
          stackLines.join('\n'),
          keyFiles.join(', '),
          now,
          now
        )
      }

      if (scriptsLines.length) {
        const conv = get<KnowledgeEntry>(
          "SELECT * FROM knowledge_entries WHERE project_id = ? AND category = 'conventions' ORDER BY id LIMIT 1",
          projectId
        )
        const convText = ['### Available NPM Scripts', ...scriptsLines].join('\n')
        if (!conv) {
          run(
            `INSERT INTO knowledge_entries (project_id, category, title, content, files, updated_by, pinned, created_at, updated_at)
             VALUES (?, 'conventions', 'Build & Check Commands', ?, 'package.json', 'scanner', 1, ?, ?)`,
            projectId,
            convText,
            now,
            now
          )
        }
      }
    })

    syncKnowledgeToDir(projectId, p.folder)
    return knowledge.list(projectId)
  }
}
