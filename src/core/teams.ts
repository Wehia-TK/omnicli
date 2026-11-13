import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import type {
  CheckoutMode,
  CliId,
  EffortLevel,
  PermissionMode,
  Team,
  TeamAssignment,
  TeamModelOption,
  TeamRole,
  TeamRoleKind,
  TeamRun,
  TeamStep
} from '@shared/types'
import { clis, isCliReady, modelsForCli } from './clis'
import { all, get, nowLocal, run, transaction } from './db'
import { buildKnowledgePrompt, recordAiHandoff } from './knowledge'
import { appendLog, createAgentTask, getProject, getTask, onAgentSettled, projects, runAgentTurn } from './projects'
import { phoneNotify } from './scheduler'
import {
  extractPlan,
  hiringRights,
  isBlockedModel,
  managerPlanPrompt,
  managerReviewPrompt,
  modelKey,
  modelWeight,
  normalizeAssignments,
  workerPrompt,
  type ReportRef,
  type ReviewResult
} from './teamplan'

/**
 * Teams: you create only a top role (say a CTO). It hires its own reports the first time it needs them, picks the
 * cheapest model that fits each assignment, and reviews what comes back. The org chart is saved and reused.
 *
 * The app, not a model, runs the orchestration, so the cost stays predictable:
 *  - a manager takes a plan turn (ending in a json list of assignments) and one review turn per round, on one resumed session;
 *  - assignments run one at a time on a shared checkout, each as its own lean, hidden `kind = 'agent'` task;
 *  - only capped reports travel up — a manager never reads its reports' transcripts.
 *
 * A run is a tree of steps kept in SQLite. `advance()` reads that tree and starts the next thing, so stopping,
 * resuming and app restarts all work from the stored state.
 */

type StepRow = TeamStep & { tok_mark: number; cost_mark: number; ms_mark: number }
type RunRow = Omit<TeamRun, 'role_title' | 'root_task_id' | 'branch' | 'steps_total' | 'steps_done' | 'tokens' | 'weighted' | 'weighted_top' | 'cost_usd' | 'top_model'>
type Notify = (title: string, body: string, route: string) => void

const ACTIVE = ['planning', 'reviewing', 'working']
const TERMINAL = ['done', 'failed', 'skipped']
const SCRIPT_LIMIT_MS = 15 * 60_000
const CLI_ORDER: CliId[] = ['claude', 'agy', 'codex', 'copilot']
const CLI_NAMES: Record<CliId, string> = { claude: 'Claude Code', agy: 'Antigravity', codex: 'OpenAI Codex', copilot: 'GitHub Copilot' }

let notify: Notify = () => undefined
const scripts = new Map<number, ChildProcess>()

// ───────────────────────────── Lookups ─────────────────────────────

const getTeam = (id: number): Team => {
  const t = get<Team>('SELECT * FROM teams WHERE id = ?', id)
  if (!t) throw new Error('That team no longer exists')
  return t
}
const findRole = (id: number): TeamRole | undefined => get<TeamRole>('SELECT * FROM team_roles WHERE id = ?', id)
const getRole = (id: number): TeamRole => {
  const r = findRole(id)
  if (!r) throw new Error('That role no longer exists')
  return r
}
const topRole = (teamId: number): TeamRole => {
  const r = get<TeamRole>('SELECT * FROM team_roles WHERE team_id = ? AND parent_id IS NULL ORDER BY id LIMIT 1', teamId)
  if (!r) throw new Error('This team has no top role')
  return r
}
const getRunRow = (id: number): RunRow => {
  const r = get<RunRow>('SELECT * FROM team_runs WHERE id = ?', id)
  if (!r) throw new Error('That run no longer exists')
  return r
}
const getStep = (id: number): StepRow => {
  const s = get<StepRow>('SELECT * FROM team_steps WHERE id = ?', id)
  if (!s) throw new Error('That step no longer exists')
  return s
}
const stepsOf = (runId: number): StepRow[] =>
  all<StepRow>(
    `SELECT s.*, r.title AS role_title, r.kind AS role_kind
     FROM team_steps s LEFT JOIN team_roles r ON r.id = s.role_id
     WHERE s.run_id = ? ORDER BY s.id`,
    runId
  )
const rootStep = (runId: number): StepRow | undefined => get<StepRow>('SELECT * FROM team_steps WHERE run_id = ? AND parent_step_id IS NULL ORDER BY id LIMIT 1', runId)
const rolesOf = (teamId: number): TeamRole[] => all<TeamRole>('SELECT * FROM team_roles WHERE team_id = ? ORDER BY id', teamId)
const firstLine = (s: string): string => s.trim().split('\n')[0].replace(/\s+/g, ' ').slice(0, 90)

function depthOf(role: TeamRole): number {
  let depth = 0
  let cur: TeamRole | undefined = role
  while (cur?.parent_id && depth < 50) {
    cur = findRole(cur.parent_id)
    depth++
  }
  return depth
}

