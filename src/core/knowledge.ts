import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CliId, KnowledgeCategory, KnowledgeEntry, Project } from '@shared/types'
import { all, get, nowLocal, run } from './db'
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
let syncPaused = false

/** Run `fn` without touching .ai-kb files on disk (used for token estimates while typing). */
export function withoutKbSync<T>(fn: () => T): T {
  syncPaused = true
  try {
    return fn()
  } finally {
    syncPaused = false
  }
}

export function syncKnowledgeToDir(projectId: number, dir: string): string | null {
  if (syncPaused || !dir || !existsSync(dir)) return null
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
      `> Auto-synced by AI Hub (${nowLocal()}). Accessible to Claude Code, Antigravity, OpenAI Codex, and GitHub Copilot.`,
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
  const graphReport = [cwd, p.folder].filter(Boolean).some((d) => existsSync(join(d!, 'graphify-out', 'GRAPH_REPORT.md')))
  const kbOnDisk = getSettings().syncKbToDisk

  if (getSettings().kbPromptMode === 'compact') {
    // Token-lean: notes + conventions inline (they change behaviour), everything else as a pointer the agent opens on demand
    const rules = pinned.filter((e) => e.category === 'conventions' || e.category === 'decisions').slice(0, 3)
    const index = pinned.filter((e) => !rules.includes(e)).map((e) => `- [${CATEGORY_TITLES[e.category]}] ${e.title}${e.files.trim() ? ` (${e.files.trim().slice(0, 120)})` : ''}`)
    return [
      `=== PROJECT CONTEXT (${p.name}) ===`,
      p.notes.trim() ? `Notes: ${p.notes.trim().slice(0, 800)}` : '',
      ...rules.map((e) => `### ${e.title}\n${e.content.trim().slice(0, 700)}`),
      index.length ? `Knowledge base entries${kbOnDisk ? ' (full text in .ai-kb/PROJECT_KNOWLEDGE.md — open only what you need)' : ''}:\n${index.join('\n')}` : '',
      graphReport
        ? 'Code map: graphify-out/GRAPH_REPORT.md lists the core modules, god nodes and communities — read it before searching the codebase broadly.'
        : '',
      '=== END PROJECT CONTEXT ==='
    ]
      .filter(Boolean)
      .join('\n\n')
  }

  const sections = pinned.map((e) => {
    const filesLine = e.files.trim() ? ` [Files: ${e.files.trim()}]` : ''
    return `### [${CATEGORY_TITLES[e.category]}] ${e.title}${filesLine}\n${e.content.trim().slice(0, 1200)}`
  })

  return [
    `=== SHARED PROJECT KNOWLEDGE BASE (${p.name}) ===`,
    kbOnDisk ? `Full file synced at: .ai-kb/PROJECT_KNOWLEDGE.md` : '',
    graphReport ? 'Code map: graphify-out/GRAPH_REPORT.md' : '',
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

  /**
   * Scan the repository and refresh the scanner-owned entries (never overwrites entries you wrote).
   * Detects the stack across ecosystems, maps the source tree, and — when graphify is installed — builds a
   * zero-token code graph whose report the AIs read instead of crawling files.
   */
  scanRepo: async (projectId: number): Promise<KnowledgeEntry[]> => {
    const p = get<Project>('SELECT * FROM projects WHERE id = ?', projectId)
    if (!p) throw new Error('Project not found')
    if (!p.folder || !existsSync(p.folder)) throw new Error('Set a valid project folder first to scan its codebase')
    const scan = scanFolder(p.folder)

    let graphNote = ''
    if (getSettings().useGraphify) {
      const g = await runGraphify(p.folder)
      graphNote = g.ok ? '' : g.message
      const report = join(p.folder, 'graphify-out', 'GRAPH_REPORT.md')
      if (g.ok && existsSync(report)) {
        upsertScannerEntry(projectId, 'architecture', 'Code Graph (graphify)', summarizeGraphReport(readFileSync(report, 'utf8')), 'graphify-out/GRAPH_REPORT.md')
      }
      excludeFromGit(p.folder, '/graphify-out')
    }

    // Features & Modules: one entry per real code module (graph communities, else top source folders)
    const graphFile = join(p.folder, 'graphify-out', 'graph.json')
    const modules = getSettings().useGraphify && existsSync(graphFile) ? modulesFromGraph(graphFile) : []
    const featureEntries = modules.length ? modules : modulesFromFolders(p.folder)
    const featureTitles = featureEntries.map((m) => m.title)
    for (const m of featureEntries) upsertScannerEntry(projectId, 'feature', m.title, m.content, m.files)
    // Drop scanner-made module entries that no longer exist (renamed/removed modules)
    for (const old of all<KnowledgeEntry>(
      "SELECT * FROM knowledge_entries WHERE project_id = ? AND category = 'feature' AND updated_by = 'scanner'",
      projectId
    )) {
      if (!featureTitles.includes(old.title)) run('DELETE FROM knowledge_entries WHERE id = ?', old.id)
    }

    // Decisions & Gotchas: TODO/FIXME/HACK notes, import cycles and surprising cross-module coupling
    const gotchas = collectGotchas(p.folder)
    if (gotchas) upsertScannerEntry(projectId, 'decisions', 'Gotchas & Open TODOs (scanner)', gotchas.content, gotchas.files)

    upsertScannerEntry(projectId, 'architecture', 'Repository Architecture & Stack', scan.architecture, scan.keyFiles.join(', '))
    if (scan.commands.length) upsertScannerEntry(projectId, 'conventions', 'Build & Check Commands', scan.commands.join('\n'), scan.commandFiles.join(', '))
    // Older scans wrote under a generic title — retire those duplicates (scanner-owned only)
    run(
      "DELETE FROM knowledge_entries WHERE project_id = ? AND updated_by = 'scanner' AND title NOT IN ('Repository Architecture & Stack', 'Build & Check Commands', 'Code Graph (graphify)') AND title LIKE 'Repository%'",
      projectId
    )
    if (!p.check_cmd.trim() && scan.suggestedCheck) run('UPDATE projects SET check_cmd = ? WHERE id = ?', scan.suggestedCheck, projectId)

    syncKnowledgeToDir(projectId, p.folder)
    if (graphNote) throw new Error(`Knowledge base updated, but the code graph was skipped: ${graphNote}`)
    return knowledge.list(projectId)
  }
}

/** Update the scanner's own entry by title, or create it. Entries edited by a user/AI are left alone. */
function upsertScannerEntry(projectId: number, category: KnowledgeCategory, title: string, content: string, files: string): void {
  const now = nowLocal()
  const existing = get<KnowledgeEntry>('SELECT * FROM knowledge_entries WHERE project_id = ? AND title = ? ORDER BY id LIMIT 1', projectId, title)
  if (existing && existing.updated_by !== 'scanner') return
  if (existing) {
    run('UPDATE knowledge_entries SET content = ?, files = ?, category = ?, updated_at = ? WHERE id = ?', content, files, category, now, existing.id)
  } else {
    run(
      `INSERT INTO knowledge_entries (project_id, category, title, content, files, updated_by, pinned, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'scanner', 1, ?, ?)`,
      projectId,
      category,
      title,
      content,
      files,
      now,
      now
    )
  }
}

const IGNORED_DIRS = new Set([
  'node_modules', 'out', 'release', 'dist', 'build', 'target', 'bin', 'obj', 'vendor', 'coverage', '__pycache__',
  'venv', '.venv', 'env', 'graphify-out', 'data', 'tmp', 'temp', 'logs'
])

const LANG_BY_EXT: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript/React', js: 'JavaScript', jsx: 'JavaScript/React', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', rs: 'Rust', go: 'Go', java: 'Java', kt: 'Kotlin', cs: 'C#', cpp: 'C++', cc: 'C++', c: 'C', h: 'C/C++ header',
  swift: 'Swift', rb: 'Ruby', php: 'PHP', dart: 'Dart', vue: 'Vue', svelte: 'Svelte', html: 'HTML', css: 'CSS', scss: 'SCSS',
  sql: 'SQL', sh: 'Shell', ps1: 'PowerShell', lua: 'Lua', gd: 'GDScript'
}

