import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { DiffHunk, LogLine, PrInfo, Project, ProjectTask, SearchHit } from '@shared/types'
import { all, get, nowLocal, run } from './db'

let dataDir = ''
let logDir = ''

export function initWorkspace(dir: string): void {
  dataDir = dir
  logDir = join(dir, 'project-logs')
}

const project = (id: number): Project => {
  const p = get<Project>('SELECT * FROM projects WHERE id = ?', id)
  if (!p) throw new Error('That project no longer exists')
  return p
}
const task = (id: number): ProjectTask => {
  const t = get<ProjectTask>('SELECT * FROM project_tasks WHERE id = ?', id)
  if (!t) throw new Error('That task no longer exists')
  return t
}
const taskCwd = (t: ProjectTask): string => {
  const p = project(t.project_id)
  return t.worktree && existsSync(t.worktree) ? t.worktree : p.folder
}

function runAsync(cmd: string, args: string[], cwd: string, input?: string, timeoutMs = 180_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' } })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (err += d.toString()))
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error((e as NodeJS.ErrnoException).code === 'ENOENT' ? `${cmd} is not installed or not on PATH` : e.message))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error((err || out).trim().split('\n').slice(-4).join(' ') || `${cmd} ${args[0]} failed`))
    })
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

const gitSync = (cwd: string, args: string[]): string => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 50 * 1024 * 1024 })
  if (r.status !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ') || `git ${args[0]} failed`)
  return r.stdout
}

// ───────────────────────────── Rules (CLAUDE.md / AGENTS.md / GEMINI.md / Copilot) ─────────────────────────────

const RULE_FILES = ['CLAUDE.md', 'AGENTS.md', '.github/copilot-instructions.md'] as const
const START = '<!-- AI Hub rules: start (edited in AI Hub — shared by every AI) -->'
const END = '<!-- AI Hub rules: end -->'

export const rules = {
  get: (projectId: number): { text: string; files: { name: string; exists: boolean; managed: boolean; otherContent: boolean }[] } => {
    const p = project(projectId)
    if (!p.folder) throw new Error('Set a folder for this project first')
    let text = ''
    const files = RULE_FILES.map((name) => {
      const path = join(p.folder, name)
      if (!existsSync(path)) return { name, exists: false, managed: false, otherContent: false }
      const raw = readFileSync(path, 'utf8')
      const s = raw.indexOf(START)
      const e = raw.indexOf(END)
      const managed = s >= 0 && e > s
      if (managed && !text) text = raw.slice(s + START.length, e).trim()
      const other = managed ? (raw.slice(0, s) + raw.slice(e + END.length)).trim() : raw.trim()
      if (!managed && !text && name === 'CLAUDE.md') text = raw.trim() // first edit adopts the existing CLAUDE.md
      return { name, exists: true, managed, otherContent: Boolean(other) && managed }
    })
    return { text, files }
  },

  /** Write the shared rules into a managed block in every rule file; anything outside the block is kept. */
  save: (projectId: number, text: string, targets: string[] = [...RULE_FILES]): true => {
    const p = project(projectId)
    if (!p.folder || !existsSync(p.folder)) throw new Error('Set a valid folder for this project first')
    const block = `${START}\n${text.trim()}\n${END}`
    for (const name of targets) {
      if (!(RULE_FILES as readonly string[]).includes(name)) continue
      const path = join(p.folder, name)
      mkdirSync(dirname(path), { recursive: true })
      let raw = existsSync(path) ? readFileSync(path, 'utf8') : ''
      const s = raw.indexOf(START)
      const e = raw.indexOf(END)
      if (s >= 0 && e > s) raw = raw.slice(0, s) + block + raw.slice(e + END.length)
      else if (name === 'CLAUDE.md' && raw.trim() === text.trim()) raw = `${block}\n`
      else raw = raw.trim() ? `${block}\n\n${raw}` : `${block}\n`
      writeFileSync(path, raw, 'utf8')
    }
    return true
  }
}

// ───────────────────────────── Image attachments ─────────────────────────────