const directReports = (roleId: number): ReportRef[] =>
  all<TeamRole>('SELECT * FROM team_roles WHERE parent_id = ? ORDER BY id', roleId).map((r) => ({
    id: r.id,
    title: r.title,
    kind: r.kind,
    job: r.job,
    command: r.command,
    locked: Boolean(r.locked),
    cli: r.cli,
    model: r.model
  }))

// ───────────────────────────── Models ─────────────────────────────

let catalogCache: TeamModelOption[] = []

const option = (cli: CliId, model: { id: string; name: string }, ready: boolean): TeamModelOption => ({
  key: modelKey(cli, model.id),
  cli,
  cliName: CLI_NAMES[cli],
  model: model.id,
  name: model.name,
  weight: modelWeight(model.id),
  ready
})

/** Every model of every subscription (never Fable). `ready` = signed in and not locked out by its usage limit. */
async function refreshCatalog(): Promise<TeamModelOption[]> {
  const status = await clis.statusAll()
  catalogCache = status.flatMap((s) =>
    s.models.filter((m) => !isBlockedModel(m.id)).map((m) => option(s.id, m, s.installed && s.authenticated && s.limit.status !== 'rejected'))
  )
  return catalogCache
}

function catalog(): TeamModelOption[] {
  if (catalogCache.length) return catalogCache
  return CLI_ORDER.flatMap((cli) => {
    const ready = isCliReady(cli)
    return modelsForCli(cli)
      .filter((m) => !isBlockedModel(m.id))
      .map((m) => option(cli, m, ready))
  })
}

function allowedKeys(team: Team): string[] {
  try {
    const keys = JSON.parse(team.allowed_models || '[]') as unknown
    return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : []
  } catch {
    return []
  }
}

/** Models a manager of this team may assign right now. */
function allowedFor(team: Team): TeamModelOption[] {
  const keys = allowedKeys(team)
  return catalog().filter((o) => o.ready && (!keys.length || keys.includes(o.key)))
}

// ───────────────────────────── Usage ─────────────────────────────

/** A step's counters including the turn in flight (the task row is updated live while it streams). */
function withLive(s: StepRow): StepRow {
  if (!s.task_id || !ACTIVE.includes(s.state)) return s
  const t = get<{ tokens: number; cost_usd: number; run_ms: number }>('SELECT tokens, cost_usd, run_ms FROM project_tasks WHERE id = ?', s.task_id)
  if (!t) return s
  return {
    ...s,
    tokens: s.tokens + Math.max(0, t.tokens - s.tok_mark),
    cost_usd: s.cost_usd + Math.max(0, t.cost_usd - s.cost_mark),
    run_ms: s.run_ms + Math.max(0, t.run_ms - s.ms_mark)
  }
}

/** Move what the task spent since the turn started onto the step. */
function settleUsage(s: StepRow): void {
  const live = withLive(s)
  run('UPDATE team_steps SET tokens = ?, cost_usd = ?, run_ms = ? WHERE id = ?', live.tokens, live.cost_usd, live.run_ms, s.id)
}

function usage(steps: StepRow[]): { tokens: number; weighted: number; costUsd: number } {
  let tokens = 0
  let weighted = 0
  let costUsd = 0
  for (const s of steps.map(withLive)) {
    tokens += s.tokens
    weighted += s.tokens * modelWeight(s.model)
    costUsd += s.cost_usd
  }
  return { tokens, weighted: Math.round(weighted), costUsd }
}

const budgetPct = (runId: number, team: Team): number => (usage(stepsOf(runId)).weighted / Math.max(1, team.token_budget)) * 100

function summarize(r: RunRow): TeamRun {
  const steps = stepsOf(r.id)
  const root = steps.find((s) => s.parent_step_id === null)
  const u = usage(steps)
  const rootTask = root?.task_id ? get<{ branch: string | null; checkout_mode: string }>('SELECT branch, checkout_mode FROM project_tasks WHERE id = ?', root.task_id) : undefined
  return {
    ...r,
    role_title: findRole(r.role_id)?.title ?? '(removed role)',
    root_task_id: root?.task_id ?? null,
    branch: rootTask?.checkout_mode === 'worktree' ? rootTask.branch : null,
    steps_total: steps.length,
    steps_done: steps.filter((s) => TERMINAL.includes(s.state)).length,
    tokens: u.tokens,
    weighted: u.weighted,
    weighted_top: Math.round(u.tokens * modelWeight(root?.model ?? '')),
    cost_usd: u.costUsd,
    top_model: root?.model ?? ''
  }
}

// ───────────────────────────── Engine ─────────────────────────────

function scheduleAdvance(runId: number): void {
  setImmediate(() => {
    try {
      advance(runId)
    } catch (e) {
      console.error('[teams] advance failed', e)
    }
  })
}

function failStep(s: StepRow, why: string): void {
  run("UPDATE team_steps SET state = 'failed', error = ? WHERE id = ?", why.slice(0, 1000), s.id)
}