function scanFolder(folder: string): {
  architecture: string
  keyFiles: string[]
  commands: string[]
  commandFiles: string[]
  suggestedCheck: string
} {
  const keyFiles: string[] = []
  const commands: string[] = []
  const commandFiles: string[] = []
  const stack: string[] = []
  let suggestedCheck = ''
  const has = (f: string): boolean => existsSync(join(folder, f))
  const readJson = <T>(f: string): T | null => {
    try {
      return JSON.parse(readFileSync(join(folder, f), 'utf8')) as T
    } catch {
      return null
    }
  }

  // ── Node / JS
  if (has('package.json')) {
    keyFiles.push('package.json')
    const pkg = readJson<{
      name?: string
      description?: string
      scripts?: Record<string, string>
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }>('package.json')
    if (pkg) {
      if (pkg.name) stack.push(`- **Package**: \`${pkg.name}\`${pkg.description ? ` — ${pkg.description}` : ''}`)
      const deps = Object.keys(pkg.dependencies ?? {})
      const dev = Object.keys(pkg.devDependencies ?? {})
      const frameworks = [...deps, ...dev].filter((d) =>
        /^(react|react-dom|next|vue|nuxt|svelte|@sveltejs\/kit|angular|@angular\/core|electron|express|fastify|nestjs|@nestjs\/core|vite|electron-vite|tailwindcss|prisma|drizzle-orm|typescript|three|expo|react-native)$/.test(d)
      )
      if (frameworks.length) stack.push(`- **Frameworks**: ${frameworks.map((f) => `\`${f}\``).join(', ')}`)
      if (deps.length) stack.push(`- **Dependencies (${deps.length})**: ${deps.slice(0, 15).map((d) => `\`${d}\``).join(', ')}${deps.length > 15 ? ' …' : ''}`)
      const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm'
      for (const [k, v] of Object.entries(pkg.scripts ?? {})) commands.push(`- \`${pm} run ${k}\` → \`${v}\``)
      if (pkg.scripts) commandFiles.push('package.json')
      const checks = ['typecheck', 'lint', 'test', 'build'].filter((k) => pkg.scripts?.[k])
      if (checks.length) suggestedCheck = checks.filter((k) => k !== 'test' || !/watch/.test(pkg.scripts![k])).map((k) => `${pm} run ${k}`).join(' && ')
    }
  }
  // ── Other ecosystems
  const markers: [string, string, string?][] = [
    ['pyproject.toml', 'Python (pyproject)', 'pytest'],
    ['requirements.txt', 'Python (requirements.txt)'],
    ['Cargo.toml', 'Rust (Cargo)', 'cargo check && cargo test'],
    ['go.mod', 'Go modules', 'go build ./... && go test ./...'],
    ['pom.xml', 'Java (Maven)', 'mvn -q verify'],
    ['build.gradle', 'JVM (Gradle)', 'gradle build'],
    ['build.gradle.kts', 'JVM (Gradle Kotlin)', 'gradle build'],
    ['Gemfile', 'Ruby (Bundler)'],
    ['composer.json', 'PHP (Composer)'],
    ['pubspec.yaml', 'Dart/Flutter', 'flutter analyze'],
    ['project.godot', 'Godot project'],
    ['Dockerfile', 'Docker'],
    ['docker-compose.yml', 'Docker Compose'],
    ['Makefile', 'Make']
  ]
  for (const [file, label, check] of markers) {
    if (!has(file)) continue
    keyFiles.push(file)
    stack.push(`- **${label}**: \`${file}\``)
    if (check && !suggestedCheck) suggestedCheck = check
  }
  try {
    const sln = readdirSync(folder).find((f) => /\.(sln|csproj)$/i.test(f))
    if (sln) {
      keyFiles.push(sln)
      stack.push(`- **.NET**: \`${sln}\``)
      if (!suggestedCheck) suggestedCheck = 'dotnet build'
    }
  } catch {
    // ignore
  }
  for (const doc of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'CONTRIBUTING.md']) if (has(doc)) keyFiles.push(doc)

  // ── Source tree map + language mix (bounded walk)
  const langCount = new Map<string, number>()
  const dirSummary: string[] = []
  let fileCount = 0
  const walk = (dir: string, depth: number, rel: string): number => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return 0
    }
    let count = 0
    for (const e of entries) {
      if (fileCount > 6000) break
      if (e.name.startsWith('.') || IGNORED_DIRS.has(e.name) || /-worktrees$/.test(e.name)) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        const n = walk(full, depth + 1, rel ? `${rel}/${e.name}` : e.name)
        count += n
        if (depth < 2 && n > 0) dirSummary.push(`${'  '.repeat(depth)}- \`${rel ? `${rel}/` : ''}${e.name}/\` (${n} files)`)
      } else {
        fileCount++
        count++
        const ext = e.name.split('.').pop()?.toLowerCase() ?? ''
        const lang = LANG_BY_EXT[ext]
        if (lang) langCount.set(lang, (langCount.get(lang) ?? 0) + 1)
      }
    }
    return count
  }
  walk(folder, 0, '')
  const langs = [...langCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)

  // ── Git context
  let gitLine = ''
  try {
    const r = spawnSync('git', ['-C', folder, 'log', '-5', '--format=%h %s'], { encoding: 'utf8', windowsHide: true, timeout: 8000 })
    const remote = spawnSync('git', ['-C', folder, 'remote', 'get-url', 'origin'], { encoding: 'utf8', windowsHide: true, timeout: 8000 })
    if (r.status === 0 && r.stdout.trim()) {
      gitLine = [`- **Remote**: ${remote.status === 0 ? `\`${remote.stdout.trim()}\`` : 'none'}`, '- **Recent commits**:', ...r.stdout.trim().split('\n').map((l) => `  - ${l}`)].join('\n')
    }
  } catch {
    // ignore
  }

  // ── README excerpt (first meaningful paragraph only — keeps the KB small)
  let readme = ''
  try {
    const name = readdirSync(folder).find((f) => /^readme(\.md|\.txt)?$/i.test(f))
    if (name) {
      keyFiles.push(name)
      readme = readFileSync(join(folder, name), 'utf8')
        .replace(/<[^>]+>/g, '')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .trim()
        .slice(0, 700)
    }
  } catch {
    // ignore
  }

  const architecture = [
    `- **Folder**: \`${folder}\` · ${fileCount}${fileCount > 6000 ? '+' : ''} files`,
    langs.length ? `- **Languages**: ${langs.map(([l, n]) => `${l} (${n})`).join(', ')}` : '',
    ...stack,
    dirSummary.length ? ['', '### Source layout', ...dirSummary.slice(0, 40)].join('\n') : '',
    gitLine ? ['', '### Git', gitLine].join('\n') : '',
    readme ? ['', '### README excerpt', readme].join('\n') : ''
  ]
    .filter(Boolean)
    .join('\n')

  return { architecture, keyFiles: [...new Set(keyFiles)], commands, commandFiles, suggestedCheck }
}