export const attachments = {
  /** Save a pasted / dropped image so every CLI can open it by path. */
  saveImage: (dataUrl: string, name = 'pasted'): string => {
    const m = dataUrl.match(/^data:image\/(png|jpe?g|gif|webp|bmp);base64,(.+)$/i)
    if (!m) throw new Error('Only PNG, JPEG, GIF, WebP or BMP images can be attached')
    const dir = join(dataDir, 'attachments')
    mkdirSync(dir, { recursive: true })
    const safe = name.replace(/\.[a-z0-9]+$/i, '').replace(/[^\w-]+/g, '-').slice(0, 40) || 'image'
    const file = join(dir, `${Date.now()}-${safe}.${m[1].toLowerCase().replace('jpeg', 'jpg')}`)
    writeFileSync(file, Buffer.from(m[2], 'base64'))
    return file
  },

  /** Image as a data URL for previews (attachments can live anywhere on disk). */
  readImage: (path: string): string => {
    const ext = path.split('.').pop()?.toLowerCase() ?? ''
    const mime: Record<string, string> = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', webp: 'webp', bmp: 'bmp' }
    if (!mime[ext] || !existsSync(path)) throw new Error('Image not found')
    const buf = readFileSync(path)
    if (buf.length > 15 * 1024 * 1024) throw new Error('Image is too large to preview')
    return `data:image/${mime[ext]};base64,${buf.toString('base64')}`
  }
}

// ───────────────────────────── Search across sessions ─────────────────────────────

