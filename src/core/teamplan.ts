import type { EffortLevel, TeamAssignment, TeamModelOption, TeamRoleKind } from '@shared/types'

/**
 * Pure rules for Teams (no database, Electron or process imports, so they are unit-tested in test/teamplan.test.mts):
 * model cost weights, parsing a manager's delegation plan, and the prompts each role receives.
 */

// ───────────────────────────── Models & cost ─────────────────────────────

/** Models a team may never use. */
export const isBlockedModel = (modelId: string): boolean => /fable/i.test(modelId)

export const modelKey = (cli: string, model: string): string => `${cli}:${model}`

export function splitModelKey(key: string): { cli: string; model: string } {
  const i = key.indexOf(':')
  return i < 0 ? { cli: '', model: key } : { cli: key.slice(0, i), model: key.slice(i + 1) }
}

/**
 * Estimated cost of one token relative to an Opus-class model (= 1). These are rough tiers taken from the model
 * name, not billing data: they exist so a manager can rank models and a run can be compared with "all on the top model".
 */
export function modelWeight(modelId: string): number {
  const m = modelId.toLowerCase()
  if (/opus/.test(m)) return 1
  if (/haiku|flash|mini|nano|lite|oss/.test(m)) return 0.2
  return 0.6
}

/** Hiring rights by position: the top role is depth 0, and `maxDepth` counts levels including it. */
export function hiringRights(depth: number, maxDepth: number): { canHire: boolean; canHireManagers: boolean } {
  return { canHire: depth + 1 < maxDepth, canHireManagers: depth + 2 < maxDepth }
}

// ───────────────────────────── Reading a manager's plan ─────────────────────────────

export interface RawPlan {
  assignments: unknown[]
  report: string
  /** The reply with the plan's json removed */
  prose: string
}

/** Top-level `{…}` spans in a text (string-aware, so braces inside JSON strings don't confuse it). */
function balancedObjects(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  let depth = 0
  let start = -1
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"' && depth > 0) inString = true
    else if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}' && depth > 0) {
      depth--
      if (depth === 0) out.push({ start, end: i + 1 })
    }
  }
  return out
}

/** Find the delegation plan in a manager's reply: the last json object that has `assignments` or `report`. */
export function extractPlan(text: string): RawPlan | null {
  const spans: { start: number; end: number; json: string }[] = []
  const fence = /```[a-zA-Z]*[ \t]*\r?\n?([\s\S]*?)```/g
  let m: RegExpExecArray | null
  while ((m = fence.exec(text))) spans.push({ start: m.index, end: m.index + m[0].length, json: m[1].trim() })
  for (const s of balancedObjects(text)) {
    // An object inside a fence is already covered by the fence span (which also removes the fence from the prose)
    if (!spans.some((f) => s.start >= f.start && s.end <= f.end)) spans.push({ ...s, json: text.slice(s.start, s.end) })
  }
  spans.sort((a, b) => b.end - a.end)
  for (const s of spans) {
    if (!s.json.startsWith('{')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(s.json)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const o = parsed as Record<string, unknown>
    if (!Array.isArray(o.assignments) && typeof o.report !== 'string') continue
    return {
      assignments: Array.isArray(o.assignments) ? o.assignments : [],
      report: typeof o.report === 'string' ? o.report.trim() : '',
      prose: (text.slice(0, s.start) + text.slice(s.end)).trim()
    }
  }
  return null
}

export interface ReportRef {
  id: number
  title: string
  kind: TeamRoleKind
  job: string
  command: string
  locked: boolean
  cli: string
  model: string
}

export interface NormalizeCtx {
  /** The manager's existing direct reports */
  reports: ReportRef[]
  /** Models this team may use that are signed in right now */
  allowed: TeamModelOption[]
  hiresLeft: number
  canHire: boolean
  canHireManagers: boolean
  maxAssignments?: number
}

const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '').trim()
const sameTitle = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

const cheapest = (allowed: TeamModelOption[]): TeamModelOption | undefined =>
  allowed.reduce<TeamModelOption | undefined>((best, o) => (!best || o.weight < best.weight ? o : best), undefined)