/** Start the next thing a running run needs: one turn or script at a time, depth-first through the step tree. */
function advance(runId: number): void {
  const r = get<RunRow>('SELECT * FROM team_runs WHERE id = ?', runId)
  if (!r || r.state !== 'running') return
  const steps = stepsOf(runId)
  if (steps.some((s) => ACTIVE.includes(s.state) || s.state === 'approval')) return
  const root = steps.find((s) => s.parent_step_id === null)
  if (!root) return
  if (TERMINAL.includes(root.state)) return finishRun(r, root)
  visit(root, r)
}

function visit(s: StepRow, r: RunRow): boolean {
  if (s.state === 'pending') {
    const role = findRole(s.role_id)
    launch(s, role?.kind === 'manager' ? 'plan' : 'work')
    return true
  }
  if (s.state !== 'waiting') return false
  const team = getTeam(r.team_id)
  const kids = all<StepRow>('SELECT * FROM team_steps WHERE parent_step_id = ? AND round = ? ORDER BY seq, id', s.id, s.rounds)
  const spent = budgetPct(r.id, team) >= 100
  for (const k of kids) {
    if (k.state === 'pending' && spent) {
      run("UPDATE team_steps SET state = 'skipped' WHERE id = ?", k.id)
      continue
    }
    if (k.state === 'pending' || k.state === 'waiting') return visit(k, r)
  }
  launch(s, 'review') // every assignment of this round is finished, failed or skipped
  return true
}

function launch(s: StepRow, phase: 'plan' | 'review' | 'work'): void {
  try {
    const r = getRunRow(s.run_id)
    const role = findRole(s.role_id)
    if (!role) throw new Error('This role was removed from the team')
    if (role.kind === 'script') return launchScript(s, r, role)
    if (!s.cli || !s.model) throw new Error('None of the models this team may use is signed in right now')

    const team = getTeam(r.team_id)
    const p = getProject(r.project_id)
    const root = rootStep(r.id)
    const isRoot = s.parent_step_id === null
    const rootTaskId = isRoot ? null : (root?.task_id ?? null)
    const readOnly = role.kind === 'manager' || s.access !== 'write'
    const perm: PermissionMode = readOnly ? 'plan' : r.permission_mode
    const cli = s.cli as CliId

    let taskId = s.task_id && get('SELECT 1 AS x FROM project_tasks WHERE id = ?', s.task_id) ? s.task_id : null
    if (!taskId) {
      // The same role working again in this run continues its own session: it already knows what it did
      const earlier = get<{ task_id: number }>(
        'SELECT task_id FROM team_steps WHERE run_id = ? AND role_id = ? AND cli = ? AND task_id IS NOT NULL AND id <> ? ORDER BY id DESC LIMIT 1',
        r.id,
        s.role_id,
        s.cli,
        s.id
      )
      taskId =
        earlier?.task_id ??
        createAgentTask({
          projectId: p.id,
          title: `${role.title}: ${firstLine(s.brief)}`,
          cli,
          model: s.model,
          effort: s.effort,
          permissionMode: perm,
          checkoutMode: r.checkout_mode,
          shareWith: rootTaskId
        }).id
    }
    if (rootTaskId && rootTaskId !== taskId) {
      // Everyone in a run works in the top role's checkout, so the whole run lands on one branch
      const rt = getTask(rootTaskId)
      run('UPDATE project_tasks SET checkout_mode = ?, worktree = ?, branch = ?, base_commit = ? WHERE id = ?', rt.checkout_mode, rt.worktree, rt.branch, rt.base_commit, taskId)
    }
    const t = getTask(taskId)
    run(
      "UPDATE team_steps SET task_id = ?, state = ?, phase = ?, tok_mark = ?, cost_mark = ?, ms_mark = ?, error = '' WHERE id = ?",
      taskId,
      phase === 'plan' ? 'planning' : phase === 'review' ? 'reviewing' : 'working',
      phase,
      t.tokens,
      t.cost_usd,
      t.run_ms,
      s.id
    )

    const parentRole = s.parent_step_id ? findRole(getStep(s.parent_step_id).role_id) : undefined
    const parentTitle = s.parent_step_id ? (parentRole?.title ?? 'your manager') : null
    const cwd = t.worktree && existsSync(t.worktree) ? t.worktree : undefined
    const pct = budgetPct(r.id, team)
    let prompt: string

    if (phase === 'plan') {
      prompt = managerPlanPrompt({
        title: role.title,
        job: role.job,
        parentTitle,
        reports: directReports(role.id),
        allowed: allowedFor(team),
        hiresLeft: Math.max(0, team.max_roles - rolesOf(team.id).length),
        ...hiringRights(depthOf(role), team.max_depth),
        budgetPct: pct,
        kb: buildKnowledgePrompt(p.id, cwd),
        brief: s.brief,
        reportWords: team.report_words
      })
    } else if (phase === 'review') {
      const kids = all<StepRow>('SELECT * FROM team_steps WHERE parent_step_id = ? AND round = ? ORDER BY seq, id', s.id, s.rounds)
      const results: ReviewResult[] = kids.map((k) => ({
        roleId: k.role_id,
        title: findRole(k.role_id)?.title ?? 'Removed role',
        state: k.state === 'done' ? 'done' : k.state === 'skipped' ? 'skipped' : 'failed',
        model: k.model,
        tokens: k.tokens,
        report: k.report,
        error: k.error
      }))
      const roundsLeft = Math.max(0, 1 + team.max_rounds - s.rounds)
      prompt = managerReviewPrompt({
        title: role.title,
        parentTitle,
        briefRecap: s.brief.replace(/\s+/g, ' ').slice(0, 300),
        round: s.rounds,
        results,
        notes: s.notes.split('\n').filter(Boolean),
        budgetPct: pct,
        roundsLeft,
        final: roundsLeft <= 0 || pct >= 100,
        reportWords: team.report_words
      })
    } else {
      prompt = workerPrompt({
        title: role.title,
        job: role.job,
        managerTitle: parentTitle,
        access: readOnly ? 'read' : 'write',
        kb: buildKnowledgePrompt(p.id, cwd),
        brief: s.brief,
        reportWords: team.report_words
      })
    }
    runAgentTurn(taskId, prompt, { cli, model: s.model, effort: s.effort, permissionMode: perm, lean: Boolean(team.lean) })
  } catch (e) {
    failStep(getStep(s.id), (e as Error).message)
    scheduleAdvance(s.run_id)
  }
}