/** Run `graphify update <folder>` (AST-only extraction — no LLM, no tokens). */
function runGraphify(folder: string): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    const python = process.platform === 'win32' ? 'python' : 'python3'
    const child = spawn(python, ['-m', 'graphify', 'update', folder], { cwd: folder, windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (out += d.toString()))
    const timer = setTimeout(() => child.kill(), 4 * 60_000)
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ ok: false, message: 'Python is not on PATH (install graphify with `pip install graphifyy`)' })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) return resolve({ ok: true, message: '' })
      const msg = /No module named graphify/i.test(out) ? 'graphify is not installed (`pip install graphifyy`)' : out.trim().split('\n').slice(-2).join(' ')
      resolve({ ok: false, message: msg || `graphify exited with ${code}` })
    })
  })
}

/** Keep only the navigational parts of GRAPH_REPORT.md (hubs + god nodes) — the rest stays on disk. */
function summarizeGraphReport(report: string): string {
  const section = (title: string, max: number): string => {
    const m = report.match(new RegExp(`## ${title}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`))
    return m ? m[1].trim().split('\n').slice(0, max).join('\n') : ''
  }
  const summary = section('Summary', 3)
  const hubs = section('Community Hubs', 14)
  const gods = section('God Nodes', 12)
  return [
    'Generated by graphify (AST extraction, 0 tokens). Full map: `graphify-out/GRAPH_REPORT.md`, graph: `graphify-out/graph.json` (query with `python -m graphify explain "<node>"`).',
    summary && `### Summary\n${summary}`,
    hubs && `### Module hubs\n${hubs}`,
    gods && `### Core abstractions (most connected)\n${gods}`
  ]
    .filter(Boolean)
    .join('\n\n')
}