/** Resolve what a manager wrote in "model" to an allowed model; falls back to the role's current one, then the cheapest. */
export function pickModel(
  spec: string,
  allowed: TeamModelOption[],
  current?: { cli: string; model: string }
): { option: TeamModelOption | undefined; substituted: boolean } {
  const want = spec.trim().toLowerCase()
  const exact =
    allowed.find((o) => o.key.toLowerCase() === want) ??
    allowed.find((o) => o.model.toLowerCase() === want) ??
    allowed.find((o) => o.name.toLowerCase() === want)
  if (exact) return { option: exact, substituted: false }
  const cur = current?.model ? allowed.find((o) => o.cli === current.cli && o.model === current.model) : undefined
  return { option: cur ?? cheapest(allowed), substituted: Boolean(want) }
}

/**
 * Turn the raw `assignments` array into safe, complete assignments: unknown models are replaced, hires respect the
 * team's limits, managers never get write access, and anything unusable is dropped with a note for the manager.
 */
export function normalizeAssignments(raw: unknown[], ctx: NormalizeCtx): { assignments: TeamAssignment[]; warnings: string[] } {
  const out: TeamAssignment[] = []
  const warnings: string[] = []
  const max = ctx.maxAssignments ?? 8
  let hiresLeft = ctx.hiresLeft

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    if (out.length >= max) {
      warnings.push(`Only the first ${max} assignments of a round are used; the rest were dropped.`)
      break
    }
    const o = item as Record<string, unknown>
    const to = str(o.to ?? o.role ?? o.id)
    const brief = str(o.brief ?? o.task ?? o.instructions)
    const idMatch = to.match(/^#?(\d+)$/)
    const givenTitle = str(o.title) || (to && !idMatch && !/^new$/i.test(to) ? to : '')
    const existing = idMatch ? ctx.reports.find((r) => r.id === Number(idMatch[1])) : givenTitle ? ctx.reports.find((r) => sameTitle(r.title, givenTitle)) : undefined

    if (idMatch && !existing && !str(o.title)) {
      warnings.push(`#${idMatch[1]} is not one of your direct reports, so that assignment was dropped.`)
      continue
    }

    if (existing?.kind === 'script') {
      out.push({ roleId: existing.id, title: existing.title, kind: 'script', job: existing.job, cli: '', model: '', effort: 'medium', access: 'write', brief })
      continue
    }
    if (!brief) {
      warnings.push(`The assignment for ${existing?.title ?? (givenTitle || 'a new role')} had no brief, so it was dropped.`)
      continue
    }

    const effortRaw = str(o.effort).toLowerCase() as EffortLevel
    const effort: EffortLevel = EFFORTS.includes(effortRaw) ? effortRaw : 'medium'
    const wantsWrite = /^(write|edit|rw)/i.test(str(o.access))

    if (existing) {
      const picked = existing.locked && existing.model ? pickModel(modelKey(existing.cli, existing.model), ctx.allowed) : pickModel(str(o.model), ctx.allowed, existing)
      if (picked.substituted && !existing.locked) warnings.push(`"${str(o.model)}" is not a model you may assign; ${existing.title} used ${picked.option?.key ?? 'no model'} instead.`)
      out.push({
        roleId: existing.id,
        title: existing.title,
        kind: existing.kind,
        job: existing.job,
        cli: picked.option?.cli ?? '',
        model: picked.option?.model ?? '',
        effort,
        access: existing.kind === 'manager' ? 'read' : wantsWrite ? 'write' : 'read',
        brief
      })
      continue
    }

    // A new hire
    if (!givenTitle) {
      warnings.push('A new hire needs a job title, so that assignment was dropped.')
      continue
    }
    const alreadyHired = out.find((a) => a.roleId === null && sameTitle(a.title, givenTitle))
    if (!alreadyHired) {
      if (!ctx.canHire) {
        warnings.push(`You cannot hire at this level, so the assignment for "${givenTitle}" was dropped.`)
        continue
      }
      if (hiresLeft <= 0) {
        warnings.push(`The team is at its size limit, so "${givenTitle}" was not hired and that assignment was dropped.`)
        continue
      }
      hiresLeft--
    }
    let kind: TeamRoleKind = /^manager$/i.test(str(o.kind)) ? 'manager' : 'worker'
    if (alreadyHired) kind = alreadyHired.kind
    else if (kind === 'manager' && !ctx.canHireManagers) {
      kind = 'worker'
      warnings.push(`"${givenTitle}" was hired as a worker: there is no level below it for a manager to lead.`)
    }
    const picked = pickModel(str(o.model), ctx.allowed)
    if (picked.substituted) warnings.push(`"${str(o.model)}" is not a model you may assign; ${givenTitle} used ${picked.option?.key ?? 'no model'} instead.`)
    out.push({
      roleId: null,
      title: givenTitle.slice(0, 80),
      kind,
      job: (alreadyHired?.job || str(o.job) || str(o.description)).slice(0, 400),
      cli: picked.option?.cli ?? '',
      model: picked.option?.model ?? '',
      effort,
      access: kind === 'manager' ? 'read' : wantsWrite ? 'write' : 'read',
      brief
    })
  }
  return { assignments: out, warnings }
}

