import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Crown,
  FileSearch,
  GitBranch,
  Loader2,
  Lock,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Settings2,
  Square,
  Terminal,
  Trash2,
  User,
  UserPlus,
  Users,
  X
} from 'lucide-react'
import type {
  CheckoutMode,
  CliId,
  EffortLevel,
  PermissionMode,
  Project,
  Team,
  TeamAssignment,
  TeamModelOption,
  TeamRole,
  TeamRoleKind,
  TeamRun,
  TeamStep
} from '@shared/types'
import { act, api, useData } from '../lib/api'
import { relative } from '../lib/dates'
import { Markdown } from '../lib/markdown'
import { CliAvatar } from './CliAvatars'
import { confirmAction, cx, Empty, Field, Modal } from './ui'
import { ApprovalCards } from './Workbench'

const fmtTokens = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)))
const keyOf = (cli: string, model: string): string => `${cli}:${model}`
const splitKey = (key: string): { cli: CliId; model: string } => {
  const i = key.indexOf(':')
  return { cli: key.slice(0, i) as CliId, model: key.slice(i + 1) }
}
const EFFORTS: EffortLevel[] = ['low', 'medium', 'high']
const TEAM_KEY = 'omni.teams.selected'

const allowedKeysOf = (team: Team): string[] => {
  try {
    const v = JSON.parse(team.allowed_models || '[]') as unknown
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : []
  } catch {
    return []
  }
}

