import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { CheckoutMode, CliId, EffortLevel, LogLine, MentionItem, PermissionMode, Project, ProjectTask, ProjectTaskStatus, QueuedMessage, TaskChanges } from '@shared/types'
import {
  agyConversationTokens,
  agyDeniedActions,
  agyThinkingSteps,
  agyModelExhausted,
  agyModelFamily,
  pickAgyAlternative,
  refreshAgyQuota,
  findCliExecutable,
  isCliReady,
  modelsForCli,
  recordCliRateEvent,
  recordCliUsage,
  resolveCliModelWithEffort
} from './clis'
import { skills } from './skills'
import { approvalMcpConfig, cancelApprovals } from './approvals'
import { updateGraphNow } from './graphwatch'
import { phoneNotify } from './scheduler'
import { all, get, notifyChanged, nowLocal, run, transaction } from './db'
import { buildKnowledgePrompt, recordAiHandoff, syncKnowledgeToDir, withoutKbSync } from './knowledge'
import { getSettings } from './settings'
import { terminal } from './terminal'

type Notifier = {
  changed: () => void
  notify: (title: string, body: string, route: string) => void
}

let logDir = ''
let notifier: Notifier = { changed: () => notifyChanged(), notify: () => undefined }
const running = new Map<number, ChildProcess>()

export function initProjects(dataDir: string, n: Notifier): void {
  logDir = join(dataDir, 'project-logs')
  notifier = n
  run("UPDATE project_tasks SET run_state = 'failed', error = 'The app closed while this was running. Reply to continue it.' WHERE run_state = 'running'")
}

export const runningTasksCount = (): number => running.size

export function stopAllRuns(): void {
  for (const child of running.values()) killProcess(child)
}

function killProcess(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore
      }
    }
  }
}

export const getProject = (id: number): Project => {
  const p = get<Project>('SELECT * FROM projects WHERE id = ?', id)
  if (!p) throw new Error('That project no longer exists')
  return p
}

export const getTask = (id: number): ProjectTask => {
  const t = get<ProjectTask>('SELECT * FROM project_tasks WHERE id = ?', id)
  if (!t) throw new Error('That task or session no longer exists')
  return t
}

function checkFolder(folder: string): string {
  const f = folder.trim()
  if (f && !(existsSync(f) && statSync(f).isDirectory())) throw new Error(`Can't find the folder ${f}`)
  return f
}

function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 50 * 1024 * 1024
  })
  if (r.error) throw new Error((r.error as NodeJS.ErrnoException).code === 'ENOENT' ? 'Git is not installed or not on PATH' : r.error.message)
  if (r.status !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ') || `git ${args[0]} failed`)
  return r.stdout
}

/** Non-blocking git for read-only UI queries (polled on every DB change — spawnSync here froze the app). */
function gitAsync(cwd: string, args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code
          reject(new Error(code === 'ENOENT' ? 'Git is not installed or not on PATH' : (stderr || stdout || err.message).trim().split('\n').slice(-3).join(' ')))
        } else resolve(stdout)
      }
    )
  })
}

const logFile = (id: number): string => join(logDir, `task-${id}.log`)

export function appendLog(id: number, kind: LogLine['kind'], text: string, cli?: CliId, model?: string, meta?: string): void {
  if (!logDir || !text.trim()) return
  mkdirSync(logDir, { recursive: true })
  const entry: LogLine = { at: nowLocal(), kind, text, cli, model, meta }
  appendFileSync(logFile(id), JSON.stringify(entry) + '\n')
}

let pendingRefresh: ReturnType<typeof setTimeout> | null = null
function changedSoon(): void {
  if (pendingRefresh) return
  pendingRefresh = setTimeout(() => {
    pendingRefresh = null
    notifier.changed()
  }, 350)
}