/** Keep the first `maxWords` words (formatting intact) so a long report can't flood the manager's context. */
export function clipWords(text: string, maxWords: number): string {
  const re = /\S+/g
  let count = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (++count > maxWords) return `${text.slice(0, m.index).trimEnd()}\n…(report cut at ${maxWords} words)`
  }
  return text
}

export const fmtTokens = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)))

// ───────────────────────────── Prompts ─────────────────────────────

/** Allowed models as a price sheet, cheapest first, with cost relative to the most expensive one offered. */
export function priceSheet(allowed: TeamModelOption[]): string {
  if (!allowed.length) return '(no models are signed in right now)'
  const top = Math.max(...allowed.map((o) => o.weight))
  return [...allowed]
    .sort((a, b) => a.weight - b.weight)
    .map((o) => `- ${o.key} — cost ${(o.weight / top).toFixed(2)} — ${o.name} (${o.cliName})`)
    .join('\n')
}

const reportLine = (r: ReportRef): string =>
  r.kind === 'script'
    ? `- #${r.id} ${r.title} (script: runs \`${r.command}\` and reports its output; costs no tokens; assign it with just {"to":"#${r.id}"})${r.job ? ` — ${r.job}` : ''}`
    : `- #${r.id} ${r.title} (${r.kind})${r.job ? ` — ${r.job}` : ''}${r.model ? ` · last ran on ${modelKey(r.cli, r.model)}${r.locked ? ' (fixed by the user)' : ''}` : ''}`

/** Agents get no absolute path: a run may live in a worktree that does not exist yet when its first prompt is written. */
const WHERE = 'You are working in the project checkout, which is the current directory: refer to files by relative path.'

const PLAN_FORMAT = [
  'End your reply with one fenced json block and nothing after it:',
  '```json',
  '{"assignments":[{"to":"#<id of an existing report> or new","title":"job title (new hires only)","kind":"worker or manager (new hires only)","job":"one-line standing job description (new hires only)","model":"<a model key from the list>","effort":"low, medium or high","access":"read or write (workers only: write lets them edit files and run commands)","brief":"complete, self-contained instructions: the goal, where to look, what done looks like, what to report back"}]}',
  '```',
  'Assignments run one after another in the order you list them, in the same working folder, so a later one can build on an earlier one. A report knows only what its brief says.'
].join('\n')

export interface ManagerPlanCtx {
  title: string
  job: string
  /** null = reports to the user */
  parentTitle: string | null
  reports: ReportRef[]
  allowed: TeamModelOption[]
  hiresLeft: number
  canHire: boolean
  canHireManagers: boolean
  budgetPct: number
  kb: string
  brief: string
  reportWords: number
}

export function managerPlanPrompt(c: ManagerPlanCtx): string {
  const boss = c.parentTitle ?? 'the user'
  const hiring = !c.canHire
    ? 'You cannot hire: use your existing reports only.'
    : c.hiresLeft <= 0
      ? 'The team is at its size limit: use your existing reports only.'
      : `You may hire up to ${c.hiresLeft} more role(s)${c.canHireManagers ? ', managers included' : '; they must be workers (there is no level below them to manage)'}.`
  return [
    `You are the ${c.title} of an AI team run by the Omni CLI desktop app.${c.job ? `\nYour mission: ${c.job}` : ''}\nYou report to ${boss}. ${WHERE}`,
    [
      'HOW THE TEAM WORKS',
      '- You are a manager: you have read-only access and never do hands-on work. You split the assignment, delegate each part to a direct report, then review what comes back.',
      '- You brief only your direct reports, and only they report to you. Never address anyone further down.',
      '- Reuse an existing report when one fits. Hire a new role only when none does: hires are permanent and are reused on later tasks.',
      '- The team exists to save cost. Give every part to the cheapest model that can do it well, and keep expensive models for the genuinely hard parts. Routine work (searching, reading, boilerplate, tests, simple edits) never goes to an expensive model. A manager under you rarely needs the most expensive model either.',
      '- Use as few people as the assignment needs. If you can fully answer it yourself after a quick look (a question, a small lookup), do that and delegate nothing.',
      '- Look around only as much as you need to split the work well; your reports do the detailed reading.'
    ].join('\n'),
    `YOUR DIRECT REPORTS\n${c.reports.length ? c.reports.map(reportLine).join('\n') : '(none yet)'}`,
    `MODELS YOU MAY ASSIGN (relative cost per token, cheapest first)\n${priceSheet(c.allowed)}`,
    `LIMITS\n- ${hiring}\n- Run budget used so far: ${Math.round(c.budgetPct)}%.`,
    c.kb,
    `YOUR ASSIGNMENT (from ${boss})\n${c.brief}`,
    `HOW TO ANSWER\n${PLAN_FORMAT}\nIf nothing needs delegating, answer with {"assignments":[],"report":"<your full answer, at most about ${c.reportWords} words>"} instead.`
  ]
    .filter(Boolean)
    .join('\n\n')
}