/** A script role: the app runs its fixed command in the run's checkout and reports the end of the output. No tokens. */
function launchScript(s: StepRow, r: RunRow, role: TeamRole): void {
  const p = getProject(r.project_id)
  const root = rootStep(r.id)
  const rootTask = root?.task_id ? getTask(root.task_id) : undefined
  const cwd = rootTask?.worktree && existsSync(rootTask.worktree) ? rootTask.worktree : p.folder
  if (!role.command.trim()) throw new Error(`${role.title} has no command to run`)
  if (!cwd || !existsSync(cwd)) throw new Error(`Can't find the folder ${cwd}`)
  run("UPDATE team_steps SET state = 'working', phase = 'work', error = '' WHERE id = ?", s.id)

  const startedAt = Date.now()
  const child = spawn(role.command, { shell: true, cwd, windowsHide: true })
  scripts.set(s.id, child)
  let out = ''
  const keep = (d: Buffer): void => {
    out = (out + d.toString('utf8')).slice(-8000)
  }
  child.stdout?.on('data', keep)
  child.stderr?.on('data', keep)
  const limit = setTimeout(() => killTree(child), SCRIPT_LIMIT_MS)
  child.on('error', (e) => (out += e.message))
  child.on('close', (code) => {
    clearTimeout(limit)
    scripts.delete(s.id)
    const cur = get<StepRow>('SELECT * FROM team_steps WHERE id = ?', s.id)
    if (!cur || cur.state !== 'working') return // stopped meanwhile
    const tail = out.replace(/\x1b\[[0-9;]*m/g, '').trim().slice(-1600) || '(no output)'
    const report = `\`${role.command}\` exited with code ${code}.\n\`\`\`\n${tail}\n\`\`\``
    run(
      'UPDATE team_steps SET state = ?, report = ?, error = ?, run_ms = run_ms + ? WHERE id = ?',
      code === 0 ? 'done' : 'failed',
      report,
      code === 0 ? '' : `Exit code ${code}`,
      Date.now() - startedAt,
      s.id
    )
    scheduleAdvance(s.run_id)
  })
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
  else {
    try {
      child.kill('SIGKILL')
    } catch {
      // already gone
    }
  }
}

/** A team agent's turn ended (wired through projects.onAgentSettled). */
function settle(taskId: number, ok: boolean): void {
  const s = get<StepRow>("SELECT * FROM team_steps WHERE task_id = ? AND state IN ('planning', 'reviewing', 'working') ORDER BY id DESC LIMIT 1", taskId)
  if (!s) return // a turn the user sent to this agent by hand
  try {
    const t = getTask(taskId)
    settleUsage(s)
    void refreshCatalog().catch(() => undefined) // a subscription may have just hit its limit
    if (!ok) {
      failStep(s, t.error || 'The run stopped')
    } else if (s.state === 'working') {
      run("UPDATE team_steps SET state = 'done', report = ? WHERE id = ?", t.result.trim(), s.id)
    } else {
      const team = getTeam(getRunRow(s.run_id).team_id)
      const plan = extractPlan(t.result)
      const roundsLeft = 1 + team.max_rounds - s.rounds
      const mayDelegate = roundsLeft > 0 && (s.state === 'planning' || budgetPct(s.run_id, team) < 100)
      if (plan?.assignments.length && mayDelegate) delegate(getStep(s.id), team, plan.assignments)
      else run("UPDATE team_steps SET state = 'done', report = ?, notes = '' WHERE id = ?", (plan ? plan.report || plan.prose : t.result).trim() || '(no report)', s.id)
    }
  } catch (e) {
    failStep(s, (e as Error).message)
  }
  scheduleAdvance(s.run_id)
}

/** Turn a manager's plan into hires and child steps (or park it for the user's approval when hires need one). */
function delegate(s: StepRow, team: Team, raw: unknown[]): void {
  const role = getRole(s.role_id)
  const { assignments, warnings } = normalizeAssignments(raw, {
    reports: directReports(role.id),
    allowed: allowedFor(team),
    hiresLeft: Math.max(0, team.max_roles - rolesOf(team.id).length),
    ...hiringRights(depthOf(role), team.max_depth)
  })
  if (s.task_id) for (const w of warnings) appendLog(s.task_id, 'info', w)
  const hires = [...new Set(assignments.filter((a) => a.roleId === null).map((a) => a.title))]
  if (team.approve_hires && hires.length) {
    run("UPDATE team_steps SET state = 'approval', plan_json = ? WHERE id = ?", JSON.stringify({ assignments, warnings }), s.id)
    const r = getRunRow(s.run_id)
    const title = `${team.name}: ${role.title} wants to hire`
    notify(title, hires.join(', '), `teams/${r.project_id}/${r.id}`)
    phoneNotify(title, hires.join(', '))
    return
  }
  applyAssignments(s, assignments, warnings)
}

function applyAssignments(s: StepRow, assignments: TeamAssignment[], warnings: string[]): void {
  const r = getRunRow(s.run_id)
  const role = getRole(s.role_id)
  const round = s.rounds + 1
  transaction(() => {
    const hired = new Map<string, number>()
    assignments.forEach((a, seq) => {
      let roleId = a.roleId
      if (roleId === null) {
        const key = a.title.toLowerCase()
        roleId =
          hired.get(key) ??
          run(
            `INSERT INTO team_roles (team_id, parent_id, title, job, kind, cli, model, effort, hired_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manager', ?)`,
            r.team_id,
            role.id,
            a.title,
            a.job,
            a.kind,
            a.cli,
            a.model,
            a.effort,
            nowLocal()
          )
        hired.set(key, roleId)
      } else if (a.kind !== 'script') {
        run('UPDATE team_roles SET cli = ?, model = ?, effort = ? WHERE id = ? AND locked = 0', a.cli, a.model, a.effort, roleId)
      }
      run(
        `INSERT INTO team_steps (run_id, role_id, parent_step_id, seq, round, brief, access, cli, model, effort, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        r.id,
        roleId,
        s.id,
        seq,
        round,
        a.brief,
        a.access,
        a.cli,
        a.model,
        a.effort,
        nowLocal()
      )
    })
    // With nothing usable left, the review turn still runs so the manager can read the notes and finish
    run("UPDATE team_steps SET state = 'waiting', rounds = ?, plan_json = '', notes = ? WHERE id = ?", round, warnings.join('\n'), s.id)
  })
}

function finishRun(r: RunRow, root: StepRow): void {
  const done = root.state === 'done'
  run('UPDATE team_runs SET state = ?, result = ?, error = ?, done_at = ? WHERE id = ?', done ? 'done' : 'failed', root.report, done ? '' : root.error || 'The top role could not finish', nowLocal(), r.id)
  try {
    const team = getTeam(r.team_id)
    const p = getProject(r.project_id)
    const title = `${p.name}: ${team.name} ${done ? 'finished' : 'stopped'}`
    const body = `${firstLine(r.prompt)}\n${(done ? root.report : root.error).replace(/\s+/g, ' ').slice(0, 140)}`
    notify(title, body, `teams/${p.id}/${r.id}`)
    phoneNotify(title, body)
    if (done && root.cli) recordAiHandoff(p.id, root.cli, root.model, `${team.name}: ${firstLine(r.prompt)}`, root.report, [])
  } catch (e) {
    console.warn('[teams]', (e as Error).message)
  }
}

/** Bring a stopped or failed branch of the step tree back to the point where it broke. */
function revive(s: StepRow): void {
  let state = s.state
  if (state === 'failed') {
    state = s.phase === 'review' ? 'waiting' : 'pending'
    run("UPDATE team_steps SET state = ?, error = '' WHERE id = ?", state, s.id)
  }
  if (state === 'waiting') {
    for (const k of all<StepRow>('SELECT * FROM team_steps WHERE parent_step_id = ? AND round = ?', s.id, s.rounds)) revive(k)
  }
}

export function initTeams(n: Notify): void {
  notify = n
  onAgentSettled(settle)
  for (const s of all<StepRow>("SELECT * FROM team_steps WHERE state IN ('planning', 'reviewing', 'working')")) {
    if (s.task_id) settleUsage(s)
    failStep(s, 'The app closed while this was running.')
  }
  run("UPDATE team_runs SET state = 'stopped', error = 'The app closed while this run was working. Resume to continue.' WHERE state = 'running'")
}

export function stopTeams(): void {
  for (const child of scripts.values()) killTree(child)
}

// ───────────────────────────── API ─────────────────────────────

const clamp = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback
}

const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
const cleanEffort = (e: unknown): EffortLevel => (EFFORTS.includes(e as EffortLevel) ? (e as EffortLevel) : 'medium')

function checkModel(cli: string, model: string, who: string): void {
  if (!CLI_ORDER.includes(cli as CliId) || !model.trim()) throw new Error(`Pick a model for ${who}`)
  if (isBlockedModel(model)) throw new Error('Fable models are not available to teams')
}

function activeRunFor(teamId: number): boolean {
  return Boolean(get("SELECT 1 AS x FROM team_runs WHERE team_id = ? AND state = 'running'", teamId))
}

export interface TeamSaveInput extends Partial<Omit<Team, 'allowed_models' | 'roles'>> {
  name: string
  allowed_models?: string[]
  /** The top role: required when creating a team */
  top?: { title: string; job: string; cli: CliId; model: string; effort?: EffortLevel }
}

export const teams = {
  list: (): Team[] => all<Team>('SELECT * FROM teams ORDER BY id').map((t) => ({ ...t, roles: rolesOf(t.id) })),

  /** Models that can be offered to a team, with estimated relative cost. */
  modelCatalog: (): Promise<TeamModelOption[]> => refreshCatalog(),

  save: (input: TeamSaveInput): Team => {
    const name = input.name.trim()
    if (!name) throw new Error('Give the team a name')
    const cur = input.id ? getTeam(input.id) : undefined
    if (!cur && !input.top) throw new Error('Set the top role first')
    if (input.top) {
      if (!input.top.title.trim()) throw new Error('Give the top role a job title')
      checkModel(input.top.cli, input.top.model, 'the top role')
    }
    const allowed = (input.allowed_models ?? (cur ? allowedKeys(cur) : [])).filter((k) => typeof k === 'string' && !isBlockedModel(k))
    const f = {
      allowed: JSON.stringify(allowed),
      maxRoles: clamp(input.max_roles ?? cur?.max_roles, 1, 60, 12),
      maxDepth: clamp(input.max_depth ?? cur?.max_depth, 2, 6, 3),
      maxRounds: clamp(input.max_rounds ?? cur?.max_rounds, 0, 5, 2),
      budget: clamp(input.token_budget ?? cur?.token_budget, 50_000, 100_000_000, 1_500_000),
      words: clamp(input.report_words ?? cur?.report_words, 60, 1000, 250),
      lean: (input.lean ?? cur?.lean ?? 1) ? 1 : 0,
      approve: (input.approve_hires ?? cur?.approve_hires ?? 0) ? 1 : 0
    }
    return transaction(() => {
      const id = cur
        ? (run(
            'UPDATE teams SET name = ?, allowed_models = ?, max_roles = ?, max_depth = ?, max_rounds = ?, token_budget = ?, report_words = ?, lean = ?, approve_hires = ? WHERE id = ?',
            name,
            f.allowed,
            f.maxRoles,
            f.maxDepth,
            f.maxRounds,
            f.budget,
            f.words,
            f.lean,
            f.approve,
            cur.id
          ),
          cur.id)
        : run(
            'INSERT INTO teams (name, allowed_models, max_roles, max_depth, max_rounds, token_budget, report_words, lean, approve_hires, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            name,
            f.allowed,
            f.maxRoles,
            f.maxDepth,
            f.maxRounds,
            f.budget,
            f.words,
            f.lean,
            f.approve,
            nowLocal()
          )
      if (input.top) {
        const top = get<TeamRole>('SELECT * FROM team_roles WHERE team_id = ? AND parent_id IS NULL', id)
        const t = input.top
        if (top) run('UPDATE team_roles SET title = ?, job = ?, cli = ?, model = ?, effort = ? WHERE id = ?', t.title.trim(), t.job.trim(), t.cli, t.model, cleanEffort(t.effort), top.id)
        else
          run(
            "INSERT INTO team_roles (team_id, parent_id, title, job, kind, cli, model, effort, locked, hired_by, created_at) VALUES (?, NULL, ?, ?, 'manager', ?, ?, ?, 1, 'user', ?)",
            id,
            t.title.trim(),
            t.job.trim(),
            t.cli,
            t.model,
            cleanEffort(t.effort),
            nowLocal()
          )
      }
      return { ...getTeam(id), roles: rolesOf(id) }
    })
  },

  delete: (id: number): true => {
    for (const r of all<{ id: number }>('SELECT id FROM team_runs WHERE team_id = ?', id)) teams.deleteRun(r.id)
    run('DELETE FROM teams WHERE id = ?', id)
    return true
  },

  /** Add or edit a role by hand (managers also hire on their own while they work). */
  saveRole: (input: Partial<TeamRole> & { team_id: number; title: string }): TeamRole => {
    const title = input.title.trim()
    if (!title) throw new Error('Give the role a job title')
    const team = getTeam(input.team_id)
    const cur = input.id ? getRole(input.id) : undefined
    if (cur && cur.team_id !== team.id) throw new Error('That role belongs to another team')
    const isTop = cur ? cur.parent_id === null : false
    const kind: TeamRoleKind = isTop ? 'manager' : (['manager', 'worker', 'script'] as const).includes(input.kind as TeamRoleKind) ? (input.kind as TeamRoleKind) : (cur?.kind ?? 'worker')
    const command = (input.command ?? cur?.command ?? '').trim()
    if (kind === 'script' && !command) throw new Error('A script role needs the command it runs')
    const cli = kind === 'script' ? '' : (input.cli ?? cur?.cli ?? '')
    const model = kind === 'script' ? '' : (input.model ?? cur?.model ?? '').trim()
    if (model || isTop) checkModel(cli, model, title)
    const locked = model && (input.locked ?? cur?.locked ?? 0) ? 1 : 0

    let parentId: number | null = null
    if (!isTop) {
      parentId = input.parent_id ?? cur?.parent_id ?? topRole(team.id).id
      const parent = getRole(parentId)
      if (parent.team_id !== team.id) throw new Error('A role can only report to someone in its own team')
      if (parent.kind === 'script') throw new Error('Nobody can report to a script role')
      for (let p: TeamRole | undefined = parent, i = 0; p && i < 50; p = p.parent_id ? findRole(p.parent_id) : undefined, i++) {
        if (cur && p.id === cur.id) throw new Error('A role cannot report to itself or to someone below it')
      }
      if (cur && kind !== 'manager' && directReports(cur.id).length) throw new Error(`${cur.title} has people reporting to it, so it has to stay a manager`)
    }
    if (!cur && rolesOf(team.id).length >= team.max_roles) throw new Error(`This team is at its limit of ${team.max_roles} roles. Raise the limit in the team settings first.`)

    return transaction(() => {
      // Whoever has people under them is a manager
      if (parentId) run("UPDATE team_roles SET kind = 'manager' WHERE id = ? AND kind = 'worker'", parentId)
      const id = cur
        ? (run(
            'UPDATE team_roles SET parent_id = ?, title = ?, job = ?, kind = ?, cli = ?, model = ?, effort = ?, command = ?, locked = ? WHERE id = ?',
            parentId,
            title,
            (input.job ?? cur.job).trim(),
            kind,
            cli,
            model,
            cleanEffort(input.effort ?? cur.effort),
            command,
            isTop ? 1 : locked,
            cur.id
          ),
          cur.id)
        : run(
            "INSERT INTO team_roles (team_id, parent_id, title, job, kind, cli, model, effort, command, locked, hired_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user', ?)",
            team.id,
            parentId,
            title,
            (input.job ?? '').trim(),
            kind,
            cli,
            model,
            cleanEffort(input.effort),
            command,
            locked,
            nowLocal()
          )
      return getRole(id)
    })
  },

  deleteRole: (id: number): true => {
    const role = getRole(id)
    if (role.parent_id === null) throw new Error('The top role cannot be removed. Delete the team instead.')
    if (activeRunFor(role.team_id)) throw new Error('This team is working right now. Stop the run before removing a role.')
    run('DELETE FROM team_roles WHERE id = ?', id) // everyone below goes with it (ON DELETE CASCADE)
    return true
  },

  runs: (projectId: number, teamId?: number): TeamRun[] =>
    (teamId
      ? all<RunRow>('SELECT * FROM team_runs WHERE project_id = ? AND team_id = ? ORDER BY id DESC LIMIT 30', projectId, teamId)
      : all<RunRow>('SELECT * FROM team_runs WHERE project_id = ? ORDER BY id DESC LIMIT 30', projectId)
    ).map(summarize),

  run: (runId: number): { run: TeamRun; steps: TeamStep[] } => ({ run: summarize(getRunRow(runId)), steps: stepsOf(runId).map(withLive) }),

  /** Hand a task to a role (the top role unless `roleId` says otherwise) and let it delegate from there. */
  startRun: async (o: {
    teamId: number
    projectId: number
    prompt: string
    roleId?: number | null
    permissionMode?: PermissionMode
    checkoutMode?: CheckoutMode
    continuesRunId?: number | null
  }): Promise<TeamRun> => {
    const prompt = o.prompt.trim()
    if (!prompt) throw new Error('Write the task first')
    const team = getTeam(o.teamId)
    const p = getProject(o.projectId)
    if (!p.folder) throw new Error(`Set a folder for ${p.name} first so the team knows where to work`)

    const prev = o.continuesRunId ? getRunRow(o.continuesRunId) : undefined
    if (prev && (prev.team_id !== team.id || prev.project_id !== p.id)) throw new Error('A follow-up has to stay with the same team and project')
    if (prev?.state === 'running') throw new Error('That run is still working. Wait for it or stop it first.')
    const role = prev ? getRole(prev.role_id) : o.roleId ? getRole(o.roleId) : topRole(team.id)
    if (role.team_id !== team.id) throw new Error('That role belongs to another team')

    let cli = ''
    let model = ''
    if (role.kind !== 'script') {
      const options = await refreshCatalog()
      // A role that has never worked (hired but not yet used) starts on the cheapest model the team may use
      const pick = role.model
        ? options.find((x) => x.cli === role.cli && x.model === role.model)
        : allowedFor(team).reduce<TeamModelOption | undefined>((best, x) => (!best || x.weight < best.weight ? x : best), undefined)
      if (!pick) throw new Error(`${role.title} has no usable model. Pick one for it in the org chart.`)
      if (!pick.ready) throw new Error(`${pick.name} on ${pick.cliName} can't be used right now (signed out or at its usage limit). Pick another model for ${role.title}, or try again later.`)
      cli = pick.cli
      model = pick.model
    }
    const prevRootTask = prev ? (rootStep(prev.id)?.task_id ?? null) : null
    const checkout: CheckoutMode = prev ? prev.checkout_mode : o.checkoutMode === 'local' ? 'local' : 'worktree'
    const perm: PermissionMode = prev ? prev.permission_mode : o.permissionMode === 'bypass' || o.permissionMode === 'default' ? o.permissionMode : 'accept-edits'

    const id = transaction(() => {
      const runId = run(
        "INSERT INTO team_runs (team_id, project_id, role_id, prompt, state, permission_mode, checkout_mode, continues_run_id, created_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)",
        team.id,
        p.id,
        role.id,
        prompt,
        perm,
        checkout,
        prev?.id ?? null,
        nowLocal()
      )
      run(
        "INSERT INTO team_steps (run_id, role_id, parent_step_id, task_id, brief, access, cli, model, effort, state, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'pending', ?)",
        runId,
        role.id,
        prevRootTask,
        prompt,
        role.kind === 'manager' ? 'read' : 'write',
        cli,
        model,
        role.effort,
        nowLocal()
      )
      return runId
    })
    scheduleAdvance(id)
    return summarize(getRunRow(id))
  },

  stopRun: (id: number): TeamRun => {
    const r = getRunRow(id)
    if (r.state !== 'running') return summarize(r)
    run("UPDATE team_runs SET state = 'stopped', error = 'Stopped by you. Resume to continue where it left off.', done_at = ? WHERE id = ?", nowLocal(), id)
    for (const s of stepsOf(id).filter((x) => ACTIVE.includes(x.state))) {
      const child = scripts.get(s.id)
      if (child) {
        killTree(child)
        failStep(s, 'Stopped by you')
      } else if (s.task_id) projects.stop(s.task_id) // settles the step as failed and books what it used
      else failStep(s, 'Stopped by you')
    }
    return summarize(getRunRow(id))
  },

  /** Continue a stopped or failed run: whatever broke is retried, finished work is kept. */
  resumeRun: async (id: number): Promise<TeamRun> => {
    const r = getRunRow(id)
    if (r.state === 'running') return summarize(r)
    if (r.state === 'done') throw new Error('This run already finished. Send a follow-up instead.')
    const root = rootStep(id)
    if (!root) throw new Error('This run has nothing to resume')
    await refreshCatalog()
    transaction(() => {
      revive(root)
      run("UPDATE team_runs SET state = 'running', error = '', done_at = NULL WHERE id = ?", id)
    })
    scheduleAdvance(id)
    return summarize(getRunRow(id))
  },

  /** Remove a run with its agent sessions. Its branch goes too, unless a follow-up run still uses it. */
  deleteRun: (id: number): true => {
    const r = getRunRow(id)
    if (r.state === 'running') teams.stopRun(id)
    for (const child of [...scripts.entries()].filter(([stepId]) => get('SELECT 1 AS x FROM team_steps WHERE id = ? AND run_id = ?', stepId, id))) killTree(child[1])
    const root = rootStep(id)
    const taskIds = [...new Set(stepsOf(id).map((s) => s.task_id).filter((x): x is number => Boolean(x)))]
    for (const taskId of taskIds) {
      if (get('SELECT 1 AS x FROM team_steps WHERE task_id = ? AND run_id <> ?', taskId, id)) continue // a follow-up continues this session
      const owner = taskId === root?.task_id
      try {
        // Only the top role's task owns the run's worktree; the others just worked inside it
        if (!owner) run("UPDATE project_tasks SET worktree = NULL, branch = NULL, checkout_mode = 'local' WHERE id = ?", taskId)
        projects.deleteTask(taskId)
      } catch {
        // already gone
      }
    }
    run('UPDATE team_runs SET continues_run_id = NULL WHERE continues_run_id = ?', id)
    run('DELETE FROM team_runs WHERE id = ?', id)
    return true
  },

  /** Answer a manager's request to hire (only asked when the team requires approval). */
  decideHires: (stepId: number, approve: boolean): true => {
    const s = getStep(stepId)
    if (s.state !== 'approval') throw new Error('That request is no longer waiting')
    let parsed: { assignments: TeamAssignment[]; warnings: string[] }
    try {
      parsed = JSON.parse(s.plan_json) as { assignments: TeamAssignment[]; warnings: string[] }
    } catch {
      parsed = { assignments: [], warnings: [] }
    }
    const declined = [...new Set(parsed.assignments.filter((a) => a.roleId === null).map((a) => a.title))]
    const assignments = approve ? parsed.assignments : parsed.assignments.filter((a) => a.roleId !== null)
    const warnings = approve ? parsed.warnings : [...parsed.warnings, `The user declined these hires, so their assignments were dropped: ${declined.join(', ')}. Use your existing reports or finish.`]
    applyAssignments(s, assignments, warnings)
    scheduleAdvance(s.run_id)
    return true
  }
}