/** Resolve working directory for a task/thread: either Local Checkout (`p.folder`) or an isolated Git Worktree. */
function resolveWorkingDir(t: ProjectTask, p: Project): string {
  checkFolder(p.folder)
  if (t.checkout_mode === 'local') {
    if (!t.base_commit) {
      try {
        const base = git(p.folder, ['rev-parse', 'HEAD']).trim()
        const branch = git(p.folder, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
        run('UPDATE project_tasks SET branch = ?, worktree = ?, base_commit = ? WHERE id = ?', branch, p.folder, base, t.id)
      } catch {
        run('UPDATE project_tasks SET worktree = ? WHERE id = ?', p.folder, t.id)
      }
    }
    syncKnowledgeToDir(p.id, p.folder)
    return p.folder
  }

  // Isolated Git Worktree mode
  if (t.worktree && existsSync(t.worktree)) {
    syncKnowledgeToDir(p.id, t.worktree)
    return t.worktree
  }
  try {
    git(p.folder, ['rev-parse', '--is-inside-work-tree'])
  } catch {
    // Fallback to local folder if project is not yet a git repo
    run('UPDATE project_tasks SET checkout_mode = \'local\', worktree = ? WHERE id = ?', p.folder, t.id)
    syncKnowledgeToDir(p.id, p.folder)
    return p.folder
  }

  const base = git(p.folder, ['rev-parse', 'HEAD']).trim()
  const slug =
    t.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'task'
  const branch = `aihub/task-${t.id}-${slug}`
  const root = `${p.folder.replace(/[\\/]+$/, '')}-worktrees`
  const wt = join(root, `task-${t.id}`)
  mkdirSync(root, { recursive: true })
  git(p.folder, ['worktree', 'add', '-B', branch, wt, base])

  const modules = join(p.folder, 'node_modules')
  if (existsSync(modules) && !existsSync(join(wt, 'node_modules'))) {
    try {
      symlinkSync(modules, join(wt, 'node_modules'), 'junction')
      const exclude = join(p.folder, git(p.folder, ['rev-parse', '--git-common-dir']).trim(), 'info', 'exclude')
      const lines = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
      if (!/^\/node_modules$/m.test(lines)) {
        mkdirSync(join(exclude, '..'), { recursive: true })
        appendFileSync(exclude, `${lines && !lines.endsWith('\n') ? '\n' : ''}/node_modules\n`)
      }
    } catch {
      // ignore junction error
    }
  }

  syncKnowledgeToDir(p.id, wt)
  run('UPDATE project_tasks SET branch = ?, worktree = ?, base_commit = ? WHERE id = ?', branch, wt, base, t.id)
  return wt
}

function removeWorktree(t: ProjectTask, p: Project): void {
  if (t.checkout_mode === 'local' || !t.worktree || t.worktree === p.folder) return
  const link = join(t.worktree, 'node_modules')
  try {
    if (existsSync(link)) {
      const st = lstatSync(link)
      if (st.isSymbolicLink()) unlinkSync(link)
      else rmdirSync(link)
    }
  } catch {
    // not a link or already gone
  }
  try {
    git(p.folder, ['worktree', 'remove', '--force', t.worktree])
  } catch {
    rmSync(t.worktree, { recursive: true, force: true })
    try {
      git(p.folder, ['worktree', 'prune'])
    } catch {
      // ignore
    }
  }
  if (t.branch && t.branch.startsWith('aihub/')) {
    try {
      git(p.folder, ['branch', '-D', t.branch])
    } catch {
      // already gone
    }
  }
}

const RUN_LIMIT_MS = 30 * 60_000
const CHECK_LIMIT_MS = 15 * 60_000

const cliDisplayName = (c: CliId): string =>
  c === 'agy' ? 'Antigravity' : c === 'claude' ? 'Claude Code' : c === 'codex' ? 'OpenAI Codex' : 'GitHub Copilot'

function resolveCliFor(t: ProjectTask, p: Project): CliId {
  const raw = (t.cli || p.default_cli || getSettings().defaultCli || 'claude') as string
  return (raw === 'gemini' ? 'claude' : raw) as CliId
}

const FALLBACK_MODEL: Record<CliId, string> = {
  claude: 'claude-opus-5-5',
  agy: 'gemini-4-argon',
  codex: 'gpt-5.2-codex',
  copilot: 'claude-sonnet-5-5'
}

/** The task's model only if it belongs to this CLI — after a handover the previous CLI's model id must not leak through. */
function resolveModelFor(cli: CliId, t: ProjectTask, p: Project): string {
  const known = modelsForCli(cli)
  const valid = (m: string): boolean => Boolean(m) && /^[\w.:[\]-]*$/.test(m) && (!known.length || known.some((k) => k.id === m))
  const s = getSettings()
  const candidates = [t.model, p.default_cli === cli ? p.default_model : '', s.defaultCli === cli ? s.defaultModel : '']
  for (const c of candidates) {
    const m = (c || '').trim()
    const clean = cli === 'agy' ? m.replace(/-(low|medium|high)$/i, '') : m
    if (valid(clean)) return clean
  }
  return known[0]?.id ?? FALLBACK_MODEL[cli]
}

function resolveEffortFor(t: ProjectTask, p: Project): EffortLevel {
  const e = (t.effort || p.default_effort || getSettings().defaultEffort || 'medium').trim().toLowerCase() as EffortLevel
  return ['low', 'medium', 'high', 'xhigh', 'max'].includes(e) ? e : 'medium'
}

function formatMentionsContext(mentionsRaw: string, projectFolder: string, cli: CliId = 'claude'): string {
  let items: MentionItem[] = []
  try {
    items = JSON.parse(mentionsRaw || '[]')
  } catch {
    return ''
  }
  if (!items.length) return ''
  const parts: string[] = []
  for (const m of items) {
    if (m.type === 'file') {
      const fullPath = existsSync(m.value) ? m.value : join(projectFolder, m.value)
      if (existsSync(fullPath) && statSync(fullPath).isFile()) {
        try {
          const content = readFileSync(fullPath, 'utf8').slice(0, 6000)
          parts.push(`Referenced File (@${m.label} — ${m.value}):\n\`\`\`\n${content}\n\`\`\``)
        } catch {
          parts.push(`Referenced File: ${m.value}`)
        }
      } else {
        parts.push(`Referenced Path: ${m.value}`)
      }
    } else if (m.type === 'project') {
      parts.push(`Referenced Project Context (@${m.label}): ${m.value}`)
    } else if (m.type === 'kb') {
      parts.push(`Referenced Knowledge Base Entry (@${m.label}):\n${m.value}`)
    } else if (m.type === 'image') {
      // Codex gets images via --image; Claude/Antigravity open the file with their read tool
      if (cli !== 'codex') parts.push(`Attached image (open and look at it before answering): ${m.value}`)
    } else if (m.type === 'element') {
      parts.push(`Selected element from the app preview (${m.label}):\n${m.value}`)
    }
  }
  return parts.join('\n\n')
}

/** Image paths attached to a task (for CLIs that take images as a flag). */
function imageMentions(mentionsRaw: string): string[] {
  try {
    return (JSON.parse(mentionsRaw || '[]') as MentionItem[]).filter((m) => m.type === 'image' && existsSync(m.value)).map((m) => m.value)
  } catch {
    return []
  }
}

/**
 * Skills: Claude Code and Antigravity load installed skills natively, so they get a `/skill` invocation (cheapest —
 * the CLI expands it itself). Every other CLI gets a one-line pointer to the SKILL.md file, never the whole text.
 */
function applySkills(cli: CliId, mentionsRaw: string, prompt: string): string {
  let items: MentionItem[] = []
  try {
    items = JSON.parse(mentionsRaw || '[]')
  } catch {
    return prompt
  }
  const picked = items.filter((m) => m.type === 'skill')
  if (!picked.length) return prompt
  const known = skills.listAll()
  const nativeCalls: string[] = []
  const pointers: string[] = []
  for (const m of picked) {
    const info = known.find((k) => k.path === m.value) ?? known.find((k) => k.name === m.label)
    if (info && info.native.includes(cli) && (cli === 'claude' || cli === 'agy')) nativeCalls.push(`/${info.name}`)
    else pointers.push(`- ${m.label}: read and follow ${info?.path ?? m.value}`)
  }
  const head = [
    nativeCalls.join(' '),
    pointers.length ? `Use these skills (open each SKILL.md and follow its instructions):\n${pointers.join('\n')}` : ''
  ].filter(Boolean)
  // A native /skill call must be the first thing in the prompt for the CLI to expand it
  return [...head, prompt].join(nativeCalls.length ? ' ' : '\n\n')
}

export function buildFullPrompt(cli: CliId, t: ProjectTask, p: Project, ask: string, cwd: string): string {
  return applySkills(cli, t.mentions, buildPromptBody(cli, t, p, ask, cwd))
}

function buildPromptBody(cli: CliId, t: ProjectTask, p: Project, ask: string, cwd: string): string {
  const kbBlock = buildKnowledgePrompt(p.id, cwd)
  const mentionsBlock = formatMentionsContext(t.mentions, p.folder, cli)
  const intentNote =
    'INTENT ROUTING (DECIDE TO BUILD VS. JUST ANSWER):\n' +
    '- If the user asks an informational, architectural, or conceptual question, asks for an explanation (e.g. "how does this work?", "would this app work on mac?", "what is X?"), or asks a simple question without explicitly requesting code changes: JUST ANSWER DIRECTLY AND CONCISELY. Do not touch or modify any files, do not create git branches/worktrees, and do not execute build/test commands.\n' +
    '- Only modify files, write code, or execute build/verification checks when the user is explicitly requesting code changes, implementation, bug fixes, refactoring, or file modifications.'

  const modeNote = [
    t.permission_mode === 'plan'
      ? 'PERMISSION MODE: Plan Only. Analyze, design, and explain your step-by-step plan without modifying files until approved.'
      : t.checkout_mode === 'worktree'
        ? `WORKING MODE: You are working in an isolated git worktree on branch ${t.branch || 'worktree'}. Make sensible choices, edit files as needed, and end with a concise summary.`
        : `WORKING MODE: You are working directly in the local checkout (${cwd}). Make clean, careful changes and end with a concise summary.`,
    intentNote
  ].join('\n\n')

  const lastRunner = t.runner
  // If continuing the exact same CLI conversation, keep the prompt concise
  if (
    lastRunner === cli &&
    ask &&
    ((cli === 'claude' && t.session_id) || (cli === 'agy' && t.agy_conversation) || (cli === 'codex' && t.codex_thread))
  ) {
    return [ask.trim(), mentionsBlock].filter(Boolean).join('\n\n')
  }

  // If handing over from another CLI, include handoff context
  if (lastRunner && lastRunner !== cli) {
    let diff = ''
    let status = ''
    try {
      diff = t.base_commit ? git(cwd, ['diff', t.base_commit]) : git(cwd, ['diff'])
      status = git(cwd, ['status', '--short'])
    } catch {
      // ignore git errors
    }
    // Token-lean handoff: skip thinking/info noise and trim each line
    const recentLogs = projects
      .log(t.id)
      .filter((l) => l.kind === 'you' || l.kind === 'text' || l.kind === 'tool' || l.kind === 'error')
      .slice(-20)
      .map((l) => `[${l.kind}] ${l.text.replace(/\s+/g, ' ').slice(0, 400)}`)
      .join('\n')
      .slice(-3000)

    return [
      `HANDOFF NOTICE: ${cliDisplayName(lastRunner)} worked on this before you. You are taking over seamlessly in ${cwd}.`,
      modeNote,
      kbBlock,
      `Original Task / Thread:\n${t.title}\n${t.notes}`.trim(),
      mentionsBlock,
      ask && `Latest User Instruction:\n${ask}`,
      recentLogs && `Recent Activity Log:\n${recentLogs}`,
      status.trim() && `Modified / Uncommitted Files:\n${status.slice(0, 1000)}`,
      diff.trim() && `Git Diff So Far:\n${diff.slice(0, 5000)}`
    ]
      .filter(Boolean)
      .join('\n\n')
  }

  // First run in this thread/task
  return [
    kbBlock,
    mentionsBlock,
    [t.title.trim(), t.notes.trim(), ask.trim() !== t.title.trim() ? ask.trim() : ''].filter(Boolean).join('\n\n'),
    modeNote
  ]
    .filter(Boolean)
    .join('\n\n')
}

function describeTool(name: string, input: Record<string, unknown>, cwd: string): string {
  const file = typeof input.file_path === 'string' ? relative(cwd, input.file_path) || input.file_path : ''
  if (name === 'Bash' || name === 'run_command') return `$ ${String(input.command ?? input.CommandLine ?? '')}`
  if (file) return `${name} ${file}`
  if (typeof input.pattern === 'string') return `${name} ${input.pattern}`
  return name
}

/** Only call this on error output — a normal answer that merely *discusses* rate limits must not trigger a handover. */
export function turnedDownByLimit(rejected: boolean, text: string): boolean {
  if (rejected) return true
  return /you['’]ve hit your|usage limit reached|rate limit exceeded|quota exceeded|resource[_ ]exhausted|exhausted your|out of .*(usage|quota|credits)|429 too many|try again in \d/i.test(
    text
  )
}

function collectChangedFilePaths(t: ProjectTask): string[] {
  try {
    const p = getProject(t.project_id)
    const cwd = t.worktree && existsSync(t.worktree) ? t.worktree : p.folder && existsSync(p.folder) ? p.folder : ''
    if (!cwd) return []
    const files = git(cwd, ['diff', '--name-only', t.base_commit || 'HEAD']).split('\n').map((l) => l.trim()).filter(Boolean)
    for (const l of git(cwd, ['status', '--porcelain']).split('\n')) {
      if (!l.startsWith('??')) continue
      const pth = l.slice(3).trim()
      if (pth && !files.includes(pth)) files.push(pth)
    }
    return files
  } catch {
    return []
  }
}

function finishRun(t: ProjectTask, p: Project, cli: CliId, model: string): void {
  run("UPDATE project_tasks SET run_state = 'waiting' WHERE id = ?", t.id)
  const changedFiles = collectChangedFilePaths(t)
  recordAiHandoff(p.id, cli, model, t.title, t.result || 'Completed run', changedFiles)
  const checked = t.check_state === 'passed' ? ' Checks passed.' : ''
  notifier.notify(
    `${p.name}: ${cliDisplayName(cli)} finished`,
    `${t.title}\n${checked}${(t.result || '').replace(/\s+/g, ' ').slice(0, 140)}`,
    `projects/${p.id}/${t.id}`
  )
  if (t.kind === 'task' || !p.auto_run) phoneNotify(`${p.name}: ${cliDisplayName(cli)} finished`, `${t.title}${checked}`)
  if (getSettings().useGraphify && getSettings().graphifyWatch && p.folder) updateGraphNow(p.folder)

  const nextMsg = get<QueuedMessage>('SELECT * FROM queued_messages WHERE task_id = ? ORDER BY id ASC LIMIT 1', t.id)
  if (nextMsg) {
    run('DELETE FROM queued_messages WHERE id = ?', nextMsg.id)
    notifier.changed()
    let mentions: MentionItem[] = []
    try {
      mentions = JSON.parse(nextMsg.mentions || '[]') as MentionItem[]
    } catch {
      // ignore
    }
    setTimeout(() => {
      try {
        projects.reply(t.id, nextMsg.prompt, {
          cli: (nextMsg.cli || t.cli || undefined) as CliId | undefined,
          model: nextMsg.model || t.model,
          effort: nextMsg.effort || t.effort,
          permissionMode: nextMsg.permission_mode || t.permission_mode,
          mentions
        })
      } catch (err) {
        console.error('Failed to dispatch queued message:', err)
      }
    }, 150)
    return
  }

  nextInQueue(p.id)
}

function failRun(t: ProjectTask, p: Project, why: string): void {
  run("UPDATE project_tasks SET run_state = 'failed', error = ? WHERE id = ?", why, t.id)
  appendLog(t.id, 'error', why, (t.runner || undefined) as CliId | undefined, t.model)
  notifier.notify(`${p.name}: stopped`, `${t.title}\n${why.slice(0, 140)}`, `projects/${p.id}/${t.id}`)
  phoneNotify(`${p.name}: stopped`, `${t.title}\n${why.slice(0, 300)}`)
  nextInQueue(p.id)
}

function runChecks(t: ProjectTask, p: Project, cli: CliId, model: string): void {
  const cmd = p.check_cmd.trim()
  const cwd = t.worktree || p.folder
  appendLog(t.id, 'info', `Running checks: ${cmd}`, cli, model)
  const child = spawn(cmd, { shell: true, cwd, windowsHide: true })
  running.set(t.id, child)
  let out = ''
  const keep = (d: Buffer): void => {
    out = (out + d.toString('utf8')).slice(-6000)
  }
  child.stdout?.on('data', keep)
  child.stderr?.on('data', keep)
  const limit = setTimeout(() => killProcess(child), CHECK_LIMIT_MS)
  child.on('error', (e) => (out += e.message))
  child.on('close', (code) => {
    clearTimeout(limit)
    if (running.get(t.id) !== child) return // superseded by Send now
    running.delete(t.id)
    if (getTask(t.id).run_state !== 'running') return
    const tail = out.replace(/\x1b\[[0-9;]*m/g, '').trim().slice(-3000) || `(no output; exit code ${code})`
    if (code === 0) {
      run("UPDATE project_tasks SET check_state = 'passed', check_output = ? WHERE id = ?", tail, t.id)
      appendLog(t.id, 'info', 'Checks passed ✓', cli, model)
      finishRun(getTask(t.id), p, cli, model)
    } else {
      run("UPDATE project_tasks SET check_state = 'failed', check_output = ?, status = 'queued' WHERE id = ?", tail, t.id)
      failRun(getTask(t.id), p, `Verification checks failed (${cmd}). Click Fix It or Reply so the AI fixes the errors.`)
    }
    notifier.changed()
  })
  notifier.changed()
}

function nextInQueue(projectId: number): void {
  const p = getProject(projectId)
  if (!p.auto_run || p.archived_at) return
  const busy = all<{ id: number }>('SELECT id FROM project_tasks WHERE project_id = ?', projectId).some((x) => running.has(x.id))
  if (busy) return
  const next = get<{ id: number }>(
    "SELECT id FROM project_tasks WHERE project_id = ? AND kind = 'task' AND status = 'queued' AND run_state = '' ORDER BY sort, id LIMIT 1",
    projectId
  )
  if (!next) {
    run('UPDATE projects SET auto_run = 0 WHERE id = ?', projectId)
    notifier.notify(`${p.name}: queue finished`, 'Every queued task has run. Review and merge your branches.', `projects/${projectId}`)
    phoneNotify(`${p.name}: queue finished`, 'Every queued task has run. Review and merge your branches.')
    return
  }
  try {
    projects.start(next.id)
  } catch (e) {
    run('UPDATE projects SET auto_run = 0 WHERE id = ?', projectId)
    notifier.notify(`${p.name}: queue paused`, (e as Error).message, `projects/${projectId}`)
  }
}

type Usage = { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number }
const sumTokens = (u: Usage): number => (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)

/** Launch Claude Code with real-time stream-json events, tool tracking, and live rate_limit_event capture. */
function launchClaude(startTask: ProjectTask, p: Project, ask: string, firstWhy: string): void {
  const cwd = resolveWorkingDir(startTask, p)
  const t = localizeAttachments(getTask(startTask.id), cwd)
  const exe = findCliExecutable('claude')
  if (!exe) throw new Error('Claude Code CLI is not installed or not found. Configure its path in Settings.')

  const baseModel = resolveModelFor('claude', t, p)
  const effort = resolveEffortFor(t, p)
  const { cliModelArg: model, effortArg } = resolveCliModelWithEffort('claude', baseModel, effort)
  const prompt = buildFullPrompt('claude', t, p, ask, cwd)
  // Default = ask in Omni CLI for every edit/command; Accept Edits = only commands and other risky tools ask
  const permMode =
    t.permission_mode === 'bypass'
      ? 'bypassPermissions'
      : t.permission_mode === 'plan'
        ? 'plan'
        : t.permission_mode === 'accept-edits'
          ? 'acceptEdits'
          : 'default'

  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', permMode]
  if (permMode === 'default' || permMode === 'acceptEdits') {
    const cfg = approvalMcpConfig(t.id)
    if (cfg) args.push('--mcp-config', cfg, '--permission-prompt-tool', 'mcp__aihub__approve')
    else if (permMode === 'default') args[args.indexOf('default')] = 'acceptEdits' // bridge unavailable: old behaviour
  }
  if (model) args.push('--model', model)
  if (effortArg) args.push('--effort', effortArg)
  if (t.session_id) args.push('--resume', t.session_id)

  const env = { ...process.env }
  delete env.CLAUDECODE

  const isCmd = /\.(cmd|bat)$/i.test(exe)
  const child = isCmd
    ? spawn(`"${exe}" ${args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(' ')}`, { shell: true, cwd, env, windowsHide: true })
    : spawn(exe, args, { cwd, env, windowsHide: true })

  running.set(t.id, child)
  run(
    "UPDATE project_tasks SET run_state = 'running', runner = 'claude', model = ?, effort = ?, error = '', check_state = '', check_output = '', runs = runs + 1 WHERE id = ?",
    baseModel,
    effortArg,
    t.id
  )
  appendLog(t.id, 'info', `Claude Code (${baseModel} · ${effortArg} effort) started in ${t.checkout_mode === 'worktree' ? t.branch : 'local checkout'}`, 'claude', `${baseModel} (${effortArg})`)

  const startedAt = Date.now()
  let buf = ''
  let err = ''
  let resultObj: { text: string; isError: boolean } | null = null
  let timedOut = false
  let rateRejected = false
  const seenMsgTokens = new Map<string, number>()
  let runTokens = 0
  let runCostUsd = 0
  let lastTick = startedAt

  const tickTime = (): void => {
    const now = Date.now()
    run('UPDATE project_tasks SET run_ms = run_ms + ? WHERE id = ?', now - lastTick, t.id)
    lastTick = now
  }

  const limitTimer = setTimeout(() => {
    timedOut = true
    killProcess(child)
  }, RUN_LIMIT_MS)

  const handleJsonLine = (raw: string): void => {
    if (!raw.trim()) return
    let ev: {
      type?: string
      session_id?: string
      is_error?: boolean
      result?: string
      total_cost_usd?: number
      usage?: Usage
      message?: {
        id?: string
        usage?: Usage
        content?: { type: string; text?: string; thinking?: string; name?: string; input?: Record<string, unknown> }[]
      }
      rate_limit_info?: {
        status?: string
        resetsAt?: number | string
        utilization?: number
        rateLimitType?: string
      }
    }
    try {
      ev = JSON.parse(raw)
    } catch {
      return
    }

    if (ev.type === 'rate_limit_event' && ev.rate_limit_info) {
      const rli = ev.rate_limit_info
      if (rli.status === 'rejected') rateRejected = true
      const statusMap = rli.status === 'rejected' ? 'rejected' : rli.status === 'allowed_warning' ? 'warning' : 'ok'
      // utilization arrives as a 0–1 fraction (older builds) or a 0–100 percentage
      const utilPct = typeof rli.utilization === 'number' ? Math.round(rli.utilization <= 1 ? rli.utilization * 100 : rli.utilization) : null
      const resetsIso =
        typeof rli.resetsAt === 'number'
          ? new Date(rli.resetsAt * (rli.resetsAt < 1e12 ? 1000 : 1)).toISOString()
          : typeof rli.resetsAt === 'string'
            ? rli.resetsAt
            : null
      // Weekly / per-model windows are shown from the live usage API; only the 5h window drives the main lock
      const key = !rli.rateLimitType || rli.rateLimitType === 'five_hour' ? 'claude' : `claude:${rli.rateLimitType}`
      recordCliRateEvent(key as CliId, statusMap, utilPct, resetsIso, rli.rateLimitType || rli.status || '')
    }

    if (ev.session_id && ev.type === 'system') {
      run('UPDATE project_tasks SET session_id = ? WHERE id = ?', ev.session_id, t.id)
    }

    if (ev.type === 'assistant') {
      for (const c of ev.message?.content ?? []) {
        if (c.type === 'thinking' && c.thinking) {
          appendLog(t.id, 'thinking', c.thinking, 'claude', model)
        } else if (c.type === 'text' && c.text) {
          appendLog(t.id, 'text', c.text, 'claude', model)
          run('UPDATE project_tasks SET result = ? WHERE id = ?', c.text, t.id)
        } else if (c.type === 'tool_use' && c.name) {
          appendLog(t.id, 'tool', describeTool(c.name, c.input ?? {}, cwd), 'claude', model)
        }
      }
      const u = ev.message?.usage
      if (u && ev.message?.id) {
        const n = sumTokens(u)
        const delta = n - (seenMsgTokens.get(ev.message.id) ?? 0)
        if (delta > 0) {
          seenMsgTokens.set(ev.message.id, n)
          runTokens += delta
          run('UPDATE project_tasks SET tokens = tokens + ? WHERE id = ?', delta, t.id)
        }
      }
    }

    if (ev.type === 'result') {
      resultObj = { text: ev.result ?? '', isError: Boolean(ev.is_error) }
      const extraTokens = Math.max(0, sumTokens(ev.usage ?? {}) - runTokens)
      runTokens += extraTokens
      runCostUsd = ev.total_cost_usd ?? 0
      run('UPDATE project_tasks SET tokens = tokens + ?, cost_usd = cost_usd + ? WHERE id = ?', extraTokens, runCostUsd, t.id)
      if (ev.session_id) run('UPDATE project_tasks SET session_id = ? WHERE id = ?', ev.session_id, t.id)
    }

    tickTime()
    changedSoon()
  }

  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (d: string) => {
    buf += d
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      handleJsonLine(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
    }
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (d: string) => (err = (err + d).slice(-4000)))
  child.on('error', (e) => (err += e.message))
  child.on('close', (code) => {
    clearTimeout(limitTimer)
    handleJsonLine(buf)
    const superseded = running.get(t.id) !== child
    if (!superseded) running.delete(t.id)
    tickTime()

    const durationMs = Date.now() - startedAt
    recordCliUsage({
      cli: 'claude',
      model,
      projectId: p.id,
      taskId: t.id,
      tokens: runTokens || 1200,
      costUsd: runCostUsd,
      durationMs
    })

    const cur = getTask(t.id)
    const r = resultObj as { text: string; isError: boolean } | null
    if (superseded || cur.run_state !== 'running') {
      // manually stopped or interrupted by Send now
    } else if (r && !r.isError && !timedOut && !rateRejected) {
      if (r.text) run('UPDATE project_tasks SET result = ? WHERE id = ?', r.text, t.id)
      const freshProj = getProject(p.id)
      if (freshProj.check_cmd.trim() && cur.kind === 'task') runChecks(getTask(t.id), freshProj, 'claude', model)
      else finishRun(getTask(t.id), freshProj, 'claude', model)
    } else {
      if (turnedDownByLimit(rateRejected, `${r?.isError ? r.text : ''}\n${err}`)) {
        recordCliRateEvent('claude', 'rejected', 100, null, '5-hour subscription limit reached')
      }
      const why = timedOut
        ? `Stopped after ${RUN_LIMIT_MS / 60_000} minutes.`
        : (r?.text || err.trim().split('\n').slice(-3).join(' ') || `Stopped (exit ${code})`).slice(0, 1000)
      handleStoppedRun('claude', getTask(t.id), getProject(p.id), ask, why, firstWhy)
    }
    notifier.changed()
  })

  child.stdin?.on('error', () => undefined)
  child.stdin?.end(prompt)
  notifier.changed()
}

/** Commit edits made by Antigravity when working in an isolated worktree. */
function commitWorktreeEditsIfNeeded(t: ProjectTask, label: string): boolean {
  if (t.checkout_mode !== 'worktree' || !t.worktree) return false
  try {
    git(t.worktree, ['add', '-A'])
    if (!git(t.worktree, ['status', '--porcelain']).trim()) return false
    git(t.worktree, ['commit', '-m', `${t.title} (${label})`])
    return true
  } catch {
    return false
  }
}

export const PERMISSION_BLOCKED = 'Stopped: permission needed.'

/**
 * Pasted images live in Omni CLI's data folder, which sandboxed CLIs (Antigravity, Gemini) refuse to read.
 * Copy them into the workspace's git-excluded .ai-kb/attachments folder and point the task at those copies.
 */
function localizeAttachments(t: ProjectTask, cwd: string): ProjectTask {
  let items: MentionItem[] = []
  try {
    items = JSON.parse(t.mentions || '[]')
  } catch {
    return t
  }
  let changed = false
  const dir = join(cwd, '.ai-kb', 'attachments')
  const next = items.map((m) => {
    if (m.type !== 'image' || !existsSync(m.value)) return m
    const rel = relative(cwd, m.value)
    if (!rel.startsWith('..') && !/^[a-z]:/i.test(rel)) return m // already inside the workspace
    try {
      mkdirSync(dir, { recursive: true })
      const dest = join(dir, m.value.split(/[\\/]/).pop() || `image-${Date.now()}.png`)
      if (!existsSync(dest)) copyFileSync(m.value, dest)
      changed = true
      return { ...m, value: dest }
    } catch {
      return m
    }
  })
  if (!changed) return t
  run('UPDATE project_tasks SET mentions = ? WHERE id = ?', JSON.stringify(next), t.id)
  return getTask(t.id)
}

/** Launch Antigravity CLI (`agy`) or the other supported CLIs (`codex`, `copilot`). */
function launchCliProcess(cli: CliId, startTask: ProjectTask, p: Project, ask: string, firstWhy: string): void {
  const cwd = resolveWorkingDir(startTask, p)
  const t = localizeAttachments(getTask(startTask.id), cwd)
  const exe = findCliExecutable(cli)
  if (!exe) {
    throw new Error(`${cliDisplayName(cli)} CLI isn't installed. Install it or set its path in Settings.`)
  }

  let baseModel = resolveModelFor(cli, t, p)
  if (cli === 'agy' && getSettings().agyFamilyFallback && agyModelExhausted(baseModel)) {
    const alt = pickAgyAlternative(baseModel, new Set([baseModel]))
    if (alt) {
      appendLog(t.id, 'handoff', `${baseModel} has no quota left right now — using ${alt} from another Antigravity quota group.`, 'agy', alt)
      baseModel = alt
    }
  }
  const effort = resolveEffortFor(t, p)
  const { cliModelArg: model, effortArg } = resolveCliModelWithEffort(cli, baseModel, effort)
  const prompt = buildFullPrompt(cli, t, p, ask, cwd)

  // Prompts go through stdin wherever the CLI supports it: no 32k command-line limit and no shell-quoting bugs.
  let args: string[] = []
  let stdinPrompt: string | null = null
  const isAgy = cli === 'agy'
  if (isAgy) {
    const agyMode = t.permission_mode === 'plan' ? 'plan' : 'auto'
    args = ['-p', prompt.slice(0, 24_000), '--output-format', 'stream-json', '--mode', agyMode, '--print-timeout', `${RUN_LIMIT_MS / 60_000}m`]
    if (t.permission_mode !== 'plan') args.push('--dangerously-skip-permissions')
    if (t.agy_conversation && t.runner === 'agy') args.push('--conversation', t.agy_conversation)
    if (model) args.push('--model', model)
  } else if (cli === 'codex') {
    const sandbox =
      t.permission_mode === 'plan'
        ? ['--sandbox', 'read-only']
        : t.permission_mode === 'bypass'
          ? ['--dangerously-bypass-approvals-and-sandbox']
          : ['--full-auto']
    const common = ['--json', '--skip-git-repo-check', '--model', model, '-c', `model_reasoning_effort="${effortArg}"`, ...sandbox]
    const images = imageMentions(t.mentions).flatMap((f) => ['--image', f])
    args = t.codex_thread && t.runner === 'codex' ? ['exec', 'resume', ...common, ...images, t.codex_thread, '-'] : ['exec', ...common, ...images, '-']
    stdinPrompt = prompt
  } else {
    args = ['-p', prompt.slice(0, 24_000), '--model', model]
    if (t.permission_mode !== 'plan') args.push('--allow-all-tools')
  }

  const isCmd = /\.(cmd|bat)$/i.test(exe)
  const stdio: ['pipe' | 'ignore', 'pipe', 'pipe'] = [stdinPrompt !== null ? 'pipe' : 'ignore', 'pipe', 'pipe']
  const child = isCmd
    ? spawn(`"${exe}" ${args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(' ')}`, { shell: true, cwd, windowsHide: true, stdio })
    : spawn(exe, args, { cwd, windowsHide: true, stdio })
  if (stdinPrompt !== null) {
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(stdinPrompt)
  }

  running.set(t.id, child)
  run(
    "UPDATE project_tasks SET run_state = 'running', runner = ?, model = ?, effort = ?, error = '', check_state = '', check_output = '', runs = runs + 1 WHERE id = ?",
    cli,
    baseModel,
    effortArg,
    t.id
  )
  appendLog(
    t.id,
    'info',
    `${cliDisplayName(cli)} (${baseModel} · ${effortArg} effort) is working in ${t.checkout_mode === 'worktree' ? t.branch : 'local checkout'}`,
    cli,
    `${baseModel} (${effortArg})`
  )

  const startedAt = Date.now()
  let buf = ''
  let outText = ''
  let err = ''
  let timedOut = false
  let streamTokens = 0
  let streamOk = true
  let errorText = ''

  const limitTimer = setTimeout(() => {
    timedOut = true
    killProcess(child)
  }, RUN_LIMIT_MS + 60_000)

  let agyCid = t.agy_conversation || ''
  const seenThinkingSteps = new Set<number>()
  const syncAgyThinking = (): void => {
    if (!agyCid) return
    const steps = agyThinkingSteps(agyCid, startedAt)
    for (const step of steps) {
      if (!seenThinkingSteps.has(step.stepIndex)) {
        seenThinkingSteps.add(step.stepIndex)
        appendLog(t.id, 'thinking', step.thinking, cli, model)
      }
    }
  }
  const agyThinkingTimer = isAgy ? setInterval(syncAgyThinking, 1000) : null

  const handleAgyLine = (raw: string): void => {
    if (!raw.trim()) return
    try {
      const ev = JSON.parse(raw) as {
        event?: string
        conversation_id?: string
        error?: { message?: string } | string
        step_update?: {
          conversation_id?: string
          state?: string
          step_type?: string
          text_delta?: string
          tool_name?: string
          usage?: { total_tokens?: number }
        }
        result?: { conversation_id?: string; status?: string; response?: string; error?: string; usage?: { total_tokens?: number } }
      }
      const cid = ev.conversation_id || ev.step_update?.conversation_id || ev.result?.conversation_id
      if (cid) {
        agyCid = cid
        run('UPDATE project_tasks SET agy_conversation = ? WHERE id = ?', cid, t.id)
        syncAgyThinking()
      }
      if (ev.error) errorText += typeof ev.error === 'string' ? ev.error : (ev.error.message ?? '')

      if (ev.event === 'step_update' && ev.step_update) {
        const su = ev.step_update
        if (su.text_delta) {
          outText += su.text_delta
          run('UPDATE project_tasks SET result = ? WHERE id = ?', outText, t.id)
        }
        if (su.tool_name && su.state === 'ACTIVE') appendLog(t.id, 'tool', su.tool_name, cli, model)
        if (su.usage?.total_tokens) streamTokens = Math.max(streamTokens, su.usage.total_tokens)
      }
      if (ev.event === 'result' && ev.result) {
        if (ev.result.response) outText = ev.result.response
        streamOk = !ev.result.status || ev.result.status === 'SUCCESS'
        if (!streamOk) errorText += ev.result.error ?? ev.result.response ?? ev.result.status ?? ''
        if (ev.result.usage?.total_tokens) streamTokens = Math.max(streamTokens, ev.result.usage.total_tokens)
      }
      changedSoon()
    } catch {
      outText += raw + '\n'
    }
  }

  /** `codex exec --json` emits one JSON event per line (thread.started, item.completed, turn.completed with usage). */
  const handleCodexLine = (raw: string): void => {
    if (!raw.trim()) return
    try {
      const ev = JSON.parse(raw) as {
        type?: string
        thread_id?: string
        message?: string
        item?: { type?: string; text?: string; command?: string; path?: string; changes?: { path?: string; kind?: string }[] }
        usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number }
        error?: { message?: string }
      }
      if (ev.type === 'thread.started' && ev.thread_id) run('UPDATE project_tasks SET codex_thread = ? WHERE id = ?', ev.thread_id, t.id)
      if (ev.type === 'item.completed' && ev.item) {
        const it = ev.item
        if (it.type === 'agent_message' && it.text) {
          outText = it.text
          appendLog(t.id, 'text', it.text, cli, model)
          run('UPDATE project_tasks SET result = ? WHERE id = ?', it.text, t.id)
        } else if (it.type === 'reasoning' && it.text) appendLog(t.id, 'thinking', it.text, cli, model)
        else if (it.type === 'command_execution' && it.command) appendLog(t.id, 'tool', `$ ${it.command}`, cli, model)
        else if (it.type === 'file_change' && it.changes?.length)
          for (const c of it.changes) appendLog(t.id, 'tool', `${c.kind === 'add' ? 'Create' : c.kind === 'delete' ? 'Delete' : 'Edit'} ${c.path ?? ''}`, cli, model)
      }
      if (ev.type === 'turn.completed' && ev.usage) {
        // cached input is billed far cheaper against limits — count only the uncached part
        streamTokens += Math.max(0, (ev.usage.input_tokens ?? 0) - (ev.usage.cached_input_tokens ?? 0)) + (ev.usage.output_tokens ?? 0)
      }
      if (ev.type === 'turn.failed' || ev.type === 'error') {
        streamOk = false
        errorText += ev.error?.message ?? ev.message ?? 'Codex turn failed'
      }
      changedSoon()
    } catch {
      // non-JSON progress line
    }
  }

  const lineHandler = isAgy ? handleAgyLine : cli === 'codex' ? handleCodexLine : null
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (d: string) => {
    if (!lineHandler) {
      outText += d
      changedSoon()
      return
    }
    buf += d
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      lineHandler(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
    }
  })

  // CLIs without structured tool events: watch modified files so the stream shows live edits
  const seenFiles = new Map<string, string>()
  const fileWatcher =
    cli === 'codex'
      ? null
      : setInterval(() => {
          try {
            for (const l of git(cwd, ['status', '--porcelain']).split('\n').filter(Boolean)) {
              const file = l.slice(3).trim()
              if (!file || file.startsWith('.ai-kb') || seenFiles.get(file) === l) continue
              seenFiles.set(file, l)
              const action = l.startsWith('??') || l[1] === 'A' ? 'Create' : l[1] === 'D' ? 'Delete' : 'Edit'
              appendLog(t.id, 'tool', `${action} ${file}`, cli, model)
              changedSoon()
            }
          } catch {
            // ignore if git busy / not a repo
          }
        }, 2500)

  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (d: string) => (err = (err + d).slice(-4000)))
  child.on('error', (e) => (err += e.message))
  child.on('close', (code) => {
    clearTimeout(limitTimer)
    if (fileWatcher) clearInterval(fileWatcher)
    if (agyThinkingTimer) clearInterval(agyThinkingTimer)
    if (isAgy) syncAgyThinking()
    if (lineHandler && buf.trim()) lineHandler(buf)
    const superseded = running.get(t.id) !== child
    if (!superseded) running.delete(t.id)
    const durationMs = Date.now() - startedAt

    const tid = getTask(t.id)
    const realAgyTokens = isAgy && tid.agy_conversation ? agyConversationTokens(tid.agy_conversation, startedAt) : 0
    const finalTokens = realAgyTokens || streamTokens || Math.max(800, Math.round((prompt.length + outText.length) / 3.5))
    run('UPDATE project_tasks SET run_ms = run_ms + ?, tokens = tokens + ? WHERE id = ?', durationMs, finalTokens, t.id)
    recordCliUsage({ cli, model: baseModel, projectId: p.id, taskId: t.id, tokens: finalTokens, durationMs })

    const freshProj = getProject(p.id)
    const finalAnswer = outText.trim()
    const failureText = `${errorText}\n${err}`
    const failed = timedOut || code !== 0 || !streamOk

    if (superseded || getTask(t.id).run_state !== 'running') {
      // stopped by user or interrupted by Send now
    } else if (isAgy && !failed && tid.agy_conversation && tid.permission_mode !== 'bypass' && agyDeniedActions(tid.agy_conversation, startedAt).length) {
      // Antigravity's print mode can't show a permission prompt — it silently denies and ends the turn. Say so.
      const denied = agyDeniedActions(tid.agy_conversation, startedAt)
      if (finalAnswer) {
        appendLog(t.id, 'text', finalAnswer, cli, model)
        run('UPDATE project_tasks SET result = ? WHERE id = ?', finalAnswer, t.id)
      }
      failRun(
        getTask(t.id),
        freshProj,
        `${PERMISSION_BLOCKED} Antigravity wanted to:\n${denied
          .slice(0, 6)
          .map((d) => `• ${d}`)
          .join('\n')}\nIt can't ask for approval when run from Omni CLI, so these were blocked. Continue with Full Auto to allow them.`
      )
    } else if (failed || turnedDownByLimit(false, errorText)) {
      if (turnedDownByLimit(false, failureText)) {
        if (isAgy) {
          // Antigravity quotas are per model family — lock only that family
          const fam = agyModelFamily(baseModel)
          recordCliRateEvent(`agy:${fam.key}` as CliId, 'rejected', 100, null, `${fam.label} quota reached`)
        } else {
          recordCliRateEvent(cli, 'rejected', 100, null, 'Subscription quota limit reached')
        }
      }
      const why = timedOut
        ? `Stopped after ${RUN_LIMIT_MS / 60_000} minutes.`
        : (errorText.trim() || err.trim().split('\n').slice(-3).join(' ') || finalAnswer || `Stopped (exit ${code})`).slice(0, 1000)
      handleStoppedRun(cli, getTask(t.id), freshProj, ask, why, firstWhy)
    } else {
      if (finalAnswer && cli !== 'codex') {
        appendLog(t.id, 'text', finalAnswer, cli, model)
        run('UPDATE project_tasks SET result = ? WHERE id = ?', finalAnswer, t.id)
      }
      commitWorktreeEditsIfNeeded(getTask(t.id), cliDisplayName(cli))
      if (freshProj.check_cmd.trim() && getTask(t.id).kind === 'task') runChecks(getTask(t.id), freshProj, cli, model)
      else finishRun(getTask(t.id), freshProj, cli, model)
    }
    notifier.changed()
  })
  notifier.changed()
}


