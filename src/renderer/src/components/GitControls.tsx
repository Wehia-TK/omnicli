import { useEffect, useRef, useState } from 'react'
import { ArrowUpFromLine, GitBranch, GitCommitHorizontal, Link2, Loader2, Pencil } from 'lucide-react'
import type { Project } from '@shared/types'
import { act, api, toast, useData } from '../lib/api'
import { cx } from './ui'

/** Project-header git actions: one click to init a repo, one click to push to a remembered repository link. */
export function GitControls({ project }: { project: Project }): React.JSX.Element | null {
  const { data: status, reload } = useData(() => api.git.status(project.id).catch(() => null), [project.id, project.folder], { throttleMs: 4000 })
  const [open, setOpen] = useState(false)
  const [editingUrl, setEditingUrl] = useState(false)
  const [url, setUrl] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState<'' | 'init' | 'push'>('')
  const wrapRef = useRef<HTMLDivElement>(null)

  const saved = status?.savedRemoteUrl ?? ''
  useEffect(() => {
    setUrl(saved)
    setEditingUrl(!saved)
  }, [saved, project.id])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  if (!project.folder || status === undefined) return null
  if (status === null) return null

  const init = async (): Promise<void> => {
    setBusy('init')
    const r = await act(api.git.init(project.id), 'Git repository created with an initial commit')
    setBusy('')
    if (r) reload()
  }

  const push = async (): Promise<void> => {
    if (!url.trim()) return toast('Paste the repository link first', true)
    setBusy('push')
    const r = await act(api.git.push(project.id, url.trim(), message.trim() || undefined))
    setBusy('')
    if (r) {
      toast(`Pushed ${r.pushed}`)
      setMessage('')
      setEditingUrl(false)
      setOpen(false)
      reload()
    }
  }

  if (!status.isRepo) {
    return (
      <button type="button" onClick={init} disabled={busy === 'init'} className="btn h-7 px-2.5 text-[11.5px]" title="git init + .gitignore + initial commit">
        {busy === 'init' ? <Loader2 size={12} className="animate-spin" /> : <GitCommitHorizontal size={12} className="text-emerald-400" />}
        Init Git repo
      </button>
    )
  }

  return (
    <div ref={wrapRef} className="relative flex items-center gap-1.5">
      <span className="chip h-7 cursor-default px-2.5 font-mono text-[11px]" title={status.upstream ? `Tracking ${status.upstream}` : 'No upstream yet'}>
        <GitBranch size={11} className="text-emerald-400" />
        {status.branch || 'main'}
        {status.dirtyFiles > 0 && <span className="text-amber-300">· {status.dirtyFiles} changed</span>}
        {status.ahead > 0 && <span className="text-sky-300">· ↑{status.ahead}</span>}
      </span>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cx('btn h-7 px-2.5 text-[11.5px]', open && 'border-indigo-400/40 bg-indigo-500/15')}
        title={saved ? `Push to ${saved}` : 'Push to a repository link'}
      >
        <ArrowUpFromLine size={12} className="text-indigo-300" /> Push
      </button>

      {open && (
        <div className="glass-float pop-in absolute top-9 right-0 z-[60] w-[380px] space-y-3 rounded-xl p-3.5">
          <div className="eyebrow">Push {project.name}</div>

          <div>
            <span className="label">Repository link</span>
            {editingUrl ? (
              <div className="flex gap-1.5">
                <input
                  className="input h-8 font-mono text-[12px]"
                  value={url}
                  autoFocus
                  placeholder="https://github.com/you/repo"
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && push()}
                />
                {saved && (
                  <button type="button" className="btn btn-ghost h-8 px-2 text-[11.5px]" onClick={() => (setUrl(saved), setEditingUrl(false))}>
                    Cancel
                  </button>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded-lg border border-white/[0.08] bg-black/25 px-2.5 py-1.5">
                <Link2 size={12} className="shrink-0 text-zinc-400" />
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-zinc-200" title={saved}>
                  {saved}
                </span>
                <button
                  type="button"
                  onClick={() => setEditingUrl(true)}
                  className="inline-flex cursor-pointer items-center gap-1 text-[11px] text-indigo-300 hover:text-indigo-200"
                >
                  <Pencil size={10} /> Change
                </button>
              </div>
            )}
            <p className="muted mt-1 text-[10.5px]">Saved for this project — used for every push until you change it.</p>
          </div>

          {status.dirtyFiles > 0 && (
            <div>
              <span className="label">Commit message ({status.dirtyFiles} changed files will be committed)</span>
              <input
                className="input h-8 text-[12.5px]"
                value={message}
                placeholder="Update from AI Hub"
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && push()}
              />
            </div>
          )}

          <div className="flex items-center justify-between gap-2">
            <span className="muted text-[11px]">
              {status.branch || 'main'} → origin/{status.branch || 'main'}
            </span>
            <button type="button" onClick={push} disabled={busy === 'push' || !url.trim()} className="btn btn-primary h-8 px-3 text-[12px]">
              {busy === 'push' ? <Loader2 size={13} className="animate-spin" /> : <ArrowUpFromLine size={13} />}
              {status.dirtyFiles > 0 ? 'Commit & Push' : 'Push'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