/** Models grouped by subscription. Signed-out or limited subscriptions stay visible but greyed out. */
function ModelSelect({
  options,
  value,
  onChange,
  emptyLabel
}: {
  options: TeamModelOption[]
  value: string
  onChange: (key: string) => void
  emptyLabel?: string
}): React.JSX.Element {
  const groups = [...new Set(options.map((o) => o.cli))].map((cli) => options.filter((o) => o.cli === cli))
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      {emptyLabel && <option value="">{emptyLabel}</option>}
      {groups.map((g) => (
        <optgroup key={g[0].cli} label={`${g[0].cliName}${g[0].ready ? '' : ' (unavailable right now)'}`}>
          {g.map((o) => (
            <option key={o.key} value={o.key} disabled={!o.ready}>
              {o.name} · cost {o.weight.toFixed(1)}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

// ───────────────────────────── Team settings ─────────────────────────────

function TeamModal({
  team,
  catalog,
  onClose,
  onSaved,
  onDeleted
}: {
  team: Team | null
  catalog: TeamModelOption[]
  onClose: () => void
  onSaved: (t: Team) => void
  onDeleted: () => void
}): React.JSX.Element {
  const top = team?.roles?.find((r) => r.parent_id === null)
  const defaultTop = catalog.find((o) => o.ready && o.cli === 'claude' && /opus/i.test(o.model)) ?? catalog.find((o) => o.ready) ?? catalog[0]
  const [f, setF] = useState({
    name: team?.name ?? '',
    title: top?.title ?? '',
    job: top?.job ?? '',
    key: top ? keyOf(top.cli, top.model) : (defaultTop?.key ?? ''),
    effort: (top?.effort ?? 'medium') as EffortLevel,
    maxRoles: team?.max_roles ?? 12,
    maxDepth: team?.max_depth ?? 3,
    maxRounds: team?.max_rounds ?? 2,
    budgetK: Math.round((team?.token_budget ?? 1_500_000) / 1000),
    words: team?.report_words ?? 250,
    lean: team ? Boolean(team.lean) : true,
    approve: team ? Boolean(team.approve_hires) : false
  })
  const [allowed, setAllowed] = useState<Set<string>>(() => {
    const saved = team ? allowedKeysOf(team) : []
    return new Set(saved.length ? saved : catalog.map((o) => o.key))
  })
  const toggle = (key: string): void =>
    setAllowed((cur) => {
      const next = new Set(cur)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const save = (): void => {
    if (!f.key) return
    const { cli, model } = splitKey(f.key)
    const everything = catalog.every((o) => allowed.has(o.key))
    act(
      api.teams.save({
        id: team?.id,
        name: f.name,
        allowed_models: everything ? [] : catalog.filter((o) => allowed.has(o.key)).map((o) => o.key),
        max_roles: f.maxRoles,
        max_depth: f.maxDepth,
        max_rounds: f.maxRounds,
        token_budget: f.budgetK * 1000,
        report_words: f.words,
        lean: f.lean ? 1 : 0,
        approve_hires: f.approve ? 1 : 0,
        top: { title: f.title, job: f.job, cli, model, effort: f.effort }
      }),
      team ? 'Team saved' : 'Team created'
    ).then((saved) => saved && onSaved(saved))
  }

  const num = (label: string, value: number, set: (n: number) => void, hint: string, min = 0): React.JSX.Element => (
    <Field label={label} hint={hint}>
      <input className="input" type="number" min={min} value={value} onChange={(e) => set(Number(e.target.value))} />
    </Field>
  )

  return (
    <Modal
      title={team ? `${team.name} settings` : 'New team'}
      width="max-w-2xl"
      onClose={onClose}
      footer={
        <>
          {team && (
            <button
              type="button"
              className="btn btn-ghost btn-danger"
              onClick={() =>
                confirmAction(`Delete the team "${team.name}", its org chart and all of its runs? Unmerged branches from its runs are discarded.`) &&
                act(api.teams.delete(team.id), 'Team deleted').then((ok) => ok && onDeleted())
              }
            >
              <Trash2 size={13} /> Delete team
            </button>
          )}
          <span className="flex-1" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={save}>
            {team ? 'Save' : 'Create team'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Team name">
          <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Engineering" />
        </Field>

        <div className="space-y-3 rounded-xl border border-white/[0.08] bg-white/[0.025] p-3.5">
          <div className="eyebrow flex items-center gap-1.5">
            <Crown size={12} className="text-amber-300" /> The top role
          </div>
          <p className="muted text-[12px]">You set up only this role. It hires the people it needs the first time it needs them, and the team is kept for later tasks.</p>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="Job title">
              <input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="CTO" />
            </Field>
            <Field label="Model">
              <ModelSelect options={catalog} value={f.key} onChange={(key) => setF({ ...f, key })} />
            </Field>
          </div>
          <Field label="Mission" hint="What this role is responsible for. It never does hands-on work; it delegates and reviews.">
            <textarea className="input min-h-[64px]" value={f.job} onChange={(e) => setF({ ...f, job: e.target.value })} placeholder="Owns all engineering for this app: plans the work, staffs it and reviews the result." />
          </Field>
          <Field label="Effort" className="w-40">
            <select className="input" value={f.effort} onChange={(e) => setF({ ...f, effort: e.target.value as EffortLevel })}>
              {EFFORTS.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div>
          <span className="label">Models managers may give to their reports</span>
          <p className="muted mb-2 text-[12px]">
            Managers pick the cheapest model that fits each assignment. The cost figure is an estimate per token, with the most expensive tier at 1.0. Fable is never offered.
          </p>
          <div className="grid grid-cols-2 gap-1.5">
            {catalog.map((o) => (
              <label key={o.key} className={cx('flex cursor-pointer items-center gap-2 rounded-lg border border-white/[0.07] bg-white/[0.03] px-2.5 py-1.5 text-[12.5px]', !o.ready && 'opacity-45')}>
                <input type="checkbox" checked={allowed.has(o.key)} onChange={() => toggle(o.key)} />
                <CliAvatar cli={o.cli} size={13} />
                <span className="min-w-0 flex-1 truncate">{o.name}</span>
                <span className="muted font-mono text-[11px]">{o.weight.toFixed(1)}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2.5">
          {num('Team size limit', f.maxRoles, (n) => setF({ ...f, maxRoles: n }), 'Most roles, top role included', 1)}
          {num('Levels', f.maxDepth, (n) => setF({ ...f, maxDepth: n }), 'Each level adds two manager turns', 2)}
          {num('Follow-up rounds', f.maxRounds, (n) => setF({ ...f, maxRounds: n }), 'Rework rounds per manager')}
          {num('Run budget (k tokens)', f.budgetK, (n) => setF({ ...f, budgetK: n }), 'Cost-weighted; the run wraps up when spent', 50)}
          {num('Report length (words)', f.words, (n) => setF({ ...f, words: n }), 'Cap on what each role sends up', 60)}
        </div>

        <div className="space-y-1.5 text-[12.5px]">
          <label className="flex cursor-pointer items-start gap-2">
            <input type="checkbox" className="mt-0.5" checked={f.lean} onChange={(e) => setF({ ...f, lean: e.target.checked })} />
            <span>
              Lean agents <span className="muted">(Claude Code agents start without MCP servers and skills, which makes every agent cheaper to start. Turn off if your roles need those tools.)</span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2">
            <input type="checkbox" className="mt-0.5" checked={f.approve} onChange={(e) => setF({ ...f, approve: e.target.checked })} />
            <span>
              Ask me before a manager hires <span className="muted">(the run waits for your answer)</span>
            </span>
          </label>
        </div>
      </div>
    </Modal>
  )
}

// ───────────────────────────── Roles ─────────────────────────────

function RoleModal({
  role,
  team,
  catalog,
  onClose
}: {
  role: Partial<TeamRole> & { team_id: number }
  team: Team
  catalog: TeamModelOption[]
  onClose: () => void
}): React.JSX.Element {
  const roles = team.roles ?? []
  const [f, setF] = useState({
    title: role.title ?? '',
    job: role.job ?? '',
    kind: (role.kind ?? 'worker') as TeamRoleKind,
    parent: role.parent_id ?? roles.find((r) => r.parent_id === null)?.id ?? 0,
    key: role.model ? keyOf(role.cli ?? '', role.model) : '',
    effort: (role.effort ?? 'medium') as EffortLevel,
    command: role.command ?? '',
    locked: Boolean(role.locked)
  })
  // A role cannot report to itself, to anyone below it, or to a script
  const below = new Set<number>()
  const collect = (id: number): void => {
    below.add(id)
    roles.filter((r) => r.parent_id === id).forEach((r) => collect(r.id))
  }
  if (role.id) collect(role.id)
  const bosses = roles.filter((r) => r.kind !== 'script' && !below.has(r.id))
  const hasReports = Boolean(role.id) && roles.some((r) => r.parent_id === role.id)

  const save = (): void => {
    const picked = f.key ? splitKey(f.key) : { cli: '' as const, model: '' }
    act(
      api.teams.saveRole({
        id: role.id,
        team_id: team.id,
        title: f.title,
        job: f.job,
        kind: f.kind,
        parent_id: f.parent,
        cli: picked.cli,
        model: picked.model,
        effort: f.effort,
        command: f.command,
        locked: f.locked && f.key ? 1 : 0
      }),
      role.id ? 'Role saved' : 'Role added'
    ).then((ok) => ok && onClose())
  }

  return (
    <Modal
      title={role.id ? `Edit ${role.title}` : 'Add a role'}
      onClose={onClose}
      footer={
        <>
          <span className="flex-1" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2.5">
          <Field label="Job title">
            <input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Backend Developer" />
          </Field>
          <Field label="Reports to">
            <select className="input" value={f.parent} onChange={(e) => setF({ ...f, parent: Number(e.target.value) })}>
              {bosses.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Type" hint={hasReports ? 'This role has people reporting to it, so it stays a manager.' : undefined}>
          <select className="input" value={f.kind} disabled={hasReports} onChange={(e) => setF({ ...f, kind: e.target.value as TeamRoleKind })}>
            <option value="worker">Worker: does the hands-on work</option>
            <option value="manager">Manager: delegates and reviews, never edits</option>
            <option value="script">Script: runs one command, uses no tokens</option>
          </select>
        </Field>
        <Field label={f.kind === 'script' ? 'What the script is for' : 'Job description'}>
          <textarea className="input min-h-[60px]" value={f.job} onChange={(e) => setF({ ...f, job: e.target.value })} placeholder={f.kind === 'script' ? 'Runs the test suite and reports failures' : 'Implements and fixes server-side code'} />
        </Field>
        {f.kind === 'script' ? (
          <Field label="Command" hint="Runs in the run's working folder. A manager can only trigger it, never change it.">
            <input className="input font-mono" value={f.command} onChange={(e) => setF({ ...f, command: e.target.value })} placeholder="npm run check" />
          </Field>
        ) : (
          <>
            <div className="grid grid-cols-[1fr_140px] gap-2.5">
              <Field label="Model">
                <ModelSelect options={catalog} value={f.key} onChange={(key) => setF({ ...f, key })} emptyLabel="Let its manager choose per assignment" />
              </Field>
              <Field label="Effort">
                <select className="input" value={f.effort} onChange={(e) => setF({ ...f, effort: e.target.value as EffortLevel })}>
                  {EFFORTS.map((e) => (
                    <option key={e} value={e}>
                      {e}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {f.key && (
              <label className="flex cursor-pointer items-center gap-2 text-[12.5px]">
                <input type="checkbox" checked={f.locked} onChange={(e) => setF({ ...f, locked: e.target.checked })} />
                Lock this model <span className="muted">(managers cannot change it)</span>
              </label>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

const kindIcon = (role: TeamRole): React.JSX.Element =>
  role.parent_id === null ? (
    <Crown size={14} className="shrink-0 text-amber-300" />
  ) : role.kind === 'manager' ? (
    <Users size={14} className="shrink-0 text-indigo-300" />
  ) : role.kind === 'script' ? (
    <Terminal size={14} className="shrink-0 text-emerald-300" />
  ) : (
    <User size={14} className="shrink-0 text-zinc-400" />
  )

function OrgNode({
  role,
  roles,
  depth,
  catalog,
  onEdit,
  onAdd
}: {
  role: TeamRole
  roles: TeamRole[]
  depth: number
  catalog: TeamModelOption[]
  onEdit: (r: TeamRole) => void
  onAdd: (parent: TeamRole) => void
}): React.JSX.Element {
  const kids = roles.filter((r) => r.parent_id === role.id)
  const model = role.model ? (catalog.find((o) => o.key === keyOf(role.cli, role.model))?.name ?? role.model) : ''
  return (
    <div>
      <div className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-white/[0.04]" style={{ marginLeft: depth * 22 }}>
        {depth > 0 && <CornerDownRight size={12} className="shrink-0 text-zinc-600" />}
        {kindIcon(role)}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-[13px] font-medium text-zinc-100">{role.title}</span>
            {role.kind === 'script' ? (
              <span className="rounded bg-emerald-500/12 px-1.5 py-px font-mono text-[10.5px] text-emerald-300">{role.command}</span>
            ) : model ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-white/[0.09] bg-white/[0.04] px-1.5 py-px text-[10.5px] text-zinc-300">
                {role.cli && <CliAvatar cli={role.cli} size={10} />}
                {model}
                {!!role.locked && role.parent_id !== null && <Lock size={9} className="text-amber-300" />}
              </span>
            ) : (
              <span className="muted text-[10.5px]">model chosen per assignment</span>
            )}
            {role.hired_by === 'manager' && <span className="rounded bg-indigo-500/15 px-1.5 py-px text-[10px] text-indigo-300">hired by its manager</span>}
          </div>
          {role.job && <div className="muted truncate text-[11.5px]">{role.job}</div>}
        </div>
        <div className="invisible flex items-center gap-0.5 group-hover:visible">
          {role.kind !== 'script' && (
            <button type="button" className="btn btn-ghost btn-icon h-6 w-6" title={`Add a role under ${role.title}`} onClick={() => onAdd(role)}>
              <UserPlus size={12} />
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-icon h-6 w-6" title="Edit" onClick={() => onEdit(role)}>
            <Pencil size={11} />
          </button>
          {role.parent_id !== null && (
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-danger h-6 w-6"
              title="Remove"
              onClick={() =>
                confirmAction(kids.length ? `Remove ${role.title} and everyone reporting to it?` : `Remove ${role.title} from the team?`) && act(api.teams.deleteRole(role.id), 'Role removed')
              }
            >
              <Trash2 size={11} />
            </button>
          )}
        </div>
      </div>
      {kids.map((k) => (
        <OrgNode key={k.id} role={k} roles={roles} depth={depth + 1} catalog={catalog} onEdit={onEdit} onAdd={onAdd} />
      ))}
    </div>
  )
}

// ───────────────────────────── Runs ─────────────────────────────

const STEP_LABEL: Record<TeamStep['state'], string> = {
  pending: 'Waiting its turn',
  planning: 'Planning',
  approval: 'Needs your approval',
  waiting: 'Waiting for its team',
  reviewing: 'Reviewing',
  working: 'Working',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Skipped: budget spent'
}

function StepIcon({ state }: { state: TeamStep['state'] }): React.JSX.Element {
  if (state === 'planning' || state === 'reviewing' || state === 'working') return <Loader2 size={13} className="shrink-0 animate-spin text-indigo-300" />
  if (state === 'done') return <Check size={13} className="shrink-0 text-emerald-400" />
  if (state === 'failed') return <X size={13} className="shrink-0 text-red-400" />
  if (state === 'approval') return <AlertTriangle size={13} className="shrink-0 text-amber-300" />
  return <span className="mx-[3px] size-[7px] shrink-0 rounded-full bg-zinc-600" />
}

function HireApproval({ step }: { step: TeamStep }): React.JSX.Element {
  let hires: TeamAssignment[] = []
  try {
    const parsed = JSON.parse(step.plan_json || '{}') as { assignments?: TeamAssignment[] }
    const seen = new Set<string>()
    hires = (parsed.assignments ?? []).filter((a) => a.roleId === null && !seen.has(a.title.toLowerCase()) && seen.add(a.title.toLowerCase()))
  } catch {
    // unreadable plan: the buttons still let the run continue
  }
  return (
    <div className="card pop-in mt-2 border-amber-400/35 bg-amber-500/[0.07] p-3">
      <div className="flex items-center gap-2 text-[12.5px] font-semibold text-amber-200">
        <UserPlus size={13} /> {step.role_title} wants to hire
      </div>
      <ul className="mt-1.5 space-y-1 text-[12.5px]">
        {hires.map((h) => (
          <li key={h.title}>
            <span className="font-medium text-zinc-100">{h.title}</span> <span className="muted">({h.kind}, {h.model || 'no model'})</span>
            {h.job && <span className="muted"> — {h.job}</span>}
          </li>
        ))}
      </ul>
      <div className="mt-2.5 flex gap-2">
        <button type="button" className="btn btn-primary h-7 px-3 text-[12px]" onClick={() => act(api.teams.decideHires(step.id, true), 'Hired')}>
          Approve
        </button>
        <button type="button" className="btn h-7 px-3 text-[12px]" onClick={() => act(api.teams.decideHires(step.id, false), 'Declined')}>
          Decline
        </button>
      </div>
    </div>
  )
}

function StepNode({ step, steps, depth, onOpenTask }: { step: TeamStep; steps: TeamStep[]; depth: number; onOpenTask: (taskId: number) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const kids = steps.filter((s) => s.parent_step_id === step.id)
  const active = step.state === 'planning' || step.state === 'reviewing' || step.state === 'working'
  const body = step.report || step.error
  return (
    <div style={{ marginLeft: depth ? 18 : 0 }} className={cx(depth > 0 && 'border-l border-white/[0.07] pl-3')}>
      <div className="py-1.5">
        <div className="flex items-center gap-2">
          <StepIcon state={step.state} />
          <button type="button" className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left" onClick={() => setOpen(!open)}>
            <span className="truncate text-[13px] font-medium text-zinc-100">{step.role_title ?? 'Removed role'}</span>
            <span className={cx('shrink-0 text-[11px]', step.state === 'failed' ? 'text-red-300' : step.state === 'approval' ? 'text-amber-300' : 'muted')}>{STEP_LABEL[step.state]}</span>
            {step.round > 1 && <span className="shrink-0 rounded bg-white/[0.07] px-1.5 py-px text-[10px] text-zinc-400">round {step.round}</span>}
            {(body || step.brief) && (open ? <ChevronDown size={12} className="shrink-0 text-zinc-500" /> : <ChevronRight size={12} className="shrink-0 text-zinc-500" />)}
          </button>
          {step.role_kind === 'script' ? (
            <span className="muted shrink-0 text-[11px]">script · 0 tokens</span>
          ) : (
            <span className="muted flex shrink-0 items-center gap-1.5 font-mono text-[11px]">
              {step.cli && <CliAvatar cli={step.cli} size={11} />}
              {step.model} · {fmtTokens(step.tokens)}
            </span>
          )}
          {step.task_id && (
            <button type="button" className="btn btn-ghost btn-icon h-6 w-6 shrink-0" title="Open this agent's live log and changes" onClick={() => onOpenTask(step.task_id!)}>
              <FileSearch size={12} />
            </button>
          )}
        </div>
        {step.state === 'approval' && <HireApproval step={step} />}
        {active && step.task_id && (
          <div className="mt-2">
            <ApprovalCards taskId={step.task_id} />
          </div>
        )}
        {open && (
          <div className="mt-1.5 space-y-2 pl-[21px]">
            {step.brief && (
              <div className="rounded-lg border border-white/[0.06] bg-black/20 px-3 py-2">
                <div className="eyebrow mb-1">Assignment</div>
                <div className="selectable text-[12.5px] whitespace-pre-wrap text-zinc-300">{step.brief}</div>
              </div>
            )}
            {step.error && <div className="selectable rounded-lg border border-red-500/25 bg-red-500/[0.07] px-3 py-2 text-[12.5px] text-red-200">{step.error}</div>}
            {step.report && (
              <div className="rounded-lg border border-white/[0.06] bg-white/[0.025] px-3 py-2">
                <div className="eyebrow mb-1">Report</div>
                <div className="selectable text-[12.5px]">
                  <Markdown text={step.report} />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      {kids.map((k) => (
        <StepNode key={k.id} step={k} steps={steps} depth={depth + 1} onOpenTask={onOpenTask} />
      ))}
    </div>
  )
}

const RUN_PILL: Record<TeamRun['state'], string> = {
  running: 'bg-indigo-500/20 text-indigo-300',
  done: 'bg-emerald-500/15 text-emerald-300',
  failed: 'bg-red-500/15 text-red-300',
  stopped: 'bg-amber-500/15 text-amber-300'
}

function RunCard({
  run,
  open,
  onToggle,
  onFollowUp,
  onOpenTask
}: {
  run: TeamRun
  open: boolean
  onToggle: () => void
  onFollowUp: () => void
  onOpenTask: (taskId: number) => void
}): React.JSX.Element {
  const { data } = useData(() => (open ? api.teams.run(run.id) : Promise.resolve(null)), [run.id, open], { throttleMs: 700 })
  const steps = data?.steps ?? []
  const root = steps.find((s) => s.parent_step_id === null)
  const tokens = run.tokens ?? 0
  const weighted = run.weighted ?? 0
  const onTop = run.weighted_top ?? 0
  const saving = onTop > 0 ? Math.round((1 - weighted / onTop) * 100) : 0

  return (
    <div className={cx('card overflow-hidden', run.state === 'running' && 'border-indigo-400/30')}>
      <div className="flex items-start gap-3 px-4 py-3">
        <button type="button" className="mt-0.5 cursor-pointer text-zinc-500 hover:text-zinc-200" onClick={onToggle} title={open ? 'Collapse' : 'Show the steps'}>
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
        <button type="button" className="min-w-0 flex-1 cursor-pointer text-left" onClick={onToggle}>
          <div className="flex flex-wrap items-center gap-2">
            <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium', RUN_PILL[run.state])}>
              {run.state === 'running' && <Loader2 size={10} className="animate-spin" />}
              {run.state === 'running' ? 'Working' : run.state === 'done' ? 'Finished' : run.state === 'failed' ? 'Failed' : 'Stopped'}
            </span>
            <span className="muted text-[11.5px]">
              to {run.role_title} · {relative(run.created_at)}
              {run.continues_run_id ? ' · follow-up' : ''}
            </span>
            {run.branch && (
              <span className="flex items-center gap-1 font-mono text-[11px] text-zinc-400">
                <GitBranch size={10} className="text-emerald-400" /> {run.branch}
              </span>
            )}
          </div>
          <div className="mt-1 line-clamp-2 text-[13px] text-zinc-100">{run.prompt}</div>
          <div className="muted mt-1 text-[11.5px]">
            {run.steps_done}/{run.steps_total} steps · {fmtTokens(tokens)} tokens
            {tokens > 0 && (
              <span title="Tokens weighted by each model's estimated cost, next to the same tokens weighted as if the top role's model had done everything. An estimate, not a bill.">
                {' '}
                · cost-weighted {fmtTokens(weighted)}
                {saving > 0 && (
                  <>
                    {' '}
                    vs {fmtTokens(onTop)} all on {run.top_model} <span className="text-emerald-300">({saving}% less)</span>
                  </>
                )}
              </span>
            )}
          </div>
          {run.error && run.state !== 'done' && <div className="mt-1 text-[12px] text-red-300">{run.error}</div>}
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {run.state === 'running' && (
            <button type="button" className="btn h-7 px-2.5 text-[11.5px]" onClick={() => act(api.teams.stopRun(run.id), 'Run stopped')}>
              <Square size={11} /> Stop
            </button>
          )}
          {(run.state === 'failed' || run.state === 'stopped') && (
            <button type="button" className="btn h-7 px-2.5 text-[11.5px]" title="Retry what broke and keep the finished work" onClick={() => act(api.teams.resumeRun(run.id), 'Run resumed')}>
              <RotateCcw size={11} /> Resume
            </button>
          )}
          {run.state !== 'running' && (
            <button type="button" className="btn h-7 px-2.5 text-[11.5px]" title="Give the same role another instruction on the same branch" onClick={onFollowUp}>
              <CornerDownRight size={11} /> Follow up
            </button>
          )}
          {run.root_task_id && (
            <button type="button" className="btn h-7 px-2.5 text-[11.5px]" title="Review the changes, run checks and merge the branch" onClick={() => onOpenTask(run.root_task_id!)}>
              <FileSearch size={11} /> Changes
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-danger h-7 w-7"
            title="Delete run"
            onClick={() => confirmAction(run.branch ? `Delete this run? Its branch ${run.branch} and any unmerged changes are discarded.` : 'Delete this run and its agent logs?') && act(api.teams.deleteRun(run.id), 'Run deleted')}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      {open && (
        <div className="border-t border-white/[0.06] px-4 py-3">
          {run.result && (
            <div className="mb-3 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.05] px-3 py-2.5">
              <div className="eyebrow mb-1 text-emerald-300">Report from {run.role_title}</div>
              <div className="selectable text-[13px]">
                <Markdown text={run.result} />
              </div>
            </div>
          )}
          {root ? <StepNode step={root} steps={steps} depth={0} onOpenTask={onOpenTask} /> : <div className="muted text-[12.5px]">Loading steps…</div>}
        </div>
      )}
    </div>
  )
}

// ───────────────────────────── View ─────────────────────────────

/** Teams tab: build an org chart from one top role, hand it tasks, and watch what each role did and what it cost. */
export function TeamsView({ project, onOpenTask }: { project: Project; onOpenTask: (taskId: number) => void }): React.JSX.Element {
  const { data: teams } = useData(() => api.teams.list())
  const { data: catalog } = useData(() => api.teams.modelCatalog(), [], { throttleMs: 15_000 })
  const [selectedId, setSelectedId] = useState<number | null>(() => Number(localStorage.getItem(TEAM_KEY)) || null)
  const team = teams?.find((t) => t.id === selectedId) ?? teams?.[0] ?? null
  const roles = team?.roles ?? []
  const top = roles.find((r) => r.parent_id === null)

  const { data: runs } = useData(() => (team ? api.teams.runs(project.id, team.id) : Promise.resolve([])), [project.id, team?.id], { throttleMs: 1200 })

  const [editingTeam, setEditingTeam] = useState<Team | 'new' | null>(null)
  const [editingRole, setEditingRole] = useState<(Partial<TeamRole> & { team_id: number }) | null>(null)
  const [prompt, setPrompt] = useState('')
  const [roleId, setRoleId] = useState<number | null>(null)
  const [perm, setPerm] = useState<PermissionMode>('accept-edits')
  const [checkout, setCheckout] = useState<CheckoutMode>('worktree')
  const [followUp, setFollowUp] = useState<TeamRun | null>(null)
  const [openRun, setOpenRun] = useState<number | null>(null)
  const [sending, setSending] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (team) localStorage.setItem(TEAM_KEY, String(team.id))
    setFollowUp(null)
    setRoleId(null)
  }, [team?.id])

  const target = followUp ? roles.find((r) => r.id === followUp.role_id) : (roles.find((r) => r.id === roleId) ?? top)

  const start = async (): Promise<void> => {
    if (!team || !prompt.trim() || sending) return
    setSending(true)
    const created = await act(
      api.teams.startRun({
        teamId: team.id,
        projectId: project.id,
        prompt,
        roleId: target?.id,
        permissionMode: perm,
        checkoutMode: checkout,
        continuesRunId: followUp?.id
      }),
      `Handed to ${target?.title ?? 'the team'}`
    )
    setSending(false)
    if (created) {
      setPrompt('')
      setFollowUp(null)
      setOpenRun(created.id)
    }
  }

  if (teams === undefined) return <div className="muted py-10 text-center text-[13px]">Loading teams…</div>

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-1 flex items-center gap-2 text-[15px] font-semibold text-white">
          <Users size={16} className="text-indigo-300" /> Teams
        </h2>
        {teams.map((t) => (
          <button key={t.id} type="button" className={cx('chip', t.id === team?.id && 'chip-active')} onClick={() => setSelectedId(t.id)}>
            {t.name}
            <span className="muted text-[10.5px]">{t.roles?.length ?? 0}</span>
          </button>
        ))}
        <span className="flex-1" />
        <button type="button" className="btn h-7 px-2.5 text-[11.5px]" disabled={!catalog} onClick={() => setEditingTeam('new')}>
          <Plus size={12} /> New team
        </button>
      </div>

      {!team ? (
        <div className="card">
          <Empty
            icon={<Users size={30} />}
            title="No teams yet"
            hint="Create one role, such as a CTO or a Marketing Director. It hires the people it needs, gives routine work to cheaper models and keeps the expensive model for the hard parts."
            action={
              <button type="button" className="btn btn-primary" disabled={!catalog} onClick={() => setEditingTeam('new')}>
                <Plus size={13} /> Create a team
              </button>
            }
          />
        </div>
      ) : (
        <>
          {/* Org chart */}
          <section className="card p-3">
            <div className="mb-1 flex items-center justify-between px-2">
              <div className="eyebrow">
                Org chart · {roles.length} of {team.max_roles} roles
              </div>
              <div className="flex items-center gap-1">
                {top && (
                  <button type="button" className="btn btn-ghost h-7 px-2 text-[11.5px]" onClick={() => setEditingRole({ team_id: team.id, parent_id: top.id, kind: 'worker' })}>
                    <UserPlus size={12} /> Add role
                  </button>
                )}
                <button type="button" className="btn btn-ghost h-7 px-2 text-[11.5px]" disabled={!catalog} onClick={() => setEditingTeam(team)}>
                  <Settings2 size={12} /> Settings
                </button>
              </div>
            </div>
            {top && (
              <OrgNode
                role={top}
                roles={roles}
                depth={0}
                catalog={catalog ?? []}
                onEdit={(r) => (r.parent_id === null ? setEditingTeam(team) : setEditingRole(r))}
                onAdd={(parent) => setEditingRole({ team_id: team.id, parent_id: parent.id, kind: 'worker' })}
              />
            )}
            {roles.length === 1 && <p className="muted px-2 pt-1 text-[11.5px]">Only the top role exists so far. It will hire as soon as a task needs someone, or you can add roles yourself.</p>}
          </section>

          {/* Hand over a task */}
          <section className="composer-box rounded-2xl p-3">
            {followUp && (
              <div className="mb-2 flex items-center gap-2 rounded-lg bg-indigo-500/12 px-2.5 py-1.5 text-[12px] text-indigo-200">
                <CornerDownRight size={12} />
                <span className="min-w-0 flex-1 truncate">Following up on: {followUp.prompt}</span>
                <button type="button" className="cursor-pointer text-indigo-300 hover:text-white" onClick={() => setFollowUp(null)} title="Start a separate run instead">
                  <X size={12} />
                </button>
              </div>
            )}
            <textarea
              ref={inputRef}
              className="selectable min-h-[76px] w-full resize-y bg-transparent px-1 text-[13.5px] leading-relaxed text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
              placeholder={`What should ${target?.title ?? 'the team'} get done in ${project.name}?`}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  void start()
                }
              }}
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <select
                className="input h-8 w-auto text-[12px]"
                value={target?.id ?? ''}
                disabled={Boolean(followUp)}
                onChange={(e) => setRoleId(Number(e.target.value))}
                title="Small jobs can go straight to the person who does them; that skips the manager turns above"
              >
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    Give to {r.title}
                  </option>
                ))}
              </select>
              {!followUp && (
                <>
                  <select className="input h-8 w-auto text-[12px]" value={perm} onChange={(e) => setPerm(e.target.value as PermissionMode)} title="What workers with write access may do without asking you">
                    <option value="accept-edits">Edits allowed, commands ask</option>
                    <option value="bypass">Full auto (never asks)</option>
                    <option value="default">Ask before every edit</option>
                  </select>
                  <select className="input h-8 w-auto text-[12px]" value={checkout} onChange={(e) => setCheckout(e.target.value as CheckoutMode)}>
                    <option value="worktree">On its own branch</option>
                    <option value="local">Directly in the project folder</option>
                  </select>
                </>
              )}
              <span className="flex-1" />
              <span className="muted text-[11px]">Ctrl+Enter</span>
              <button type="button" className="btn btn-primary" disabled={!prompt.trim() || sending} onClick={() => void start()}>
                {sending ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} Hand over
              </button>
            </div>
          </section>

          {/* Runs */}
          <section className="space-y-2">
            <div className="eyebrow">Runs in {project.name}</div>
            {!runs?.length ? (
              <p className="muted text-[12.5px]">Nothing yet. A run shows every role that worked, its report, and what it used.</p>
            ) : (
              runs.map((r) => (
                <RunCard
                  key={r.id}
                  run={r}
                  open={openRun === r.id}
                  onToggle={() => setOpenRun(openRun === r.id ? null : r.id)}
                  onFollowUp={() => {
                    setFollowUp(r)
                    inputRef.current?.focus()
                  }}
                  onOpenTask={onOpenTask}
                />
              ))
            )}
          </section>
        </>
      )}

      {editingTeam && catalog && (
        <TeamModal
          team={editingTeam === 'new' ? null : editingTeam}
          catalog={catalog}
          onClose={() => setEditingTeam(null)}
          onSaved={(t) => {
            setSelectedId(t.id)
            setEditingTeam(null)
          }}
          onDeleted={() => {
            setSelectedId(null)
            setEditingTeam(null)
          }}
        />
      )}
      {editingRole && team && <RoleModal role={editingRole} team={team} catalog={catalog ?? []} onClose={() => setEditingRole(null)} />}
    </div>
  )
}