export function parseCliOutput(out: string): { ok: boolean; text: string; conversation: string } {
  const raw = out.trim()
  try {
    const r = JSON.parse(raw) as { status?: string; response?: string; conversation_id?: string; result?: string }
    const text = r.response ?? r.result ?? ''
    return {
      ok: !r.status || r.status === 'SUCCESS' || r.status === 'ok',
      text: text || raw,
      conversation: r.conversation_id ?? ''
    }
  } catch {
    return { ok: Boolean(raw), text: raw, conversation: '' }
  }
}

function executeWithCli(cli: CliId, t: ProjectTask, p: Project, ask: string, firstWhy = ''): void {
  try {
    if (cli === 'claude') launchClaude(t, p, ask, firstWhy)
    else launchCliProcess(cli, t, p, ask, firstWhy)
  } catch (e) {
    handleStoppedRun(cli, getTask(t.id), p, ask, (e as Error).message, firstWhy)
  }
}

/** Automatic Subscription Handover: when one CLI stops or hits its rate limit, hand over to the other authenticated CLI on the same branch/folder! */
const agyTried = new Map<number, Set<string>>()

function handleStoppedRun(from: CliId, t: ProjectTask, p: Project, ask: string, why: string, firstWhy: string): void {
  // Antigravity meters model groups separately — a different group may still have quota, so try that first
  if (from === 'agy' && getSettings().agyFamilyFallback && turnedDownByLimit(false, why)) {
    const tried = agyTried.get(t.id) ?? new Set<string>()
    tried.add(t.model)
    agyTried.set(t.id, tried)
    void refreshAgyQuota().then(() => {
      const alt = pickAgyAlternative(t.model, tried)
      if (!alt) {
        agyTried.delete(t.id)
        return handOverToOtherCli(from, getTask(t.id), getProject(p.id), ask, why, firstWhy)
      }
      tried.add(alt)
      run('UPDATE project_tasks SET model = ?, cli = ? WHERE id = ?', alt, 'agy', t.id)
      appendLog(t.id, 'handoff', `${t.model} is out of quota. Switching to ${alt} (a different Antigravity quota group) and continuing…`, 'agy', alt)
      executeWithCli('agy', getTask(t.id), getProject(p.id), ask, firstWhy)
    })
    return
  }
  agyTried.delete(t.id)
  handOverToOtherCli(from, t, p, ask, why, firstWhy)
}

