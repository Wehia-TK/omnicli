import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

let db: DatabaseSync
let changeCallback: () => void = () => undefined

export function onDbChange(cb: () => void): void {
  changeCallback = cb
}

export function notifyChanged(): void {
  changeCallback()
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    folder TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    check_cmd TEXT NOT NULL DEFAULT '',
    auto_run INTEGER NOT NULL DEFAULT 0,
    default_cli TEXT NOT NULL DEFAULT '',
    default_model TEXT NOT NULL DEFAULT '',
    default_mode TEXT NOT NULL DEFAULT 'default',
    default_checkout TEXT NOT NULL DEFAULT 'local',
    sort INTEGER NOT NULL DEFAULT 0,
    archived_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS project_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'thread',
    title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued',
    sort INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    started_at TEXT,
    done_at TEXT,
    run_state TEXT NOT NULL DEFAULT '',
    session_id TEXT,
    agy_conversation TEXT,
    branch TEXT,
    worktree TEXT,
    base_commit TEXT,
    result TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    runs INTEGER NOT NULL DEFAULT 0,
    tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    run_ms INTEGER NOT NULL DEFAULT 0,
    check_state TEXT NOT NULL DEFAULT '',
    check_output TEXT NOT NULL DEFAULT '',
    cli TEXT NOT NULL DEFAULT '',
    runner TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    permission_mode TEXT NOT NULL DEFAULT 'default',
    checkout_mode TEXT NOT NULL DEFAULT 'local',
    mentions TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_project ON project_tasks(project_id, kind, status);

  CREATE TABLE IF NOT EXISTS knowledge_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    category TEXT NOT NULL DEFAULT 'architecture',
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    files TEXT NOT NULL DEFAULT '',
    updated_by TEXT NOT NULL DEFAULT 'user',
    pinned INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_kb_project ON knowledge_entries(project_id, category);

  CREATE TABLE IF NOT EXISTS usage_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cli TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    project_id INTEGER,
    task_id INTEGER,
    tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    epoch_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_usage_cli_epoch ON usage_logs(cli, epoch_ms);

  CREATE TABLE IF NOT EXISTS cli_rate_events (
    cli TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'ok',
    utilization_pct REAL,
    resets_at TEXT,
    note TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
  `,
  `
  UPDATE projects SET default_model = 'claude-opus-5-5' WHERE default_model IN ('sonnet', 'opus', 'haiku', 'claude-haiku-4-5-20251001');
  `,
  `
  ALTER TABLE projects ADD COLUMN default_effort TEXT NOT NULL DEFAULT 'high';
  ALTER TABLE project_tasks ADD COLUMN effort TEXT NOT NULL DEFAULT 'high';
  UPDATE projects SET default_model = 'gemini-4-argon', default_effort = 'high' WHERE default_model = 'gemini-4-argon-high';
  UPDATE projects SET default_model = 'gemini-4-argon', default_effort = 'medium' WHERE default_model = 'gemini-4-argon-medium';
  UPDATE projects SET default_model = 'gemini-4-argon', default_effort = 'low' WHERE default_model = 'gemini-4-argon-low';
  `
]

export function openDatabase(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(dataDir, 'ai-hub.db')
  db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')

  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  for (let v = user_version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[v])
      db.exec(`PRAGMA user_version = ${v + 1}`)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }

  seedInitialProjects()
  return dbPath
}

function seedInitialProjects(): void {
  const count = (db.prepare('SELECT COUNT(*) AS c FROM projects').get() as { c: number }).c
  if (count > 0) return

  const now = nowLocal()
  const aiWrapperFolder = existsSync('D:\\AI Wrapper') ? 'D:\\AI Wrapper' : process.cwd()
  const personalAppFolder = existsSync('D:\\Personal App') ? 'D:\\Personal App' : ''

  const p1 = Number(
    db
      .prepare(
        `INSERT INTO projects (name, folder, notes, check_cmd, default_cli, default_model, default_mode, default_checkout, sort, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'AI Wrapper',
        aiWrapperFolder,
        'Centralized desktop app for AI CLI subscriptions (Claude Code, Antigravity, Codex, Gemini, Copilot) with live usage limits and shared Project Knowledge Base.',
        'npm run typecheck && npm run build',
        'agy',
        'gemini-4-argon',
        'default',
        'local',
        1,
        now
      ).lastInsertRowid
  )

  db.prepare(
    `INSERT INTO knowledge_entries (project_id, category, title, content, files, updated_by, pinned, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    p1,
    'architecture',
    'App Architecture & Multi-CLI Subscription Engine',
    `# AI Wrapper (AI Hub)\n\n- **Stack**: Electron 44 + electron-vite + React 19 + Tailwind CSS v4 + Node built-in \`node:sqlite\`.\n- **Core Modules**:\n  - \`src/core/clis.ts\`: Detects installed & authenticated subscription CLIs (\`claude\`, \`agy\`, \`codex\`, \`gemini\`, \`copilot\`), queries models, and tracks live 5-hour rolling window limits.\n  - \`src/core/knowledge.ts\`: Unified Project Knowledge Base synced to SQLite and \`.ai-kb/PROJECT_KNOWLEDGE.md\` so every AI CLI shares context seamlessly.\n  - \`src/core/projects.ts\`: Interactive threads + background task queue with isolated git worktrees and automatic CLI limit handover.\n  - \`src/core/terminal.ts\`: Embedded interactive terminal sessions per project/worktree.`,
    'src/core/clis.ts, src/core/knowledge.ts, src/core/projects.ts, src/renderer/src/App.tsx',
    'scanner',
    1,
    now,
    now
  )

  db.prepare(
    `INSERT INTO knowledge_entries (project_id, category, title, content, files, updated_by, pinned, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    p1,
    'conventions',
    'Verification & Coding Conventions',
    `- Always run \`npm run typecheck && npm run build\` to verify changes.\n- Keep subscription CLIs greyed out in the UI when \`authenticated === false\`.\n- Preserve shared knowledge base entries in \`.ai-kb/PROJECT_KNOWLEDGE.md\` when switching between Claude Code and Antigravity.`,
    'package.json, tsconfig.json',
    'scanner',
    1,
    now,
    now
  )

  if (personalAppFolder) {
    const p2 = Number(
      db
        .prepare(
          `INSERT INTO projects (name, folder, notes, check_cmd, default_cli, default_model, default_mode, default_checkout, sort, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'Personal App',
          personalAppFolder,
          'Personal Hub desktop app — tasks, leads, calendar, mail, deployments, and local offline SQLite storage.',
          'npm run typecheck && npm run build',
          'claude',
          'claude-opus-5-5',
          'default',
          'worktree',
          2,
          now
        ).lastInsertRowid
    )

    db.prepare(
      `INSERT INTO knowledge_entries (project_id, category, title, content, files, updated_by, pinned, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      p2,
      'architecture',
      'Personal Hub Overview & Structure',
      `# Personal Hub (D:\\Personal App)\n\n- **Stack**: Electron + Vite + React 19 + Tailwind v4 + \`node:sqlite\` (\`src/core/db.ts\`).\n- **Structure**:\n  - \`src/core/\`: Backend services (tasks, leads, calendar, mail, money, deployments, projects).\n  - \`src/renderer/src/pages/\`: UI pages for each domain.\n  - \`src/shared/\`: Shared utilities and TypeScript types.`,
      'src/core/db.ts, src/core/api.ts, src/renderer/src/App.tsx',
      'scanner',
      1,
      now,
      now
    )
  }
}

type Param = string | number | null

export function all<T>(sql: string, ...params: Param[]): T[] {
  return db.prepare(sql).all(...params).map((r) => ({ ...r }) as T)
}

export function get<T>(sql: string, ...params: Param[]): T | undefined {
  const row = db.prepare(sql).get(...params)
  return row ? ({ ...row } as T) : undefined
}

export function run(sql: string, ...params: Param[]): number {
  const id = Number(db.prepare(sql).run(...params).lastInsertRowid)
  notifyChanged()
  return id
}

export function runSilent(sql: string, ...params: Param[]): number {
  return Number(db.prepare(sql).run(...params).lastInsertRowid)
}

let depth = 0
export function transaction<T>(fn: () => T): T {
  if (depth > 0) {
    depth++
    try {
      return fn()
    } finally {
      depth--
    }
  }
  db.exec('BEGIN')
  depth = 1
  try {
    const out = fn()
    db.exec('COMMIT')
    notifyChanged()
    return out
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  } finally {
    depth = 0
  }
}

export function nowLocal(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
