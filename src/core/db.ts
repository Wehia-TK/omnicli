import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
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
  `,
  `
  ALTER TABLE projects ADD COLUMN git_remote_url TEXT NOT NULL DEFAULT '';
  ALTER TABLE project_tasks ADD COLUMN codex_thread TEXT;
  -- Claude is now the default AI everywhere
  UPDATE projects SET default_cli = 'claude', default_model = 'claude-opus-5-5', default_effort = 'medium' WHERE default_cli IN ('', 'agy');
  DELETE FROM settings WHERE key IN ('defaultCli', 'defaultModel') AND value IN ('"agy"', '"gemini-4-argon-high"', '"gemini-4-argon"');
  -- Stale rate-limit locks without a reset time used to stick at 100% forever
  DELETE FROM cli_rate_events WHERE resets_at IS NULL;
  `,
  `
  ALTER TABLE project_tasks ADD COLUMN compare_group TEXT;
  ALTER TABLE project_tasks ADD COLUMN pr_url TEXT;
  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    cli TEXT NOT NULL DEFAULT 'claude',
    model TEXT NOT NULL DEFAULT '',
    effort TEXT NOT NULL DEFAULT 'medium',
    permission_mode TEXT NOT NULL DEFAULT 'accept-edits',
    kind TEXT NOT NULL DEFAULT 'daily',
    time_of_day TEXT NOT NULL DEFAULT '09:00',
    every_hours INTEGER NOT NULL DEFAULT 24,
    weekday INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at INTEGER,
    next_run_at INTEGER,
    created_at TEXT NOT NULL
  );
  `
,
  `
  CREATE TABLE IF NOT EXISTS queued_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    mentions TEXT NOT NULL DEFAULT '[]',
    cli TEXT,
    model TEXT,
    effort TEXT,
    permission_mode TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_queued_messages_task ON queued_messages(task_id, id);
  `,
  `
  CREATE TABLE IF NOT EXISTS cli_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cli TEXT NOT NULL,
    label TEXT NOT NULL,
    config_dir TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  ALTER TABLE project_tasks ADD COLUMN account_id INTEGER NOT NULL DEFAULT 0;
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

  return dbPath
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