function handOverToOtherCli(from: CliId, t: ProjectTask, p: Project, ask: string, why: string, firstWhy: string): void {
  // Only hand over to subscriptions that are installed AND signed in; Claude first, then the rest
  const fallbackOrder: CliId[] = ['claude', 'agy', 'codex', 'copilot']
  const to = fallbackOrder.find((c) => c !== from && isCliReady(c))

  if (firstWhy || !to || !getSettings().cliHandover) {
    if (firstWhy) run('UPDATE projects SET auto_run = 0 WHERE id = ?', p.id)
    const msg = firstWhy
      ? `Both subscriptions stopped. First: ${firstWhy} | Next (${cliDisplayName(from)}): ${why}`
      : `${why} — Reply to continue or switch subscription model.`
    return failRun(t, p, msg)
  }

  appendLog(
    t.id,
    'handoff',
    `${cliDisplayName(from)} stopped (${why.slice(0, 140)}). Automatically handing over to ${cliDisplayName(to)} with shared Project Knowledge Base & git state…`,
    to
  )
  notifier.notify(
    `${p.name}: Handed over to ${cliDisplayName(to)}`,
    `${t.title}\n${cliDisplayName(from)} stopped, so ${cliDisplayName(to)} is continuing.`,
    `projects/${p.id}/${t.id}`
  )
  executeWithCli(to, t, p, ask, why)
}

