import { useState } from 'react'
import { BookOpen, FolderOpen, Pencil, Pin, Plus, Sparkles, Trash2 } from 'lucide-react'
import type { KnowledgeCategory, KnowledgeEntry, Project } from '@shared/types'
import { act, api } from '../lib/api'
import { relative } from '../lib/dates'
import { Markdown } from '../lib/markdown'
import { confirmAction, cx, Empty, Field, Modal } from './ui'

const CATEGORIES: { id: KnowledgeCategory; label: string; badgeClass: string }[] = [
  { id: 'architecture', label: 'Architecture & Stack', badgeClass: 'bg-sky-500/15 text-sky-300 border-sky-500/30' },
  { id: 'conventions', label: 'Conventions & Rules', badgeClass: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  { id: 'feature', label: 'Features & Modules', badgeClass: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30' },
  { id: 'decisions', label: 'Decisions & Gotchas', badgeClass: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  { id: 'handoff', label: 'Cross-AI Handoff Log', badgeClass: 'bg-purple-500/15 text-purple-300 border-purple-500/30' }
]

interface KnowledgeBaseViewProps {
  project: Project
  entries: KnowledgeEntry[]
}

export function KnowledgeBaseView({ project, entries }: KnowledgeBaseViewProps): React.JSX.Element {
  const [filter, setFilter] = useState<'all' | KnowledgeCategory>('all')
  const [editing, setEditing] = useState<Partial<KnowledgeEntry> | null>(null)
  const [scanning, setScanning] = useState(false)

  const filtered = filter === 'all' ? entries : entries.filter((e) => e.category === filter)

  const handleScan = async (): Promise<void> => {
    setScanning(true)
    await act(api.knowledge.scanRepo(project.id), 'Repository scanned & Knowledge Base updated')
    setScanning(false)
  }

  return (
    <div className="space-y-4">
      {/* Banner explaining the Cross-AI Shared Knowledge Base */}
      <div className="card flex flex-wrap items-center justify-between gap-4 border-indigo-500/25 bg-indigo-500/[0.06] p-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <BookOpen size={16} className="text-indigo-400" />
            <h3 className="text-[14.5px] font-semibold text-white">
              {project.name} — Unified Cross-AI Knowledge Base
            </h3>
            <span className="rounded-full border border-indigo-400/30 bg-indigo-500/20 px-2 py-0.5 font-mono text-[11px] text-indigo-200">
              .ai-kb/PROJECT_KNOWLEDGE.md
            </span>
          </div>
          <p className="muted max-w-2xl text-[12.5px]">
            Pinned entries are synced to disk and shared (compactly, to save tokens) with every session across{' '}
            <strong className="text-zinc-200">Claude Code, Antigravity, Codex, and Copilot</strong>. When one AI
            completes a task or hits a rate limit, its handoff summary is recorded here so the next AI picks up seamlessly.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {project.folder && (
            <button
              type="button"
              onClick={() => api.app.openPath(`${project.folder}\\.ai-kb`)}
              className="btn h-8 text-[12px]"
              title="Open .ai-kb folder on disk"
            >
              <FolderOpen size={13} /> Open .ai-kb
            </button>
          )}
          <button
            type="button"
            disabled={scanning || !project.folder}
            onClick={handleScan}
            className="btn h-8 text-[12px]"
            title="Detect the stack, map the source tree and build a graphify code graph (no AI tokens) — never overwrites entries you wrote"
          >
            <Sparkles size={13} className="text-amber-400" /> {scanning ? 'Scanning…' : 'Scan Codebase'}
          </button>
          <button
            type="button"
            onClick={() =>
              setEditing({
                project_id: project.id,
                category: 'feature',
                title: '',
                content: '',
                files: '',
                pinned: 1
              })
            }
            className="btn btn-primary h-8 text-[12px]"
          >
            <Plus size={14} /> Add Entry
          </button>
        </div>
      </div>

      {/* Category Filter Pills */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setFilter('all')}
          className={cx(
            'chip', filter === 'all' && 'chip-active'
          )}
        >
          All ({entries.length})
        </button>
        {CATEGORIES.map((c) => {
          const count = entries.filter((e) => e.category === c.id).length
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => setFilter(c.id)}
              className={cx(
                'cursor-pointer rounded-full border px-3 py-1 text-[12px] font-medium transition-colors',
                filter === c.id
                  ? 'border-indigo-400/40 bg-indigo-500/20 text-white'
                  : 'border-white/[0.08] bg-white/[0.03] text-zinc-400 hover:text-zinc-200'
              )}
            >
              {c.label} ({count})
            </button>
          )
        })}
      </div>

      {/* Knowledge Base Cards */}
      {!filtered.length ? (
        <Empty
          icon={<BookOpen size={28} />}
          title="No Knowledge Base entries in this category"
          hint="Click 'Scan Codebase' to auto-populate from your repository, or add an entry for a feature, architecture rule, or convention."
          action={
            <button
              type="button"
              onClick={handleScan}
              className="btn btn-primary h-8"
            >
              <Sparkles size={13} /> Scan Codebase Now
            </button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3">
          {filtered.map((entry) => {
            const catMeta = CATEGORIES.find((c) => c.id === entry.category) ?? CATEGORIES[2]
            return (
              <div key={entry.id} className="card space-y-2.5 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={cx('rounded-full border px-2 py-0.5 text-[11px] font-medium', catMeta.badgeClass)}>
                        {catMeta.label}
                      </span>
                      <h4 className="text-[14.5px] font-semibold text-white">{entry.title}</h4>
                      {!!entry.pinned && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10.5px] font-medium text-emerald-300">
                          <Pin size={10} /> Injected to all AIs
                        </span>
                      )}
                    </div>
                    {entry.files.trim() && (
                      <p className="font-mono text-[11.5px] text-zinc-400">Files: {entry.files}</p>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    <span className="muted mr-1 text-[11px]">
                      by {entry.updated_by} · {relative(entry.updated_at)}
                    </span>
                    <button
                      type="button"
                      onClick={() => act(api.knowledge.togglePin(entry.id), entry.pinned ? 'Unpinned from prompt context' : 'Pinned to all AI prompts')}
                      title={entry.pinned ? 'Pinned (always sent to AIs). Click to unpin' : 'Click to pin to all AI prompts'}
                      className={cx('btn btn-ghost btn-icon h-7 w-7', !!entry.pinned && 'text-emerald-400')}
                    >
                      <Pin size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(entry)}
                      title="Edit entry"
                      className="btn btn-ghost btn-icon h-7 w-7"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        confirmAction(`Delete "${entry.title}" from ${project.name}'s Knowledge Base?`) &&
                        act(api.knowledge.delete(entry.id), 'Deleted')
                      }
                      title="Delete entry"
                      className="btn btn-ghost btn-icon btn-danger h-7 w-7"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>

                <div className="rounded-lg border border-white/[0.06] bg-black/25 px-3.5 py-2.5">
                  <Markdown text={entry.content} />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {editing && (
        <KnowledgeModal
          entry={editing}
          projectId={project.id}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

function KnowledgeModal({
  entry,
  projectId,
  onClose
}: {
  entry: Partial<KnowledgeEntry>
  projectId: number
  onClose: () => void
}): React.JSX.Element {
  const [category, setCategory] = useState<KnowledgeCategory>(entry.category ?? 'feature')
  const [title, setTitle] = useState(entry.title ?? '')
  const [files, setFiles] = useState(entry.files ?? '')
  const [content, setContent] = useState(entry.content ?? '')
  const [pinned, setPinned] = useState(entry.pinned ?? 1)

  const save = async (): Promise<void> => {
    const res = await act(
      api.knowledge.save({
        id: entry.id,
        project_id: projectId,
        category,
        title,
        files,
        content,
        pinned,
        updated_by: 'user'
      }),
      'Knowledge Base updated & synced to .ai-kb/PROJECT_KNOWLEDGE.md'
    )
    if (res) onClose()
  }

  return (
    <Modal
      title={entry.id ? 'Edit Knowledge Base Entry' : 'New Knowledge Base Entry'}
      width="max-w-2xl"
      onClose={onClose}
      footer={
        <>
          <span className="flex-1" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={!title.trim()}>
            Save & Sync to Disk
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Category">
            <select className="input" value={category} onChange={(e) => setCategory(e.target.value as KnowledgeCategory)}>
              {CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Relevant Files (optional)">
            <input
              className="input font-mono text-[12px]"
              value={files}
              onChange={(e) => setFiles(e.target.value)}
              placeholder="src/core/projects.ts, src/App.tsx"
            />
          </Field>
        </div>

        <Field label="Title">
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g., Auth Flow & Subscription Rate Limits"
            autoFocus
          />
        </Field>

        <Field label="Knowledge Content (Markdown — shared with all AI CLIs)">
          <textarea
            className="input min-h-[200px] font-mono text-[12.5px]"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Describe architecture, conventions, API contracts, or feature notes that every AI should know…"
          />
        </Field>

        <label className="flex cursor-pointer items-center gap-2 text-[13px] text-zinc-200">
          <input
            type="checkbox"
            checked={Boolean(pinned)}
            onChange={(e) => setPinned(e.target.checked ? 1 : 0)}
            className="accent-indigo-500"
          />
          Pin to prompt context (automatically sent to Claude, Antigravity, Codex, and Copilot)
        </label>
      </div>
    </Modal>
  )
}