function excludeFromGit(dir: string, pattern: string): void {
  const gitDir = join(dir, '.git')
  if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) return
  try {
    const file = join(gitDir, 'info', 'exclude')
    const cur = existsSync(file) ? readFileSync(file, 'utf8') : ''
    if (cur.split(/\r?\n/).includes(pattern)) return
    mkdirSync(join(gitDir, 'info'), { recursive: true })
    appendFileSync(file, `${cur && !cur.endsWith('\n') ? '\n' : ''}${pattern}\n`)
  } catch {
    // ignore
  }
}

interface ModuleSummary {
  title: string
  content: string
  files: string
}

const CODE_EXT = /\.(tsx?|jsx?|mjs|cjs|py|rs|go|java|kt|cs|cpp|cc|c|h|swift|rb|php|dart|vue|svelte|gd|lua)$/i

/**
 * Turn graphify communities into module entries: the files in each community, its most-connected
 * symbols, and which other modules it calls into. Config-only communities (package.json, tsconfig) are skipped.
 */
function modulesFromGraph(graphFile: string): ModuleSummary[] {
  type GNode = { id: string; label?: string; community?: number; community_name?: string; source_file?: string }
  type GLink = { source: string; target: string }
  let g: { nodes?: GNode[]; links?: GLink[] }
  try {
    g = JSON.parse(readFileSync(graphFile, 'utf8'))
  } catch {
    return []
  }
  const nodes = (g.nodes ?? []).filter((n) => n.community != null && n.source_file && CODE_EXT.test(n.source_file))
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const degree = new Map<string, number>()
  const crossCalls = new Map<number, Map<number, number>>()
  for (const l of g.links ?? []) {
    const a = byId.get(l.source)
    const b = byId.get(l.target)
    if (a) degree.set(a.id, (degree.get(a.id) ?? 0) + 1)
    if (b) degree.set(b.id, (degree.get(b.id) ?? 0) + 1)
    if (a && b && a.community !== b.community) {
      const m = crossCalls.get(a.community!) ?? new Map<number, number>()
      m.set(b.community!, (m.get(b.community!) ?? 0) + 1)
      crossCalls.set(a.community!, m)
    }
  }
  const groups = new Map<number, GNode[]>()
  for (const n of nodes) groups.set(n.community!, [...(groups.get(n.community!) ?? []), n])

  const filesOf = (members: GNode[]): string[] => {
    const files = new Map<string, number>()
    for (const n of members) {
      const f = n.source_file!.replace(/\\/g, '/')
      files.set(f, (files.get(f) ?? 0) + 1)
    }
    return [...files.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f)
  }
  const nameOf = (c: number): string => filesOf(groups.get(c) ?? [])[0] ?? `module ${c}`

  const used = new Set<string>()
  return [...groups.entries()]
    .filter(([, members]) => members.length >= 3)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 12)
    .map(([c, members]) => {
      const fileList = filesOf(members)
      const ranked = [...members].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
      const symbols = ranked.slice(0, 10).map((n) => `\`${n.label ?? n.id}\``)
      const deps = [...(crossCalls.get(c)?.entries() ?? [])]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([other, n]) => `\`${nameOf(other)}\` (${n} calls)`)
      let title = `Module: ${fileList[0]}`
      if (used.has(title)) title = `${title} (${c})`
      used.add(title)
      return {
        title,
        content: [
          `- **Files (${fileList.length})**: ${fileList.slice(0, 8).map((f) => `\`${f}\``).join(', ')}${fileList.length > 8 ? ' …' : ''}`,
          `- **Key symbols**: ${symbols.join(', ')}`,
          deps.length ? `- **Calls into**: ${deps.join(', ')}` : '',
          `- ${members.length} symbols · explore with \`python -m graphify explain "${ranked[0]?.label ?? fileList[0]}"\``
        ]
          .filter(Boolean)
          .join('\n'),
        files: fileList.slice(0, 10).join(', ')
      }
    })
}