export const history = {
  search: (query: string, projectId?: number): SearchHit[] => {
    const q = query.trim()
    if (q.length < 2) return []
    const like = `%${q.replace(/[%_]/g, '')}%`
    const hits: SearchHit[] = []
    const seen = new Set<number>()
    const rows = all<ProjectTask & { project_name: string }>(
      `SELECT t.*, p.name AS project_name FROM project_tasks t JOIN projects p ON p.id = t.project_id
       WHERE (t.title LIKE ? OR t.notes LIKE ? OR t.result LIKE ?) ${projectId ? 'AND t.project_id = ?' : ''}
       ORDER BY t.id DESC LIMIT 60`,
      ...(projectId ? [like, like, like, projectId] : [like, like, like])
    )
    const lower = q.toLowerCase()
    const snippetOf = (text: string): string => {
      const i = text.toLowerCase().indexOf(lower)
      return i < 0 ? text.slice(0, 160) : `${i > 60 ? '…' : ''}${text.slice(Math.max(0, i - 60), i + 100)}`.replace(/\s+/g, ' ')
    }
    for (const t of rows) {
      seen.add(t.id)
      const src = [t.title, t.notes, t.result].find((x) => x?.toLowerCase().includes(lower)) ?? t.title
      hits.push({ taskId: t.id, projectId: t.project_id, projectName: t.project_name, title: t.title, snippet: snippetOf(src), at: t.created_at })
    }
    // Full transcripts live in log files
    if (existsSync(logDir) && hits.length < 60) {
      const meta = new Map(
        all<{ id: number; project_id: number; title: string; created_at: string; project_name: string }>(
          'SELECT t.id, t.project_id, t.title, t.created_at, p.name AS project_name FROM project_tasks t JOIN projects p ON p.id = t.project_id'
        ).map((r) => [r.id, r])
      )
      for (const f of readdirSync(logDir)) {
        const id = Number(f.match(/^task-(\d+)\.log$/)?.[1])
        const m = meta.get(id)
        if (!m || seen.has(id) || (projectId && m.project_id !== projectId)) continue
        let raw = ''
        try {
          raw = readFileSync(join(logDir, f), 'utf8')
        } catch {
          continue
        }
        if (!raw.toLowerCase().includes(lower)) continue
        const line = raw.split('\n').find((l) => l.toLowerCase().includes(lower)) ?? ''
        let text = line
        try {
          text = (JSON.parse(line) as LogLine).text
        } catch {
          // keep raw
        }
        hits.push({ taskId: id, projectId: m.project_id, projectName: m.project_name, title: m.title, snippet: snippetOf(text), at: m.created_at })
        if (hits.length >= 60) break
      }
    }
    return hits
  },

  /** Import Claude Code and Antigravity conversations that ran in this project's folder as resumable sessions. */
  importExisting: (projectId: number): { claude: number; agy: number } => {
    const p = project(projectId)
    if (!p.folder) throw new Error('Set a folder for this project first')
    mkdirSync(logDir, { recursive: true })
    const home = homedir()
    const counts = { claude: 0, agy: 0 }
    const writeLog = (id: number, lines: LogLine[]): void => {
      writeFileSync(join(logDir, `task-${id}.log`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
    }
    const insert = (title: string, cli: 'claude' | 'agy', sessionField: 'session_id' | 'agy_conversation', sessionId: string, created: string, result: string): number =>
      run(
        `INSERT INTO project_tasks (project_id, kind, title, notes, status, sort, created_at, started_at, run_state, ${sessionField}, cli, runner, model, permission_mode, checkout_mode, worktree, result)
         VALUES (?, 'thread', ?, '', 'doing', 0, ?, ?, 'waiting', ?, ?, ?, '', 'default', 'local', ?, ?)`,
        projectId,
        title.slice(0, 110) || 'Imported session',
        created,
        created,
        sessionId,
        cli,
        cli,
        p.folder,
        result.slice(0, 4000)
      )
    const toLocal = (iso: string | undefined): string => (iso ? new Date(iso).toISOString().slice(0, 19) : nowLocal())

    // Claude Code: ~/.claude/projects/<folder with every non-alphanumeric → '-'>/<session>.jsonl
    const enc = p.folder.replace(/[^A-Za-z0-9]/g, '-')
    const cdir = join(home, '.claude', 'projects', enc)
    if (existsSync(cdir)) {
      for (const f of readdirSync(cdir).filter((x) => x.endsWith('.jsonl'))) {
        const sid = f.replace(/\.jsonl$/, '')
        if (get('SELECT 1 AS x FROM project_tasks WHERE session_id = ?', sid)) continue
        const lines: LogLine[] = []
        let title = ''
        let first = ''
        let lastText = ''
        try {
          for (const raw of readFileSync(join(cdir, f), 'utf8').split('\n')) {
            if (!raw.trim()) continue
            let o: { type?: string; timestamp?: string; isMeta?: boolean; message?: { content?: unknown; model?: string } }
            try {
              o = JSON.parse(raw)
            } catch {
              continue
            }
            const at = toLocal(o.timestamp)
            if (!first && o.timestamp) first = at
            const content = o.message?.content
            if (o.type === 'user' && !o.isMeta) {
              const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n') : ''
              if (text.trim() && !text.startsWith('<')) {
                if (!title) title = text.trim().split('\n')[0]
                lines.push({ at, kind: 'you', text: text.slice(0, 4000), cli: 'claude' })
              }
            } else if (o.type === 'assistant' && Array.isArray(content)) {
              for (const c of content as { type: string; text?: string; name?: string; input?: Record<string, unknown> }[]) {
                if (c.type === 'text' && c.text?.trim()) {
                  lines.push({ at, kind: 'text', text: c.text, cli: 'claude', model: o.message?.model })
                  lastText = c.text
                } else if (c.type === 'tool_use' && c.name) {
                  const arg = c.input?.command ?? c.input?.file_path ?? c.input?.pattern ?? ''
                  lines.push({ at, kind: 'tool', text: `${c.name} ${String(arg)}`.trim(), cli: 'claude' })
                }
              }
            }
          }
        } catch {
          continue
        }
        if (!lines.some((l) => l.kind === 'you')) continue
        const id = insert(title, 'claude', 'session_id', sid, first || nowLocal(), lastText)
        writeLog(id, [{ at: first || nowLocal(), kind: 'info', text: 'Imported from Claude Code — reply to resume this session', cli: 'claude' }, ...lines.slice(-400)])
        counts.claude++
      }
    }

    // Antigravity: conversations whose workspace is this folder
    const folderUri = `file:///${p.folder.replace(/\\/g, '/')}`.toLowerCase()
    for (const appDir of ['antigravity-cli', 'antigravity']) {
      const base = join(home, '.gemini', appDir)
      const ids = new Map<string, string>()
      try {
        const last = JSON.parse(readFileSync(join(base, 'cache', 'last_conversations.json'), 'utf8')) as Record<string, string>
        for (const [folder, cid] of Object.entries(last)) if (folder.toLowerCase() === p.folder.toLowerCase()) ids.set(cid, '')
      } catch {
        // ignore
      }
      try {
        const meta = JSON.parse(readFileSync(join(base, 'cache', 'conversation_metadata.json'), 'utf8')) as {
          conversations?: Record<string, { summary?: { Title?: string; WorkspaceURIs?: string[] | null } }>
        }
        for (const [cid, c] of Object.entries(meta.conversations ?? {})) {
          const uris = (c.summary?.WorkspaceURIs ?? []).map((u) => decodeURIComponent(u).toLowerCase())
          if (ids.has(cid) || uris.some((u) => u.startsWith(folderUri))) ids.set(cid, c.summary?.Title ?? '')
        }
      } catch {
        // ignore
      }
      for (const [cid, metaTitle] of ids) {
        if (get('SELECT 1 AS x FROM project_tasks WHERE agy_conversation = ?', cid)) continue
        const transcript = join(base, 'brain', cid, '.system_generated', 'logs', 'transcript.jsonl')
        if (!existsSync(transcript)) continue
        const lines: LogLine[] = []
        let title = metaTitle
        let first = ''
        let lastText = ''
        for (const raw of readFileSync(transcript, 'utf8').split('\n')) {
          try {
            const o = JSON.parse(raw) as { type?: string; created_at?: string; content?: string }
            const at = toLocal(o.created_at)
            if (!first) first = at
            if (o.type === 'USER_INPUT' && o.content) {
              const m = o.content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/)
              let text = (m ? m[1] : o.content).trim()
              text = text.replace(/=== (SHARED PROJECT KNOWLEDGE BASE|PROJECT CONTEXT)[\s\S]*?=== END [A-Z ]+===/g, '').trim()
              if (!title) title = text.split('\n')[0]
              lines.push({ at, kind: 'you', text: text.slice(0, 4000), cli: 'agy' })
            } else if (o.type === 'PLANNER_RESPONSE' && o.content) {
              lines.push({ at, kind: 'text', text: o.content, cli: 'agy' })
              lastText = o.content
            }
          } catch {
            // ignore
          }
        }
        if (!lines.length) continue
        const id = insert(title, 'agy', 'agy_conversation', cid, first || nowLocal(), lastText)
        writeLog(id, [{ at: first || nowLocal(), kind: 'info', text: 'Imported from Antigravity — reply to resume this conversation', cli: 'agy' }, ...lines.slice(-400)])
        counts.agy++
      }
    }
    return counts
  }
}

// ───────────────────────────── GitHub pull requests (gh CLI) ─────────────────────────────

export const github = {
  /** Push the task branch and open a PR against the repository's default branch. */
  createPr: async (taskId: number, title?: string, body?: string): Promise<PrInfo> => {
    const t = task(taskId)
    const p = project(t.project_id)
    if (!t.branch || t.checkout_mode !== 'worktree') throw new Error('Pull requests are created from isolated worktree branches')
    const cwd = taskCwd(t)
    gitSync(cwd, ['add', '-A'])
    if (gitSync(cwd, ['status', '--porcelain']).trim()) gitSync(cwd, ['commit', '-m', t.title])
    if (!gitSync(p.folder, ['remote']).trim()) throw new Error('This repository has no remote yet — use Push in the project header first')
    await runAsync('git', ['-C', cwd, 'push', '-u', 'origin', `${t.branch}:${t.branch}`], cwd)
    const log = gitSync(cwd, ['log', '--format=- %s', `${t.base_commit ?? 'HEAD~1'}..HEAD`]).trim()
    const out = await runAsync(
      'gh',
      ['pr', 'create', '--head', t.branch, '--title', (title || t.title).slice(0, 200), '--body', body || `${t.notes || t.title}\n\n${log}\n\n_Created from AI Hub_`],
      p.folder
    )
    const url = out.trim().split('\n').find((l) => /^https?:\/\//.test(l)) ?? out.trim()
    run('UPDATE project_tasks SET pr_url = ? WHERE id = ?', url, taskId)
    return github.status(taskId)
  },

  status: async (taskId: number): Promise<PrInfo> => {
    const t = task(taskId)
    if (!t.pr_url) throw new Error('No pull request for this task yet')
    const p = project(t.project_id)
    const raw = await runAsync('gh', ['pr', 'view', t.pr_url, '--json', 'number,state,title,url,statusCheckRollup'], p.folder, undefined, 30_000)
    const j = JSON.parse(raw) as {
      number: number
      state: string
      title: string
      url: string
      statusCheckRollup?: { name?: string; context?: string; conclusion?: string; status?: string; state?: string }[]
    }
    return {
      url: j.url,
      number: j.number,
      state: j.state,
      title: j.title,
      checks: (j.statusCheckRollup ?? []).map((c) => ({ name: c.name ?? c.context ?? 'check', state: (c.conclusion || c.state || c.status || 'PENDING').toUpperCase() }))
    }
  }
}

// ───────────────────────────── Hunk-level review ─────────────────────────────

function parseDiff(diff: string): { header: string; hunks: DiffHunk[] } {
  const lines = diff.split('\n')
  const headerEnd = lines.findIndex((l) => l.startsWith('@@'))
  const header = headerEnd < 0 ? diff : lines.slice(0, headerEnd).join('\n')
  const hunks: DiffHunk[] = []
  let cur: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0
  for (const l of headerEnd < 0 ? [] : lines.slice(headerEnd)) {
    const h = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (h) {
      cur = { index: hunks.length, header: l, oldStart: Number(h[1]), newStart: Number(h[2]), lines: [] }
      hunks.push(cur)
      oldNo = Number(h[1])
      newNo = Number(h[2])
      continue
    }
    if (!cur || l.startsWith('\\')) continue
    const kind = (l[0] === '+' || l[0] === '-' ? l[0] : ' ') as ' ' | '+' | '-'
    cur.lines.push({ kind, text: l.slice(1), oldNo: kind === '+' ? null : oldNo, newNo: kind === '-' ? null : newNo })
    if (kind !== '+') oldNo++
    if (kind !== '-') newNo++
  }
  return { header, hunks }
}

const fileDiff = (t: ProjectTask, file: string): Promise<string> => {
  const cwd = taskCwd(t)
  return runAsync('git', ['-C', cwd, 'diff', t.base_commit || 'HEAD', '--', file], cwd, undefined, 60_000)
}

export const review = {
  hunks: async (taskId: number, file: string): Promise<DiffHunk[]> => {
    const t = task(taskId)
    try {
      return parseDiff(await fileDiff(t, file)).hunks
    } catch {
      return []
    }
  },

  /** Reject one hunk (undo just that change in the working tree); the rest of the file is kept. */
  revertHunk: async (taskId: number, file: string, index: number): Promise<DiffHunk[]> => {
    const t = task(taskId)
    const cwd = taskCwd(t)
    const diff = await fileDiff(t, file)
    const { header, hunks } = parseDiff(diff)
    const h = hunks[index]
    if (!h) throw new Error('That change no longer exists — refresh the diff')
    const body = h.lines.map((l) => `${l.kind}${l.text}`).join('\n')
    const patch = `${header}\n${h.header}\n${body}\n`
    const r = spawnSync('git', ['-C', cwd, 'apply', '-R', '--recount', '--whitespace=nowarn', '-'], { input: patch, encoding: 'utf8', windowsHide: true })
    if (r.status !== 0) throw new Error(`Could not undo that change: ${(r.stderr || '').trim().split('\n').slice(-2).join(' ')}`)
    return review.hunks(taskId, file)
  }
}