export interface CreateRunOpts {
  projectId: number
  prompt: string
  notes?: string
  kind?: 'thread' | 'task'
  cli: CliId
  model: string
  effort?: EffortLevel
  permissionMode: PermissionMode
  checkoutMode: CheckoutMode
  mentions?: MentionItem[]
  startImmediately?: boolean
}

export const projects = {
  list: (): Project[] =>
    all<Project>(
      `SELECT p.*,
         (SELECT COUNT(*) FROM project_tasks t WHERE t.project_id = p.id AND t.kind = 'task' AND t.status = 'queued') AS queued,
         (SELECT COUNT(*) FROM project_tasks t WHERE t.project_id = p.id AND t.run_state = 'running') AS doing,
         (SELECT COUNT(*) FROM knowledge_entries k WHERE k.project_id = p.id) AS kb_count,
         (SELECT COUNT(*) FROM project_tasks t WHERE t.project_id = p.id AND t.kind = 'thread') AS thread_count
       FROM projects p
       ORDER BY p.archived_at IS NOT NULL, p.sort, p.id`
    ),

  save: (p: Partial<Project> & { name: string }): Project => {
    if (!p.name.trim()) throw new Error('Give the project a name')
    const folder = checkFolder(p.folder ?? '')
    return transaction(() => {
      const id = p.id
        ? (run(
            `UPDATE projects
             SET name = ?, folder = ?, notes = ?, check_cmd = ?, default_cli = ?, default_model = ?, default_effort = ?, default_mode = ?, default_checkout = ?
             WHERE id = ?`,
            p.name.trim(),
            folder,
            p.notes ?? '',
            (p.check_cmd ?? '').trim(),
            p.default_cli ?? getSettings().defaultCli,
            p.default_model ?? getSettings().defaultModel,
            p.default_effort ?? getSettings().defaultEffort,
            p.default_mode ?? 'default',
            p.default_checkout ?? 'local',
            p.id
          ),
          p.id)
        : run(
            `INSERT INTO projects (name, folder, notes, check_cmd, default_cli, default_model, default_effort, default_mode, default_checkout, sort, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM projects), ?)`,
            p.name.trim(),
            folder,
            p.notes ?? '',
            (p.check_cmd ?? '').trim(),
            p.default_cli || getSettings().defaultCli,
            p.default_model || getSettings().defaultModel,
            p.default_effort ?? getSettings().defaultEffort,
            p.default_mode ?? 'default',
            p.default_checkout ?? 'local',
            nowLocal()
          )
      if (folder) syncKnowledgeToDir(id, folder)
      return getProject(id)
    })
  },

  taskInfo: (taskId: number): { projectId: number; projectName: string; title: string } | null => {
    const r = get<{ project_id: number; name: string; title: string }>(
      'SELECT t.project_id, p.name, t.title FROM project_tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?',
      taskId
    )
    return r ? { projectId: r.project_id, projectName: r.name, title: r.title } : null
  },

  /** Remember the composer's last AI choice for this project (so model + effort stick between sessions). */
  setDefaults: (id: number, d: { cli?: CliId; model?: string; effort?: EffortLevel }): Project => {
    const cur = getProject(id)
    run(
      'UPDATE projects SET default_cli = ?, default_model = ?, default_effort = ? WHERE id = ?',
      d.cli ?? cur.default_cli,
      d.model ?? cur.default_model,
      d.effort ?? cur.default_effort ?? 'medium',
      id
    )
    return getProject(id)
  },

  archive: (id: number, archived = true): Project => {
    run('UPDATE projects SET archived_at = ? WHERE id = ?', archived ? nowLocal() : null, id)
    return getProject(id)
  },

  delete: (id: number): true => {
    run('DELETE FROM projects WHERE id = ?', id)
    return true
  },

  /** List files in the project folder for the `+` / `@` composer mention picker. */
  files: (projectId: number): string[] => {
    const p = getProject(projectId)
    if (!p.folder || !existsSync(p.folder)) return []
    const results: string[] = []
    const walk = (dir: string, depth: number): void => {
      if (depth > 3 || results.length >= 120) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (results.length >= 120) break
        if (e.name.startsWith('.') || ['node_modules', 'out', 'release', 'dist', 'build', 'data'].includes(e.name)) continue
        const full = join(dir, e.name)
        const rel = relative(p.folder, full).replace(/\\/g, '/')
        if (e.isDirectory()) {
          walk(full, depth + 1)
        } else {
          results.push(rel)
        }
      }
    }
    walk(p.folder, 0)
    return results
  },

  /** List all tasks & interactive threads for a project. */
  tasks: (projectId: number): ProjectTask[] =>
    all<ProjectTask>(
      `SELECT * FROM project_tasks WHERE project_id = ?
       ORDER BY CASE status WHEN 'doing' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
         CASE WHEN status = 'done' THEN done_at END DESC, sort, id DESC`,
      projectId
    ),

  /** Create and immediately start an interactive session or queued task from the screenshot composer bar! */
  /**
   * Estimate the tokens a message will send (KB context + mentions + your text) before you press Send.
   * Mirrors buildFullPrompt exactly, including the short form used when continuing the same CLI session.
   */
  estimate: (opts: { projectId: number; taskId?: number | null; cli: CliId; prompt: string; mentions?: MentionItem[] }): {
    tokens: number
    contextTokens: number
    continuing: boolean
  } => {
    const p = getProject(opts.projectId)
    const mentions = JSON.stringify(opts.mentions ?? [])
    const base: ProjectTask = opts.taskId
      ? { ...getTask(opts.taskId), mentions }
      : ({
          id: 0,
          project_id: p.id,
          kind: 'thread',
          title: opts.prompt.split('\n')[0].slice(0, 110),
          notes: opts.prompt.includes('\n') ? opts.prompt : '',
          mentions,
          permission_mode: 'default',
          checkout_mode: 'local',
          runner: '',
          session_id: null,
          agy_conversation: null,
          codex_thread: null,
          base_commit: null,
          branch: null
        } as unknown as ProjectTask)
    const text = withoutKbSync(() => buildFullPrompt(opts.cli, base, p, opts.prompt, p.folder))
    const kb = withoutKbSync(() => buildKnowledgePrompt(p.id))
    const continuing = Boolean(opts.taskId) && !text.includes(kb.slice(0, 40) || '\u0000')
    // ~3.7 chars/token for English + code is a good cross-model average
    const toTokens = (s: string): number => Math.ceil(s.length / 3.7)
    return { tokens: toTokens(text), contextTokens: continuing ? 0 : toTokens(kb), continuing }
  },

  /** Send the same task to two AIs at once, each on its own worktree branch, to compare results side by side. */
  createCompare: (
    opts: CreateRunOpts,
    second: { cli: CliId; model: string; effort?: EffortLevel }
  ): ProjectTask[] => {
    const p = getProject(opts.projectId)
    try {
      git(p.folder, ['rev-parse', '--verify', 'HEAD'])
    } catch {
      throw new Error('Compare runs need a git repository with at least one commit (each AI gets its own branch). Use "Init Git repo" first.')
    }
    const group = `cmp-${Date.now().toString(36)}`
    const created: ProjectTask[] = []
    for (const side of [{ cli: opts.cli, model: opts.model, effort: opts.effort }, second]) {
      const t = projects.createAndRun({ ...opts, ...side, kind: 'thread', checkoutMode: 'worktree', startImmediately: false })
      run("UPDATE project_tasks SET compare_group = ?, status = 'doing' WHERE id = ?", group, t.id)
      created.push(t)
    }
    for (const t of created) {
      try {
        projects.start(t.id, opts.prompt.trim())
      } catch (e) {
        failRun(getTask(t.id), p, (e as Error).message)
      }
    }
    return created.map((t) => getTask(t.id))
  },

  createAndRun: (opts: CreateRunOpts): ProjectTask => {
    const text = opts.prompt.trim()
    if (!text) throw new Error('Write a prompt or task description first')
    const p = getProject(opts.projectId)
    const kind = opts.kind ?? 'thread'
    const firstLine = text.split('\n')[0].slice(0, 110)
    const extraNotes = opts.notes?.trim() || (text.includes('\n') ? text : '')
    const sort = get<{ s: number }>('SELECT COALESCE(MAX(sort) + 1, 1) AS s FROM project_tasks WHERE project_id = ?', p.id)!.s
    const mentionsJson = JSON.stringify(opts.mentions ?? [])
    const effort = opts.effort ?? getSettings().defaultEffort

    const id = run(
      `INSERT INTO project_tasks
       (project_id, kind, title, notes, status, sort, created_at, cli, model, effort, permission_mode, checkout_mode, mentions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      p.id,
      kind,
      firstLine,
      extraNotes,
      opts.startImmediately !== false ? 'doing' : 'queued',
      sort,
      nowLocal(),
      opts.cli,
      opts.model,
      effort,
      opts.permissionMode,
      opts.checkoutMode,
      mentionsJson
    )

    appendLog(id, 'you', text, opts.cli, `${opts.model} (${effort})`)

    if (opts.startImmediately !== false) {
      return projects.start(id, text)
    }
    return getTask(id)
  },

  saveTask: (
    t: Pick<ProjectTask, 'id' | 'title' | 'notes'> &
      Partial<Pick<ProjectTask, 'cli' | 'model' | 'effort' | 'permission_mode' | 'checkout_mode'>>
  ): ProjectTask => {
    if (!t.title.trim()) throw new Error('Write what the task is')
    const cur = getTask(t.id)
    run(
      `UPDATE project_tasks
       SET title = ?, notes = ?, cli = ?, model = ?, effort = ?, permission_mode = ?, checkout_mode = ?
       WHERE id = ?`,
      t.title.trim(),
      t.notes,
      t.cli ?? cur.cli,
      (t.model ?? cur.model).trim(),
      t.effort ?? cur.effort ?? 'high',
      t.permission_mode ?? cur.permission_mode,
      t.checkout_mode ?? cur.checkout_mode,
      t.id
    )
    return getTask(t.id)
  },

  setStatus: (id: number, status: ProjectTaskStatus): ProjectTask => {
    const cur = getTask(id)
    const now = nowLocal()
    run(
      'UPDATE project_tasks SET status = ?, started_at = ?, done_at = ? WHERE id = ?',
      status,
      status === 'queued' ? null : (cur.started_at ?? now),
      status === 'done' ? now : null,
      id
    )
    return getTask(id)
  },

  reorder: (projectId: number, ids: number[]): true =>
    transaction(() => {
      ids.forEach((id, i) => run('UPDATE project_tasks SET sort = ? WHERE id = ? AND project_id = ?', i, id, projectId))
      return true as const
    }),

  deleteTask: (id: number): true => {
    const t = getTask(id)
    const child = running.get(id)
    if (child) killProcess(child)
    if (t.branch || t.worktree) {
      try {
        removeWorktree(t, getProject(t.project_id))
      } catch {
        // ignore
      }
    }
    run('DELETE FROM project_tasks WHERE id = ?', id)
    return true
  },

  runQueue: (projectId: number, on: boolean): Project => {
    run('UPDATE projects SET auto_run = ? WHERE id = ?', on ? 1 : 0, projectId)
    if (on) {
      const next = get(
        "SELECT 1 AS x FROM project_tasks WHERE project_id = ? AND kind = 'task' AND status = 'queued' AND run_state = ''",
        projectId
      )
      if (!next) {
        run('UPDATE projects SET auto_run = 0 WHERE id = ?', projectId)
        throw new Error('Nothing in the task queue that has not run yet')
      }
      nextInQueue(projectId)
    }
    return getProject(projectId)
  },

  start: (id: number, initialAsk = ''): ProjectTask => {
    const t = getTask(id)
    const p = getProject(t.project_id)
    if (!p.folder) throw new Error(`Set a folder for ${p.name} first so the CLI knows where to work`)
    if (running.has(id)) throw new Error('This session is already running')
    checkFolder(p.folder)
    projects.setStatus(id, 'doing')

    const cli = resolveCliFor(t, p)
    if ((t.session_id || t.agy_conversation || t.codex_thread) && t.worktree && existsSync(t.worktree)) {
      const again =
        initialAsk ||
        (t.check_state === 'failed'
          ? `The verification checks (${p.check_cmd}) failed:\n\n${t.check_output}\n\nFix the issues and summarize what you changed.`
          : 'Continue with the task where you left off and summarize your changes.')
      if (!initialAsk) appendLog(id, 'you', again, cli, t.model)
      executeWithCli(cli, getTask(id), p, again)
      return getTask(id)
    }

    resolveWorkingDir(getTask(id), p)
    const fresh = getTask(id)
    executeWithCli(cli, fresh, p, initialAsk)
    return getTask(id)
  },

  /** Reply in an interactive thread or task (can even switch CLI or model mid-conversation!). */
  reply: (
    id: number,
    text: string,
    opts?: { cli?: CliId; model?: string; effort?: EffortLevel; permissionMode?: PermissionMode; mentions?: MentionItem[] }
  ): ProjectTask => {
    if (!text.trim()) throw new Error('Write a message first')
    if (running.has(id)) throw new Error('Still working on the current turn — wait or press Stop first.')
    const cur = getTask(id)
    if (opts?.cli || opts?.model || opts?.effort || opts?.permissionMode || opts?.mentions) {
      run(
        `UPDATE project_tasks
         SET cli = ?, model = ?, effort = ?, permission_mode = ?, mentions = ?
         WHERE id = ?`,
        opts.cli ?? cur.cli,
        opts.model ?? cur.model,
        opts.effort ?? cur.effort ?? 'high',
        opts.permissionMode ?? cur.permission_mode,
        opts.mentions?.length ? JSON.stringify(opts.mentions) : cur.mentions,
        id
      )
    }
    const updated = getTask(id)
    const p = getProject(updated.project_id)
    const cli = resolveCliFor(updated, p)
    const model = resolveModelFor(cli, updated, p)
    const effort = resolveEffortFor(updated, p)
    appendLog(id, 'you', text.trim(), cli, `${model} (${effort})`)
    executeWithCli(cli, updated, p, text.trim())
    return getTask(id)
  },

  /** Queue a message to run once the current turn finishes. */
  queueMessage: (
    taskId: number,
    prompt: string,
    opts?: { mentions?: MentionItem[]; cli?: CliId; model?: string; effort?: EffortLevel; permissionMode?: PermissionMode }
  ): QueuedMessage => {
    if (!prompt.trim()) throw new Error('Write a message first')
    const created = nowLocal()
    const r = run(
      `INSERT INTO queued_messages (task_id, prompt, mentions, cli, model, effort, permission_mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      taskId,
      prompt.trim(),
      JSON.stringify(opts?.mentions ?? []),
      opts?.cli ?? null,
      opts?.model ?? null,
      opts?.effort ?? null,
      opts?.permissionMode ?? null,
      created
    )
    notifyChanged()
    return get<QueuedMessage>('SELECT * FROM queued_messages WHERE id = ?', r)!
  },

  listQueuedMessages: (taskId: number): QueuedMessage[] =>
    all<QueuedMessage>('SELECT * FROM queued_messages WHERE task_id = ? ORDER BY id ASC', taskId),

  removeQueuedMessage: (id: number): boolean => {
    run('DELETE FROM queued_messages WHERE id = ?', id)
    notifyChanged()
    return true
  },

  /** Interrupt any active run and immediately execute a prompt or a specific queued message. */
  sendNow: (
    taskId: number,
    promptOrQueuedId?: string | number,
    opts?: { mentions?: MentionItem[]; cli?: CliId; model?: string; effort?: EffortLevel; permissionMode?: PermissionMode }
  ): ProjectTask => {
    let prompt = ''
    let options = opts
    if (typeof promptOrQueuedId === 'number') {
      const qm = get<QueuedMessage>('SELECT * FROM queued_messages WHERE id = ?', promptOrQueuedId)
      if (qm) {
        prompt = qm.prompt
        run('DELETE FROM queued_messages WHERE id = ?', qm.id)
        let mentions: MentionItem[] = []
        try { mentions = JSON.parse(qm.mentions || '[]') as MentionItem[] } catch {}
        options = {
          cli: qm.cli,
          model: qm.model,
          effort: qm.effort,
          permissionMode: qm.permission_mode,
          mentions,
          ...opts
        }
      }
    } else if (typeof promptOrQueuedId === 'string' && promptOrQueuedId.trim()) {
      prompt = promptOrQueuedId.trim()
    }

    if (running.has(taskId)) {
      const child = running.get(taskId)
      if (child) killProcess(child)
      running.delete(taskId)
      run("UPDATE project_tasks SET run_state = '' WHERE id = ?", taskId)
    }

    if (!prompt) {
      const nextMsg = get<QueuedMessage>('SELECT * FROM queued_messages WHERE task_id = ? ORDER BY id ASC LIMIT 1', taskId)
      if (nextMsg) {
        prompt = nextMsg.prompt
        run('DELETE FROM queued_messages WHERE id = ?', nextMsg.id)
        let mentions: MentionItem[] = []
        try { mentions = JSON.parse(nextMsg.mentions || '[]') as MentionItem[] } catch {}
        options = {
          cli: nextMsg.cli,
          model: nextMsg.model,
          effort: nextMsg.effort,
          permissionMode: nextMsg.permission_mode,
          mentions,
          ...opts
        }
      }
    }

    if (!prompt) throw new Error('No message to send')
    notifyChanged()
    return projects.reply(taskId, prompt, options)
  },

  stop: (id: number): ProjectTask => {
    const child = running.get(id)
    run("UPDATE project_tasks SET run_state = 'failed', error = 'Stopped by user. Send a message to continue.' WHERE id = ?", id)
    cancelApprovals(id)
    if (child) killProcess(child)
    appendLog(id, 'info', 'Stopped by user')
    return getTask(id)
  },

  check: (id: number): ProjectTask => {
    const t = getTask(id)
    const p = getProject(t.project_id)
    if (!p.check_cmd.trim()) throw new Error(`${p.name} has no check command configured in Project Settings.`)
    if (running.has(id)) throw new Error('Already running')
    run("UPDATE project_tasks SET run_state = 'running', check_state = '', status = 'doing' WHERE id = ?", id)
    const cli = resolveCliFor(t, p)
    runChecks(getTask(id), p, cli, resolveModelFor(cli, t, p))
    return getTask(id)
  },

  log: (id: number): LogLine[] => {
    try {
      return readFileSync(logFile(id), 'utf8')
        .split('\n')
        .filter(Boolean)
        .slice(-500)
        .map((l) => JSON.parse(l) as LogLine)
    } catch {
      return []
    }
  },

  changes: async (id: number): Promise<TaskChanges | null> => {
    const t = getTask(id)
    const p = getProject(t.project_id)
    const cwd = t.worktree && existsSync(t.worktree) ? t.worktree : p.folder && existsSync(p.folder) ? p.folder : ''
    if (!cwd) return null
    try {
      await gitAsync(cwd, ['rev-parse', '--is-inside-work-tree'])
    } catch {
      return null
    }

    const base = t.base_commit || 'HEAD'
    const [logOut, numstatOut, nameStatusOut, statusOut] = await Promise.all([
      t.base_commit ? gitAsync(cwd, ['log', '--format=%h%x09%s', `${t.base_commit}..HEAD`]).catch(() => '') : Promise.resolve(''),
      gitAsync(cwd, ['diff', '--numstat', base]).catch(() => ''),
      gitAsync(cwd, ['diff', '--name-status', base]).catch(() => ''),
      gitAsync(cwd, ['status', '--porcelain'])
    ])

    const commits: { hash: string; subject: string }[] = logOut
      .split('\n')
      .filter(Boolean)
      .map((l) => ({ hash: l.split('\t')[0], subject: l.split('\t').slice(1).join('\t') }))

    const counts = new Map<string, { added: number; removed: number }>()
    for (const l of numstatOut.split('\n').filter(Boolean)) {
      const [a, r, ...path] = l.split('\t')
      counts.set(path.join('\t'), { added: Number(a) || 0, removed: Number(r) || 0 })
    }

    const files: TaskChanges['files'] = []
    for (const l of nameStatusOut.split('\n').filter(Boolean)) {
      const [status, ...rest] = l.split('\t')
      const path = rest[rest.length - 1]
      files.push({ path, status: status[0], ...(counts.get(path) ?? { added: 0, removed: 0 }) })
    }

    const statusLines = statusOut.split('\n').filter(Boolean)
    for (const l of statusLines.filter((x) => x.startsWith('??'))) {
      const pth = l.slice(3).trim()
      if (!files.some((f) => f.path === pth)) {
        files.push({ path: pth, status: 'A', added: 0, removed: 0 })
      }
    }
    return {
      branch: t.branch || 'local',
      cwd,
      commits,
      files,
      uncommitted: statusLines.length > 0
    }
  },

  diff: async (id: number, file: string): Promise<string> => {
    const t = getTask(id)
    const p = getProject(t.project_id)
    const cwd = t.worktree && existsSync(t.worktree) ? t.worktree : p.folder
    if (!cwd || !existsSync(cwd)) return ''
    try {
      const out = await gitAsync(cwd, ['diff', t.base_commit || 'HEAD', '--', file])
      if (out) return out
    } catch {
      // fallback to reading file
    }
    try {
      return readFileSync(join(cwd, file), 'utf8')
        .split('\n')
        .map((l) => `+${l}`)
        .join('\n')
    } catch {
      return ''
    }
  },

  openTerminal: (id: number): true => {
    const t = getTask(id)
    const p = getProject(t.project_id)
    const cli = resolveCliFor(t, p)
    const cwd = t.worktree && existsSync(t.worktree) ? t.worktree : p.folder
    const resumeArg = cli === 'claude' && t.session_id ? `--resume "${t.session_id}"` : ''
    terminal.openExternalCli(cli, cwd, resumeArg)
    return true
  },

  merge: (id: number): ProjectTask => {
    const t = getTask(id)
    const p = getProject(t.project_id)
    if (t.checkout_mode === 'local' || !t.branch || !t.worktree || t.worktree === p.folder) {
      return projects.setStatus(id, 'done')
    }
    if (running.has(id)) throw new Error('Still running')
    if (p.check_cmd.trim() && t.check_state !== 'passed') {
      throw new Error('Verification checks have not passed on this branch yet. Run checks first.')
    }
    commitWorktreeEditsIfNeeded(t, 'Auto-commit before merge')
    if (git(p.folder, ['status', '--porcelain', '--untracked-files=no']).trim()) {
      throw new Error(`${p.name} has uncommitted changes in its main folder. Commit or stash them before merging.`)
    }
    try {
      git(p.folder, ['merge', '--no-ff', '--no-edit', t.branch])
    } catch (e) {
      try {
        git(p.folder, ['merge', '--abort'])
      } catch {
        // ignore
      }
      throw new Error(`Branch did not merge cleanly: ${(e as Error).message}`)
    }
    removeWorktree(t, p)
    appendLog(id, 'info', `Merged ${t.branch} into ${p.name}`)
    run("UPDATE project_tasks SET worktree = NULL, branch = NULL, run_state = '' WHERE id = ?", id)
    return projects.setStatus(id, 'done')
  },

  discard: (id: number): ProjectTask => {
    const t = getTask(id)
    const child = running.get(id)
    if (child) killProcess(child)
    removeWorktree(t, getProject(t.project_id))
    appendLog(id, 'info', 'Worktree branch discarded')
    run(
      "UPDATE project_tasks SET worktree = NULL, branch = NULL, base_commit = NULL, session_id = NULL, agy_conversation = NULL, codex_thread = NULL, runner = '', run_state = '', result = '', error = '', check_state = '', check_output = '' WHERE id = ?",
      id
    )
    return projects.setStatus(id, 'queued')
  }
}