/** Fallback without graphify: one entry per source folder with its files and exported symbols. */
function modulesFromFolders(folder: string): ModuleSummary[] {
  const roots = ['src', 'app', 'lib', 'packages', 'server', 'client', 'components', 'pages', 'scripts']
  const dirs: string[] = []
  for (const r of roots) {
    const full = join(folder, r)
    if (!existsSync(full) || !statSync(full).isDirectory()) continue
    const subs = readdirSync(full, { withFileTypes: true }).filter((e) => e.isDirectory() && !IGNORED_DIRS.has(e.name) && !e.name.startsWith('.'))
    if (subs.length) dirs.push(...subs.map((s) => `${r}/${s.name}`))
    else dirs.push(r)
  }
  if (!dirs.length) dirs.push('.')
  const exportRe =
    /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|const|class|interface|type|enum)\s+([A-Za-z0-9_$]+)|^(?:def|class)\s+([A-Za-z0-9_]+)|^pub\s+(?:fn|struct|enum|trait)\s+([A-Za-z0-9_]+)|^func\s+(?:\([^)]*\)\s*)?([A-Z][A-Za-z0-9_]*)/gm
  const out: ModuleSummary[] = []
  for (const rel of dirs.slice(0, 12)) {
    const files: string[] = []
    const walk = (d: string, depth: number): void => {
      if (depth > 3 || files.length > 60) return
      let entries
      try {
        entries = readdirSync(join(folder, d), { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (e.name.startsWith('.') || IGNORED_DIRS.has(e.name)) continue
        const r = d === '.' ? e.name : `${d}/${e.name}`
        if (e.isDirectory()) {
          if (d !== '.') walk(r, depth + 1)
        } else if (CODE_EXT.test(e.name)) files.push(r)
      }
    }
    walk(rel, 0)
    if (!files.length) continue
    const symbols: string[] = []
    for (const f of files.slice(0, 25)) {
      try {
        const src = readFileSync(join(folder, f), 'utf8').slice(0, 60_000)
        for (const m of src.matchAll(exportRe)) {
          const name = m[1] ?? m[2] ?? m[3] ?? m[4]
          if (name && !symbols.includes(name)) symbols.push(name)
          if (symbols.length >= 14) break
        }
      } catch {
        // ignore
      }
    }
    out.push({
      title: `Module: ${rel}/`,
      content: [
        `- **Files (${files.length})**: ${files.slice(0, 8).map((f) => `\`${f}\``).join(', ')}${files.length > 8 ? ' …' : ''}`,
        symbols.length ? `- **Exports**: ${symbols.map((s) => `\`${s}\``).join(', ')}` : ''
      ]
        .filter(Boolean)
        .join('\n'),
      files: files.slice(0, 10).join(', ')
    })
  }
  return out
}

/** TODO/FIXME/HACK/XXX comments plus graphify's import cycles and surprising connections. */
function collectGotchas(folder: string): { content: string; files: string } | null {
  const notes: string[] = []
  const files = new Set<string>()
  let scanned = 0
  const walk = (d: string, depth: number): void => {
    if (depth > 6 || notes.length >= 20 || scanned > 1500) return
    let entries
    try {
      entries = readdirSync(join(folder, d), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || IGNORED_DIRS.has(e.name) || /-worktrees$/.test(e.name)) continue
      const rel = d ? `${d}/${e.name}` : e.name
      if (e.isDirectory()) walk(rel, depth + 1)
      else if (CODE_EXT.test(e.name)) {
        scanned++
        try {
          readFileSync(join(folder, rel), 'utf8')
            .split('\n')
            .forEach((line, i) => {
              const m = line.match(/(?:\/\/|#|\/\*|^\s*\*)\s*(TODO|FIXME|HACK|XXX|BUG)\b[:\s-]*(.{0,140})/)
              if (m && notes.length < 20) {
                notes.push(`- **${m[1]}** \`${rel}:${i + 1}\` — ${m[2].replace(/\*\/\s*$/, '').trim() || '(no detail)'}`)
                files.add(rel)
              }
            })
        } catch {
          // ignore
        }
      }
    }
  }
  walk('', 0)

  const parts: string[] = []
  if (notes.length) parts.push('### Open TODO / FIXME notes', ...notes)
  const report = join(folder, 'graphify-out', 'GRAPH_REPORT.md')
  if (existsSync(report)) {
    const txt = readFileSync(report, 'utf8')
    const section = (title: string, max: number): string => {
      const m = txt.match(new RegExp(`## ${title}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`))
      return m ? m[1].trim().split('\n').slice(0, max).join('\n') : ''
    }
    const cycles = section('Import Cycles', 10)
    if (cycles && !/none detected/i.test(cycles)) parts.push('', '### Import cycles (graphify)', cycles)
    const surprising = section('Surprising Connections', 10)
    if (surprising) parts.push('', '### Cross-module coupling worth knowing (graphify)', surprising)
  }
  if (!parts.length) return null
  return { content: parts.join('\n'), files: [...files].slice(0, 10).join(', ') }
}