export interface ReviewResult {
  roleId: number
  title: string
  state: 'done' | 'failed' | 'skipped'
  model: string
  tokens: number
  report: string
  error: string
}

export interface ManagerReviewCtx {
  title: string
  parentTitle: string | null
  briefRecap: string
  round: number
  results: ReviewResult[]
  notes: string[]
  budgetPct: number
  roundsLeft: number
  /** No rounds or budget left: the manager must report now */
  final: boolean
  reportWords: number
}

export function managerReviewPrompt(c: ManagerReviewCtx): string {
  const boss = c.parentTitle ?? 'the user'
  const results = c.results.length
    ? c.results
        .map((r) => {
          const head = `### #${r.roleId} ${r.title} — ${r.state === 'done' ? 'done' : r.state === 'failed' ? 'FAILED' : 'not started (run budget spent)'}${r.model ? ` (${r.model}, ${fmtTokens(r.tokens)} tokens)` : ''}`
          const body = [r.state === 'failed' && r.error ? `Error: ${r.error}` : '', clipWords(r.report, c.reportWords)].filter(Boolean).join('\n')
          return `${head}\n${body || '(no report)'}`
        })
        .join('\n\n')
    : '(nothing was delegated: the run budget was already spent)'
  const next = c.final
    ? 'You have no delegation rounds or budget left, so finish now: write your report.'
    : [
        'Now do ONE of these:',
        `(a) Finish: write your report for ${boss}.`,
        `(b) Delegate one more round, only if something essential is missing, failed or wrong (${c.roundsLeft} round(s) left): end with a json block in the same format as before. When work failed or was poor, move it one step up in model cost, not straight to the most expensive model.`
      ].join('\n')
  return [
    `Your team has reported back on round ${c.round}. Assignment recap: ${c.briefRecap}`,
    results,
    c.notes.length ? `NOTES FROM THE APP\n${c.notes.map((n) => `- ${n}`).join('\n')}` : '',
    `Run budget used so far: ${Math.round(c.budgetPct)}%.`,
    next,
    `Your report goes to ${boss}: what was done, how it was checked, and what is still open. Plain markdown, at most about ${c.reportWords} words, no json.`
  ]
    .filter(Boolean)
    .join('\n\n')
}

export interface WorkerCtx {
  title: string
  job: string
  /** null = the user gave this role the task directly */
  managerTitle: string | null
  access: 'read' | 'write'
  kb: string
  brief: string
  reportWords: number
}

export function workerPrompt(c: WorkerCtx): string {
  const boss = c.managerTitle ?? 'the user'
  return [
    `You are the ${c.title} on an AI team run by the Omni CLI desktop app.${c.job ? ` Your job: ${c.job}` : ''}\nYou report to ${boss}. ${WHERE}`,
    [
      c.access === 'write' ? 'You may edit files and run the commands your assignment needs.' : 'You have read-only access: inspect and report, and do not change anything.',
      'Do exactly what the assignment asks and nothing more. Work on your own: do not start sub-agents or hand work to anyone.'
    ].join('\n'),
    c.kb,
    `YOUR ASSIGNMENT (from ${boss})\n${c.brief}`,
    `WHEN YOU ARE DONE\nFinish with a report for ${boss} of at most about ${c.reportWords} words: what you did or found, the files you changed, how you checked it, and anything unresolved. Do not paste whole files.`
  ]
    .filter(Boolean)
    .join('\n\n')
}
