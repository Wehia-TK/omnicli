import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowRight,
  Check,
  Clock,
  Crosshair,
  ExternalLink,
  GitPullRequest,
  Globe,
  Loader2,
  MessageSquarePlus,
  Pause,
  Play,
  Plug,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  Trash2,
  Undo2,
  X
} from 'lucide-react'
import type { CliId, CliSubscriptionStatus, DiffHunk, McpServerEntry, MentionItem, Project, ProjectTask, Schedule } from '@shared/types'
import { act, api, toast, useData } from '../lib/api'
import { relative } from '../lib/dates'
import { CliAvatar } from './CliAvatars'
import { confirmAction, cx, Field, Modal } from './ui'

// ───────────────────────────── Approvals ─────────────────────────────

/** Pending edit / command approvals for a running Claude session (Default & Accept Edits modes). */
export function ApprovalCards({ taskId }: { taskId: number }): React.JSX.Element | null {
  const { data } = useData(() => api.approvals.list(taskId), [taskId])
  const [denyFor, setDenyFor] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  if (!data?.length) return null
  return (
    <div className="space-y-2">
      {data.map((a) => {
        const input = a.input as Record<string, unknown>
        const oldText = typeof input.old_string === 'string' ? input.old_string : ''
        const newText = typeof input.new_string === 'string' ? input.new_string : typeof input.content === 'string' ? input.content : ''
        return (
          <div key={a.id} className="card pop-in border-amber-400/35 bg-amber-500/[0.07] p-3.5">
            <div className="flex items-center gap-2 text-[12.5px] font-semibold text-amber-200">
              <ShieldAlert size={14} /> Claude wants to use {a.toolName}
              <span className="muted ml-auto text-[11px] font-normal">{relative(a.createdAt)}</span>
            </div>
            <div className="mt-1.5 truncate font-mono text-[12px] text-zinc-200" title={a.summary}>
              {a.summary}
            </div>
            {(oldText || newText) && (
              <pre className="selectable mt-2 max-h-56 overflow-auto rounded-lg border border-white/[0.08] bg-black/40 p-2.5 font-mono text-[11.5px] leading-relaxed">
                {(oldText ? oldText.split('\n') : []).map((l, i) => (
                  <div key={`o${i}`} className="bg-red-500/12 text-red-300">
                    -{l}
                  </div>
                ))}
                {newText
                  .split('\n')
                  .slice(0, 200)
                  .map((l, i) => (
                    <div key={`n${i}`} className="bg-emerald-500/12 text-emerald-300">
                      +{l}
                    </div>
                  ))}
              </pre>
            )}
            {denyFor === a.id ? (
              <div className="mt-2.5 flex gap-2">
                <input
                  className="input h-8 text-[12.5px]"
                  autoFocus
                  placeholder="Tell Claude what to do instead (optional)"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && act(api.approvals.decide(a.id, 'deny', reason)).then(() => (setDenyFor(null), setReason('')))}
                />
                <button type="button" className="btn btn-danger h-8" onClick={() => act(api.approvals.decide(a.id, 'deny', reason)).then(() => (setDenyFor(null), setReason('')))}>
                  Deny
                </button>
              </div>
            ) : (
              <div className="mt-2.5 flex flex-wrap gap-2">
                <button type="button" className="btn btn-primary h-8" onClick={() => act(api.approvals.decide(a.id, 'allow'))}>
                  <Check size={13} /> Allow
                </button>
                <button type="button" className="btn h-8" onClick={() => act(api.approvals.decide(a.id, 'always'))} title={`Allow every ${a.toolName} call for the rest of this run`}>
                  Allow {a.toolName} for this run
                </button>
                <button type="button" className="btn btn-ghost btn-danger h-8" onClick={() => setDenyFor(a.id)}>
                  <X size={13} /> Deny…
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ───────────────────────────── Pull requests ─────────────────────────────

export function PrButton({ task }: { task: ProjectTask }): React.JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const { data: pr, reload } = useData(() => (task.pr_url ? api.github.status(task.id).catch(() => null) : Promise.resolve(null)), [task.id, task.pr_url], { throttleMs: 30_000 })
  if (task.checkout_mode !== 'worktree' || !task.branch) return null
  if (!task.pr_url) {
    return (
      <button
        type="button"
        disabled={busy || task.run_state === 'running'}
        className="btn h-7 px-2.5 text-[11.5px]"
        onClick={async () => {
          setBusy(true)
          const r = await act(api.github.createPr(task.id), 'Pull request created')
          setBusy(false)
          if (r) reload()
        }}
        title="Push this branch and open a GitHub pull request (uses the gh CLI)"
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <GitPullRequest size={12} className="text-sky-300" />} Create PR
      </button>
    )
  }
  const failing = pr?.checks.filter((c) => /FAIL|ERROR|CANCEL/.test(c.state)).length ?? 0
  const pending = pr?.checks.filter((c) => /PENDING|QUEUED|IN_PROGRESS|EXPECTED/.test(c.state)).length ?? 0
  return (
    <button
      type="button"
      onClick={() => window.open(task.pr_url!, '_blank')}
      className={cx('chip h-7', failing ? 'border-red-400/40 text-red-200' : pending ? 'text-amber-200' : pr ? 'text-emerald-200' : '')}
      title={pr ? pr.checks.map((c) => `${c.name}: ${c.state}`).join('\n') || 'No CI checks' : 'Open pull request'}
    >
      <GitPullRequest size={12} /> #{pr?.number ?? '…'} {pr?.state?.toLowerCase() ?? ''}
      {pr && (failing ? ` · ${failing} failing` : pending ? ` · ${pending} running` : pr.checks.length ? ' · checks passed' : '')}
      <ExternalLink size={10} className="opacity-60" />
    </button>
  )
}

// ───────────────────────────── Diff review ─────────────────────────────

/** Side-by-side diff with per-change Undo and line comments that go back to the AI as one review. */
export function DiffReview({ task, file, onSendReview }: { task: ProjectTask; file: string; onSendReview: (text: string) => void }): React.JSX.Element {
  const { data: hunks, reload } = useData(() => api.review.hunks(task.id, file), [task.id, file, task.run_state], { throttleMs: 2500 })
  const [comments, setComments] = useState<{ line: string; text: string }[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const rows = (h: DiffHunk): { left: DiffHunk['lines'][number] | null; right: DiffHunk['lines'][number] | null }[] => {
    const out: { left: DiffHunk['lines'][number] | null; right: DiffHunk['lines'][number] | null }[] = []
    let dels: DiffHunk['lines'] = []
    let adds: DiffHunk['lines'] = []
    const flush = (): void => {
      for (let i = 0; i < Math.max(dels.length, adds.length); i++) out.push({ left: dels[i] ?? null, right: adds[i] ?? null })
      dels = []
      adds = []
    }
    for (const l of h.lines) {
      if (l.kind === '-') dels.push(l)
      else if (l.kind === '+') adds.push(l)
      else {
        flush()
        out.push({ left: l, right: l })
      }
    }
    flush()
    return out
  }

  const addComment = (key: string): void => {
    if (!draft.trim()) return setEditing(null)
    setComments([...comments.filter((c) => c.line !== key), { line: key, text: draft.trim() }])
    setDraft('')
    setEditing(null)
  }

  const cell = (l: DiffHunk['lines'][number] | null, side: 'L' | 'R'): React.JSX.Element => {
    const no = l ? (side === 'L' ? l.oldNo : l.newNo) : null
    const key = `${file}:${no ?? ''}`
    const tone = !l ? 'bg-white/[0.015]' : l.kind === '-' ? 'bg-red-500/12 text-red-200' : l.kind === '+' ? 'bg-emerald-500/12 text-emerald-200' : 'text-zinc-300'
    return (
      <div className={cx('group flex min-w-0', tone)}>
        <button
          type="button"
          disabled={!no || side === 'L'}
          onClick={() => (setEditing(key), setDraft(comments.find((c) => c.line === key)?.text ?? ''))}
          className="w-10 shrink-0 cursor-pointer pr-1.5 text-right text-zinc-600 select-none hover:text-indigo-300 disabled:cursor-default"
          title={side === 'R' && no ? 'Comment on this line' : undefined}
        >
          {no ?? ''}
        </button>
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-all">{l?.text ?? ''}</span>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {!hunks?.length && <p className="muted text-[12.5px]">No line changes to review in this file (new or binary file).</p>}
      {hunks?.map((h) => (
        <div key={h.index} className="overflow-hidden rounded-lg border border-white/[0.08]">
          <div className="flex items-center justify-between bg-white/[0.04] px-2.5 py-1 font-mono text-[11px] text-indigo-300">
            <span>{h.header}</span>
            <button
              type="button"
              className="btn btn-ghost h-6 px-2 text-[11px] text-zinc-300"
              title="Undo just this change in the working tree"
              onClick={() => act(api.review.revertHunk(task.id, file, h.index), 'Change undone').then(() => reload())}
            >
              <Undo2 size={11} /> Undo change
            </button>
          </div>
          <div className="selectable grid grid-cols-2 divide-x divide-white/[0.06] font-mono text-[11.5px] leading-relaxed">
            {rows(h).map((r, i) => {
              const key = `${file}:${r.right?.newNo ?? ''}`
              const c = comments.find((x) => x.line === key)
              return (
                <div key={i} className="contents">
                  {cell(r.left, 'L')}
                  <div>
                    {cell(r.right, 'R')}
                    {editing === key && (
                      <div className="flex gap-1.5 bg-black/40 p-1.5 font-sans">
                        <input
                          className="input h-7 text-[12px]"
                          autoFocus
                          value={draft}
                          placeholder="What should change here?"
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => (e.key === 'Enter' ? addComment(key) : e.key === 'Escape' && setEditing(null))}
                        />
                        <button type="button" className="btn h-7 px-2 text-[11px]" onClick={() => addComment(key)}>
                          Add
                        </button>
                      </div>
                    )}
                    {c && editing !== key && <div className="bg-indigo-500/15 px-2 py-1 font-sans text-[11.5px] text-indigo-100">💬 {c.text}</div>}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}
      {comments.length > 0 && (
        <div className="flex items-center justify-between rounded-lg border border-indigo-400/30 bg-indigo-500/10 px-3 py-2">
          <span className="text-[12px] text-indigo-100">{comments.length} review comment(s)</span>
          <button
            type="button"
            className="btn btn-primary h-7 px-2.5 text-[11.5px]"
            disabled={task.run_state === 'running'}
            onClick={() => {
              onSendReview(['Please address these review comments:', ...comments.map((c) => `- ${c.line}: ${c.text}`)].join('\n'))
              setComments([])
            }}
          >
            <MessageSquarePlus size={12} /> Send review to AI
          </button>
        </div>
      )}
    </div>
  )
}

// ───────────────────────────── Rules editor ─────────────────────────────

export function RulesModal({ project, onClose }: { project: Project; onClose: () => void }): React.JSX.Element {
  const { data } = useData(() => api.rules.get(project.id), [project.id], { throttleMs: 5000 })
  const [text, setText] = useState<string | null>(null)
  const [targets, setTargets] = useState<string[]>(['CLAUDE.md', 'AGENTS.md', '.github/copilot-instructions.md'])
  const value = text ?? data?.text ?? ''
  const label: Record<string, string> = {
    'CLAUDE.md': 'Claude Code',
    'AGENTS.md': 'Codex · Antigravity',
  //
    '.github/copilot-instructions.md': 'GitHub Copilot'
  }
  return (
    <Modal
      title={`Project rules — ${project.name}`}
      width="max-w-3xl"
      onClose={onClose}
      footer={
        <>
          <span className="muted text-[11.5px]">Written inside a marked block — anything else in those files is kept.</span>
          <span className="flex-1" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => act(api.rules.save(project.id, value, targets), 'Rules synced to every AI').then(onClose)}>
            Save & sync
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="muted text-[12.5px]">
          One set of instructions for every AI. Saved into each CLI&apos;s own rules file so the same rules apply in Omni CLI and when you use the CLIs directly.
        </p>
        <textarea
          className="input min-h-[300px] font-mono text-[12.5px]"
          value={value}
          onChange={(e) => setText(e.target.value)}
          placeholder={'# Rules\n- Use TypeScript strict mode\n- Run `npm run typecheck` before finishing\n- Never commit .env files'}
        />
        <div className="flex flex-wrap gap-1.5">
          {(data?.files ?? []).map((f) => {
            const on = targets.includes(f.name)
            return (
              <button
                key={f.name}
                type="button"
                className={cx('chip', on && 'chip-active')}
                onClick={() => setTargets(on ? targets.filter((x) => x !== f.name) : [...targets, f.name])}
                title={f.exists ? (f.managed ? 'Synced by Omni CLI' : 'Exists — Omni CLI block will be added at the top') : 'Will be created'}
              >
                {on && <Check size={11} />}
                {f.name} <span className="font-normal opacity-60">· {label[f.name]}</span>
                {!f.exists && <span className="opacity-60">(new)</span>}
              </button>
            )
          })}
        </div>
      </div>
    </Modal>
  )
}

// ───────────────────────────── Search ─────────────────────────────

export function SearchModal({
  projectId,
  onOpen,
  onClose
}: {
  projectId?: number
  onOpen: (projectId: number, taskId: number) => void
  onClose: () => void
}): React.JSX.Element {
  const [q, setQ] = useState('')
  const [all, setAll] = useState(!projectId)
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 220)
    return () => clearTimeout(t)
  }, [q])
  const { data: hits } = useData(() => (debounced.trim().length >= 2 ? api.history.search(debounced, all ? undefined : projectId) : Promise.resolve([])), [debounced, all])
  return (
    <Modal title={<span className="flex items-center gap-2"><Search size={15} className="text-indigo-300" /> Search sessions</span>} width="max-w-2xl" onClose={onClose}>
      <div className="space-y-3">
        <div className="flex gap-2">
          <input className="input" autoFocus value={q} placeholder="Search prompts, answers and transcripts…" onChange={(e) => setQ(e.target.value)} />
          {projectId && (
            <div className="segmented shrink-0">
              <button type="button" data-on={!all} onClick={() => setAll(false)}>
                This project
              </button>
              <button type="button" data-on={all} onClick={() => setAll(true)}>
                All
              </button>
            </div>
          )}
        </div>
        <div className="max-h-[55vh] space-y-1 overflow-y-auto">
          {debounced.length >= 2 && !hits?.length && <p className="muted px-1 py-4 text-center text-[12.5px]">No matches.</p>}
          {hits?.map((h) => (
            <button
              key={h.taskId}
              type="button"
              onClick={() => (onOpen(h.projectId, h.taskId), onClose())}
              className="flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left hover:bg-white/[0.06]"
            >
              <span className="flex w-full items-center gap-2 text-[13px] font-medium text-zinc-100">
                <span className="truncate">{h.title}</span>
                <span className="muted ml-auto shrink-0 text-[11px] font-normal">
                  {h.projectName} · {relative(h.at)}
                </span>
              </span>
              <span className="line-clamp-2 text-[12px] text-zinc-400">{h.snippet}</span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  )
}

// ───────────────────────────── Schedules ─────────────────────────────

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function SchedulesPanel({ project, clis, cli, model }: { project: Project; clis: CliSubscriptionStatus[]; cli: CliId; model: string }): React.JSX.Element {
  const { data: list } = useData(() => api.schedules.list(project.id), [project.id])
  const [editing, setEditing] = useState<Partial<Schedule> | null>(null)
  const describe = (s: Schedule): string =>
    s.kind === 'hourly' ? `every ${s.every_hours}h` : s.kind === 'weekly' ? `${DAYS[s.weekday]} ${s.time_of_day}` : `daily ${s.time_of_day}`
  return (
    <section className="space-y-1.5">
      <div className="flex items-center justify-between">
        <h3 className="eyebrow flex items-center gap-1.5">
          <Clock size={12} /> Scheduled tasks ({list?.length ?? 0})
        </h3>
        <button
          type="button"
          className="btn h-7 px-2.5 text-[11.5px]"
          onClick={() => setEditing({ project_id: project.id, title: '', prompt: '', cli, model, kind: 'daily', time_of_day: '09:00', every_hours: 6, weekday: 1, permission_mode: 'accept-edits' })}
        >
          <Plus size={12} /> New schedule
        </button>
      </div>
      {!!list?.length && (
        <div className="card divide-y divide-white/[0.06]">
          {list.map((s) => (
            <div key={s.id} className={cx('flex items-center gap-3 px-4 py-2.5', !s.enabled && 'opacity-50')}>
              <CliAvatar cli={s.cli} size={16} />
              <button type="button" className="min-w-0 flex-1 cursor-pointer text-left" onClick={() => setEditing(s)}>
                <div className="truncate text-[13px] font-medium text-zinc-100">{s.title}</div>
                <div className="muted text-[11.5px]">
                  {describe(s)}
                  {s.next_run_at && s.enabled ? ` · next ${new Date(s.next_run_at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}
                </div>
              </button>
              <button type="button" className="btn btn-ghost btn-icon h-7 w-7" title="Run now" onClick={() => act(api.schedules.runNow(s.id), 'Started')}>
                <Play size={12} />
              </button>
              <button type="button" className="btn btn-ghost btn-icon h-7 w-7" title={s.enabled ? 'Pause' : 'Resume'} onClick={() => act(api.schedules.toggle(s.id))}>
                {s.enabled ? <Pause size={12} /> : <RotateCcw size={12} />}
              </button>
              <button type="button" className="btn btn-ghost btn-icon btn-danger h-7 w-7" onClick={() => confirmAction(`Delete schedule "${s.title}"?`) && act(api.schedules.delete(s.id))}>
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      {editing && (
        <Modal
          title={editing.id ? 'Edit schedule' : 'New scheduled task'}
          onClose={() => setEditing(null)}
          footer={
            <>
              <span className="flex-1" />
              <button type="button" className="btn" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() =>
                  act(api.schedules.save({ ...editing, project_id: project.id, title: editing.title ?? '', prompt: editing.prompt ?? '' }), 'Schedule saved').then(
                    (r) => r && setEditing(null)
                  )
                }
              >
                Save
              </button>
            </>
          }
        >
          <div className="space-y-3">
            <Field label="Title">
              <input className="input" value={editing.title ?? ''} onChange={(e) => setEditing({ ...editing, title: e.target.value })} placeholder="Nightly dependency audit" />
            </Field>
            <Field label="Prompt (runs as a queued task on its own worktree branch)">
              <textarea className="input min-h-[110px]" value={editing.prompt ?? ''} onChange={(e) => setEditing({ ...editing, prompt: e.target.value })} />
            </Field>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Repeat">
                <select className="input" value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value as Schedule['kind'] })}>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="hourly">Every N hours</option>
                </select>
              </Field>
              {editing.kind === 'hourly' ? (
                <Field label="Hours">
                  <input className="input" type="number" min={1} value={editing.every_hours ?? 6} onChange={(e) => setEditing({ ...editing, every_hours: Number(e.target.value) })} />
                </Field>
              ) : (
                <Field label="Time">
                  <input className="input" type="time" value={editing.time_of_day ?? '09:00'} onChange={(e) => setEditing({ ...editing, time_of_day: e.target.value })} />
                </Field>
              )}
              {editing.kind === 'weekly' && (
                <Field label="Day">
                  <select className="input" value={editing.weekday ?? 1} onChange={(e) => setEditing({ ...editing, weekday: Number(e.target.value) })}>
                    {DAYS.map((d, i) => (
                      <option key={d} value={i}>
                        {d}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="AI">
                <select
                  className="input"
                  value={editing.cli}
                  onChange={(e) => {
                    const c = clis.find((x) => x.id === e.target.value)
                    setEditing({ ...editing, cli: e.target.value as CliId, model: c?.models[0]?.id ?? '' })
                  }}
                >
                  {clis.filter((c) => c.authenticated).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Model">
                <select className="input" value={editing.model} onChange={(e) => setEditing({ ...editing, model: e.target.value })}>
                  {(clis.find((c) => c.id === editing.cli)?.models ?? []).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Permissions" hint="Scheduled runs happen while you're away — Full Auto never waits for approvals; Accept Edits will wait for command approvals.">
              <select className="input" value={editing.permission_mode} onChange={(e) => setEditing({ ...editing, permission_mode: e.target.value as Schedule['permission_mode'] })}>
                <option value="accept-edits">Accept edits</option>
                <option value="bypass">Full auto</option>
                <option value="plan">Plan only</option>
              </select>
            </Field>
          </div>
        </Modal>
      )}
    </section>
  )
}

// ───────────────────────────── MCP manager ─────────────────────────────

const MCP_TARGETS: { id: CliId; label: string }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'agy', label: 'Antigravity' },
  { id: 'codex', label: 'Codex' }, { id: 'copilot', label: 'Copilot' }
  //
  //
  //
]

export function McpModal({ clis, onClose }: { clis: CliSubscriptionStatus[]; onClose: () => void }): React.JSX.Element {
  const { data: list, reload } = useData(() => api.mcp.list(), [], { throttleMs: 15_000 })
  const installed = clis.filter((c) => c.installed).map((c) => c.id)
  const [form, setForm] = useState<{ name: string; type: 'stdio' | 'http'; command: string; url: string; env: string; targets: CliId[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async (): Promise<void> => {
    if (!form) return
    const [command, ...args] = form.command.match(/"[^"]*"|\S+/g)?.map((x) => x.replace(/^"|"$/g, '')) ?? []
    const env = Object.fromEntries(
      form.env
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
    )
    setBusy(true)
    const r = await act(api.mcp.add({ name: form.name, type: form.type, command, args, url: form.url, env }, form.targets), 'MCP server synced')
    setBusy(false)
    if (r) (setForm(null), reload())
  }
  return (
    <Modal title={<span className="flex items-center gap-2"><Plug size={15} className="text-indigo-300" /> MCP servers — shared by every AI</span>} width="max-w-3xl" onClose={onClose}>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="muted text-[12.5px]">Add a server once and install it into each CLI&apos;s own config. Existing servers from every CLI are listed here.</p>
          <button type="button" className="btn btn-primary h-8" onClick={() => setForm({ name: '', type: 'stdio', command: '', url: '', env: '', targets: installed })}>
            <Plus size={13} /> Add server
          </button>
        </div>
        {!list ? (
          <p className="muted text-[12.5px]">Reading CLI configs…</p>
        ) : !list.length ? (
          <p className="muted rounded-lg border border-dashed border-white/[0.1] p-6 text-center text-[12.5px]">No MCP servers configured in any CLI yet.</p>
        ) : (
          <div className="card divide-y divide-white/[0.06]">
            {list.map((s: McpServerEntry) => (
              <div key={s.name} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-zinc-100">{s.name}</div>
                  <div className="muted truncate font-mono text-[11px]">{s.type === 'http' ? s.url : [s.command, ...(s.args ?? [])].join(' ')}</div>
                </div>
                <div className="flex flex-wrap gap-1">
                  {MCP_TARGETS.filter((t) => installed.includes(t.id)).map((t) => {
                    const on = s.installedIn.includes(t.id)
                    return (
                      <button
                        key={t.id}
                        type="button"
                        className={cx('chip h-6 px-2 text-[11px]', on && 'chip-active')}
                        title={on ? `Remove from ${t.label}` : `Install into ${t.label}`}
                        onClick={() =>
                          act(on ? api.mcp.remove(s.name, [t.id]) : api.mcp.add({ name: s.name, type: s.type, command: s.command, args: s.args, url: s.url, env: s.env }, [t.id])).then(() => reload())
                        }
                      >
                        {on && <Check size={10} />} {t.label}
                      </button>
                    )
                  })}
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon btn-danger h-7 w-7"
                  title="Remove from every CLI"
                  onClick={() => confirmAction(`Remove ${s.name} from every CLI?`) && act(api.mcp.remove(s.name, s.installedIn)).then(() => reload())}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {form && (
          <div className="card space-y-2.5 p-4">
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <Field label="Name">
                <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="github" />
              </Field>
              <Field label="Type">
                <div className="segmented h-9 items-center">
                  <button type="button" data-on={form.type === 'stdio'} onClick={() => setForm({ ...form, type: 'stdio' })}>
                    Command
                  </button>
                  <button type="button" data-on={form.type === 'http'} onClick={() => setForm({ ...form, type: 'http' })}>
                    URL
                  </button>
                </div>
              </Field>
            </div>
            {form.type === 'stdio' ? (
              <Field label="Command">
                <input className="input font-mono text-[12px]" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder="npx -y @modelcontextprotocol/server-github" />
              </Field>
            ) : (
              <Field label="Server URL">
                <input className="input font-mono text-[12px]" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://mcp.example.com/mcp" />
              </Field>
            )}
            <Field label="Environment variables (KEY=value per line)">
              <textarea className="input min-h-[60px] font-mono text-[12px]" value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value })} />
            </Field>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="label mb-0 mr-1">Install into</span>
              {MCP_TARGETS.filter((t) => installed.includes(t.id)).map((t) => {
                const on = form.targets.includes(t.id)
                return (
                  <button key={t.id} type="button" className={cx('chip h-6 px-2 text-[11px]', on && 'chip-active')} onClick={() => setForm({ ...form, targets: on ? form.targets.filter((x) => x !== t.id) : [...form.targets, t.id] })}>
                    {on && <Check size={10} />} {t.label}
                  </button>
                )
              })}
              <span className="flex-1" />
              <button type="button" className="btn h-8" onClick={() => setForm(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary h-8" disabled={busy || !form.name.trim() || !form.targets.length} onClick={save}>
                {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Save
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

// ───────────────────────────── Browser preview ─────────────────────────────

type WebviewEl = HTMLElement & {
  reload: () => void
  goBack: () => void
  getURL: () => string
  send: (channel: string, ...args: unknown[]) => void
  openDevTools: () => void
}

/** Preview your running app inside Omni CLI and click any element to attach it to the next prompt. */
export function BrowserPreview({ project, onPick }: { project: Project; onPick: (m: MentionItem) => void }): React.JSX.Element {
  const storeKey = `aihub-preview-url-${project.id}`
  const initial = useMemo(() => {
    try {
      return localStorage.getItem(storeKey) || 'http://localhost:5173'
    } catch {
      return 'http://localhost:5173'
    }
  }, [storeKey])
  const [url, setUrl] = useState(initial)
  const [src, setSrc] = useState(initial)
  const [picking, setPicking] = useState(false)
  const [preload, setPreload] = useState<string | null>(null)
  const ref = useRef<WebviewEl | null>(null)

  useEffect(() => {
    api.app.pickerPreload().then(setPreload).catch(() => setPreload(''))
  }, [])

  useEffect(() => {
    const wv = ref.current
    if (!wv) return
    const onMsg = (e: Event): void => {
      const ev = e as Event & { channel: string; args: unknown[] }
      if (ev.channel !== 'element-picked') return
      setPicking(false)
      const el = ev.args[0] as { selector: string; tag: string; text: string; html: string; size: string; styles: string; url: string } | null
      if (!el) return
      onPick({
        type: 'element',
        label: `<${el.tag}> ${el.text.slice(0, 24) || el.selector.slice(-24)}`,
        value: [`Page: ${el.url}`, `Selector: ${el.selector}`, `Size: ${el.size}`, `Computed: ${el.styles}`, el.text && `Text: ${el.text}`, `HTML:\n${el.html}`].filter(Boolean).join('\n')
      })
      toast('Element attached to the composer')
    }
    const onNav = (): void => {
      try {
        setUrl(wv.getURL())
      } catch {
        // ignore
      }
    }
    wv.addEventListener('ipc-message', onMsg)
    wv.addEventListener('did-navigate', onNav)
    wv.addEventListener('did-navigate-in-page', onNav)
    return () => {
      wv.removeEventListener('ipc-message', onMsg)
      wv.removeEventListener('did-navigate', onNav)
      wv.removeEventListener('did-navigate-in-page', onNav)
    }
  }, [onPick, preload])

  const go = (): void => {
    const u = /^https?:\/\//.test(url) ? url : `http://${url}`
    setSrc(u)
    try {
      localStorage.setItem(storeKey, u)
    } catch {
      // ignore
    }
  }

  return (
    <div className="card flex h-full min-h-[420px] flex-col overflow-hidden">
      <div className="flex items-center gap-1.5 border-b border-white/[0.08] px-2.5 py-1.5">
        <Globe size={13} className="shrink-0 text-sky-300" />
        <input className="input h-7 font-mono text-[12px]" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} />
        <button type="button" className="btn btn-ghost btn-icon h-7 w-7" onClick={go} title="Go">
          <ArrowRight size={13} />
        </button>
        <button type="button" className="btn btn-ghost btn-icon h-7 w-7" onClick={() => ref.current?.reload()} title="Reload">
          <RefreshCw size={12} />
        </button>
        <button
          type="button"
          disabled={!preload}
          className={cx('btn h-7 px-2.5 text-[11.5px]', picking && 'border-indigo-400/50 bg-indigo-500/25')}
          onClick={() => {
            const next = !picking
            setPicking(next)
            ref.current?.send('picker', next)
          }}
          title="Click an element in the page to attach it to your prompt (Esc cancels)"
        >
          <Crosshair size={12} /> {picking ? 'Click an element…' : 'Pick element'}
        </button>
        <button type="button" className="btn btn-ghost h-7 px-2 text-[11px]" onClick={() => ref.current?.openDevTools()}>
          DevTools
        </button>
      </div>
      {preload !== null &&
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (() => {
          const props = { ref, src, preload: preload || undefined, className: 'min-h-0 flex-1 bg-white', partition: 'persist:aihub-preview' } as Record<string, unknown>
          return <webview {...(props as React.HTMLAttributes<HTMLElement>)} />
        })()}
    </div>
  )
}

// ───────────────────────────── Image preview ─────────────────────────────

/** Thumbnail of an attached image; click to see it full size. */
export function ImageThumb({ path, size = 28, label }: { path: string; size?: number; label?: string }): React.JSX.Element {
  const { data: src } = useData(() => api.attachments.readImage(path).catch(() => ''), [path], { throttleMs: 60_000 })
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => src && setOpen(true)}
        className="shrink-0 cursor-zoom-in overflow-hidden rounded-md border border-white/[0.12] bg-black/30"
        style={{ width: size, height: size }}
        title={label ?? path}
      >
        {src ? <img src={src} alt={label ?? 'attachment'} className="size-full object-cover" /> : <span className="block size-full animate-pulse bg-white/[0.06]" />}
      </button>
      {open &&
        src &&
        createPortal(
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/75 p-8 backdrop-blur-sm" onMouseDown={() => setOpen(false)}>
          <div className="pop-in flex max-h-full max-w-full flex-col items-center gap-2" onMouseDown={(e) => e.stopPropagation()}>
            <img src={src} alt={label ?? 'attachment'} className="max-h-[80vh] max-w-[88vw] rounded-xl border border-white/[0.12] object-contain shadow-2xl" />
            <div className="flex items-center gap-2 text-[12px] text-zinc-300">
              <span className="max-w-[60vw] truncate font-mono">{label ?? path}</span>
              <button type="button" className="btn h-7 px-2.5 text-[11.5px]" onClick={() => api.app.openPath(path)}>
                <ExternalLink size={11} /> Open
              </button>
              <button type="button" className="btn h-7 px-2.5 text-[11.5px]" onClick={() => setOpen(false)}>
                <X size={11} /> Close
              </button>
            </div>
          </div>
        </div>,
          document.body
        )}
    </>
  )
}

// ───────────────────────────── Skills manager ─────────────────────────────

const SKILL_TARGETS: { id: CliId; label: string }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'agy', label: 'Antigravity' },
  { id: 'codex', label: 'Codex' }
]

export function SkillsModal({ projectId, clis, onClose }: { projectId?: number; clis: CliSubscriptionStatus[]; onClose: () => void }): React.JSX.Element {
  const { data: skills, reload } = useData(() => api.skills.list(projectId), [projectId], { throttleMs: 15_000 })
  const installedClis = clis.filter((c) => c.installed).map((c) => c.id)
  const [filter, setFilter] = useState('')
  const [url, setUrl] = useState('')
  const [targets, setTargets] = useState<CliId[]>(SKILL_TARGETS.map((t) => t.id).filter((id) => installedClis.includes(id)))
  const [busy, setBusy] = useState(false)
  const [viewing, setViewing] = useState<{ name: string; text: string } | null>(null)
  const list = (skills ?? []).filter((k) => !filter || `${k.name} ${k.description}`.toLowerCase().includes(filter.toLowerCase()))

  const install = async (): Promise<void> => {
    setBusy(true)
    const r = await act(api.skills.install(url, targets))
    setBusy(false)
    if (r) {
      toast(`Installed ${r.installed.join(', ')} for ${r.into.join(', ')}`)
      setUrl('')
      reload()
    }
  }

  return (
    <Modal title={<span className="flex items-center gap-2"><Plus size={15} className="text-amber-300" /> Skills</span>} width="max-w-3xl" onClose={onClose}>
      <div className="space-y-4">
        <div className="card space-y-2.5 p-3.5">
          <div className="eyebrow">Install from a link</div>
          <div className="flex gap-2">
            <input
              className="input font-mono text-[12px]"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && url.trim() && !busy && install()}
              placeholder="https://github.com/owner/repo/tree/main/skills/my-skill  ·  or a SKILL.md / .zip link"
            />
            <button type="button" className="btn btn-primary h-9" disabled={busy || !url.trim() || !targets.length} onClick={install}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Install
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="label mb-0 mr-1">Install for</span>
            {SKILL_TARGETS.filter((t) => installedClis.includes(t.id)).map((t) => {
              const on = targets.includes(t.id)
              return (
                <button key={t.id} type="button" className={cx('chip h-6 px-2 text-[11px]', on && 'chip-active')} onClick={() => setTargets(on ? targets.filter((x) => x !== t.id) : [...targets, t.id])}>
                  {on && <Check size={10} />} {t.label}
                </button>
              )
            })}
          </div>
          <p className="muted text-[11px]">
            A repo link installs every skill in it; a folder or SKILL.md link installs just that one. Skills contain instructions (and sometimes scripts) the AI will follow, so only install from sources you trust.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <input className="input h-8 text-[12.5px]" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Filter ${skills?.length ?? 0} skills…`} />
          <button type="button" className="btn btn-ghost btn-icon h-8 w-8" onClick={reload} title="Rescan skill folders">
            <RefreshCw size={13} />
          </button>
        </div>

        <div className="card max-h-[44vh] divide-y divide-white/[0.06] overflow-y-auto">
          {!list.length && <p className="muted p-6 text-center text-[12.5px]">{skills ? 'No skills found.' : 'Scanning…'}</p>}
          {list.map((k) => (
            <div key={k.path} className="flex items-start gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[13px] font-medium text-zinc-100">/{k.name}</span>
                  {k.scope === 'project' && <span className="rounded bg-sky-500/15 px-1.5 py-0.2 text-[10px] text-sky-300">project</span>}
                  {k.native.map((n) => (
                    <span key={n} className="rounded bg-white/[0.07] px-1.5 py-0.2 text-[10px] text-zinc-400">
                      {n}
                    </span>
                  ))}
                </div>
                {k.description && <p className="muted mt-0.5 line-clamp-2 text-[11.5px]">{k.description}</p>}
              </div>
              <button type="button" className="btn btn-ghost h-7 px-2 text-[11px]" onClick={() => api.skills.read(k.path).then((text) => setViewing({ name: k.name, text }))}>
                View
              </button>
              <button type="button" className="btn btn-ghost btn-icon h-7 w-7" title="Open folder" onClick={() => api.app.openPath(k.path.replace(/[\\/]SKILL\.md$/i, ''))}>
                <ExternalLink size={12} />
              </button>
              {k.scope === 'user' && (
                <button
                  type="button"
                  className="btn btn-ghost btn-icon btn-danger h-7 w-7"
                  title="Remove this skill folder"
                  onClick={() => confirmAction(`Delete the skill folder for /${k.name}?\n${k.path}`) && act(api.skills.remove(k.path), 'Skill removed').then(() => reload())}
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
      {viewing && (
        <Modal title={`/${viewing.name} · SKILL.md`} width="max-w-3xl" onClose={() => setViewing(null)}>
          <pre className="selectable max-h-[65vh] overflow-auto whitespace-pre-wrap rounded-lg bg-black/40 p-3 font-mono text-[12px] leading-relaxed text-zinc-200">{viewing.text}</pre>
        </Modal>
      )}
    </Modal>
  )
}

// ───────────────────────────── Compare picker ─────────────────────────────

/** Readable, grouped picker for the second AI in a compare run (replaces the native dropdown). */
export function ComparePicker({
  clis,
  value,
  onChange
}: {
  clis: CliSubscriptionStatus[]
  value: { cli: CliId; model: string } | null
  onChange: (v: { cli: CliId; model: string } | null) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])
  const current = value ? clis.find((c) => c.id === value.cli)?.models.find((m) => m.id === value.model) : null
  return (
    <div ref={ref} className="relative ml-auto mr-2">
      <button
        type="button"
        className={cx('chip h-6 gap-1 px-2 text-[11px]', value && 'chip-active')}
        onClick={() => setOpen(!open)}
        title="Run the same prompt on a second AI at the same time (each on its own branch) and compare"
      >
        {value ? (
          <>
            <CliAvatar cli={value.cli} size={11} /> vs {current?.name ?? value.model}
            <span
              role="button"
              tabIndex={0}
              className="ml-0.5 rounded p-0.5 hover:bg-white/[0.15]"
              onClick={(e) => (e.stopPropagation(), onChange(null))}
              onKeyDown={(e) => e.key === 'Enter' && onChange(null)}
            >
              <X size={10} />
            </span>
          </>
        ) : (
          'Compare with…'
        )}
      </button>
      {open && (
        <div className="glass-float pop-in absolute right-0 top-8 z-[80] max-h-[360px] w-[300px] overflow-y-auto rounded-xl p-1.5">
          <div className="eyebrow px-2.5 py-1">Second AI for this prompt</div>
          {clis
            .filter((c) => c.authenticated)
            .map((c) => (
              <div key={c.id} className="py-0.5">
                <div className="flex items-center gap-1.5 px-2.5 pt-1.5 pb-0.5 text-[11px] font-semibold text-zinc-400">
                  <CliAvatar cli={c.id} size={12} /> {c.shortName}
                </div>
                {c.models.map((m) => {
                  const on = value?.cli === c.id && value.model === m.id
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => (onChange({ cli: c.id, model: m.id }), setOpen(false))}
                      className={cx(
                        'flex w-full cursor-pointer items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors',
                        on ? 'bg-indigo-500/20 text-white' : 'text-zinc-200 hover:bg-white/[0.07]'
                      )}
                    >
                      <span className="truncate">{m.name}</span>
                      {on && <Check size={12} className="text-indigo-300" />}
                    </button>
                  )
                })}
              </div>
            ))}
        </div>
      )}
    </div>
  )
}
