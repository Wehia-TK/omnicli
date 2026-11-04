import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUpCircle, Check, GitCommit, Loader2, RefreshCw, RotateCw } from 'lucide-react'
import type { UpdateInfo } from '@shared/types'
import { api, toast } from '../lib/api'
import { relative } from '../lib/dates'
import { cx, Modal } from './ui'

/** Local change checks are cheap (file mtimes + git); fetching the remote is not, so it runs less often. */
const LOCAL_CHECK_MS = 60_000
const REMOTE_CHECK_MS = 15 * 60_000

/** Signature of what's pending, so the "update available" toast fires once per new change, not every poll. */
const signature = (u: UpdateInfo): string =>
  [u.commit, u.changedFiles.join(','), u.localCommits.length, u.remoteCommits.map((c) => c.hash).join(',')].join('|')

/** Title-bar button: checks whether the app's own source changed since launch and offers to restart into it. */
export function UpdateButton(): React.JSX.Element {
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [checking, setChecking] = useState(false)
  const [open, setOpen] = useState(false)
  const announced = useRef('')
  const lastRemote = useRef(0)

  const check = useCallback(async (manual: boolean): Promise<UpdateInfo | null> => {
    setChecking(true)
    try {
      const fetchRemote = manual || Date.now() - lastRemote.current > REMOTE_CHECK_MS
      if (fetchRemote) lastRemote.current = Date.now()
      const res = await api.updates.check(fetchRemote)
      setInfo(res)
      if (res.available) {
        const sig = signature(res)
        if (!manual && sig !== announced.current) toast('An update for Omni CLI is available — click the update button to restart into it')
        announced.current = sig
      } else if (manual) {
        toast(res.supported ? 'Omni CLI is up to date' : res.reason)
      }
      return res
    } catch (e) {
      if (manual) toast((e as Error).message || 'Could not check for updates', true)
      return null
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    void check(false)
    const t = setInterval(() => void check(false), LOCAL_CHECK_MS)
    const onFocus = (): void => void check(false)
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(t)
      window.removeEventListener('focus', onFocus)
    }
  }, [check])

  const available = Boolean(info?.available)
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true)
          void check(true)
        }}
        className={cx(
          'btn h-7 text-[11.5px]',
          available ? 'border-emerald-400/40 bg-emerald-500/15 px-2.5 text-emerald-200' : 'btn-ghost btn-icon w-7'
        )}
        title={available ? 'Update available — click to review and restart' : 'Check for updates'}
      >
        {available ? (
          <>
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
            </span>
            Update
          </>
        ) : checking && open ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <ArrowUpCircle size={13} />
        )}
      </button>
      {open && <UpdateModal info={info} checking={checking} onRecheck={() => void check(true)} onClose={() => setOpen(false)} />}
    </>
  )
}

function UpdateModal({
  info,
  checking,
  onRecheck,
  onClose
}: {
  info: UpdateInfo | null
  checking: boolean
  onRecheck: () => void
  onClose: () => void
}): React.JSX.Element {
  const [applying, setApplying] = useState(false)
  const [steps, setSteps] = useState<string[]>([])
  const [error, setError] = useState('')

  const apply = async (): Promise<void> => {
    setApplying(true)
    setError('')
    setSteps(['Checking the new code (pull, dependencies, typecheck)…'])
    try {
      const res = await api.updates.apply()
      setSteps(res.steps)
    } catch (e) {
      setError((e as Error).message || 'Update failed')
      setSteps([])
      setApplying(false)
    }
  }

  const restartCount = info ? info.changedFiles.length + info.localCommits.length + info.remoteCommits.length : 0

  return (
    <Modal
      title={
        <span className="flex items-center gap-2">
          <ArrowUpCircle size={16} className={info?.available ? 'text-emerald-400' : 'text-zinc-400'} />
          {info?.available ? 'Update available' : 'Updates'}
        </span>
      }
      onClose={applying ? () => undefined : onClose}
      width="max-w-xl"
      footer={
        <>
          <button type="button" className="btn h-8 text-[12px]" onClick={onRecheck} disabled={checking || applying}>
            <RefreshCw size={12} className={checking ? 'animate-spin' : ''} /> Check again
          </button>
          <div className="flex-1" />
          <button type="button" className="btn h-8 text-[12px]" onClick={onClose} disabled={applying}>
            {info?.available ? 'Later' : 'Close'}
          </button>
          {info?.available && (
            <button type="button" className="btn btn-primary h-8 text-[12px]" onClick={() => void apply()} disabled={applying}>
              {applying ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />}
              {applying ? 'Updating…' : 'Update & restart'}
            </button>
          )}
        </>
      }
    >
      {!info ? (
        <div className="flex items-center gap-2 py-6 text-[12.5px] text-zinc-400">
          <Loader2 size={14} className="animate-spin" /> Checking for changes…
        </div>
      ) : !info.supported ? (
        <p className="text-[12.5px] leading-relaxed text-zinc-400">{info.reason}</p>
      ) : (
        <div className="space-y-4 text-[12.5px]">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-zinc-500">
            <span>
              Running <span className="font-mono text-zinc-300">{info.commit || '—'}</span>
              {info.branch && (
                <>
                  {' '}
                  on <span className="font-mono text-zinc-300">{info.branch}</span>
                </>
              )}
            </span>
            <span>Launched {relative(new Date(info.launchedAt).toISOString())}</span>
            <span>Checked {relative(new Date(info.checkedAt).toISOString())}</span>
          </div>

          {!info.available ? (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-400/20 bg-emerald-500/[0.07] px-3 py-2.5 text-emerald-200">
              <Check size={14} /> Omni CLI is up to date — no changes to its code since it was launched
              {info.remote ? ` and nothing new on ${info.remote}` : ''}.
            </div>
          ) : (
            <p className="leading-relaxed text-zinc-300">
              {restartCount === 1 ? 'One change needs' : `${restartCount} changes need`} a restart to take effect. Updating will
              {info.remoteCommits.length ? ' pull the new commits,' : ''} install dependencies if they changed, verify the code
              compiles, then restart Omni CLI. Running sessions are stopped by the restart.
            </p>
          )}

          {info.remoteCommits.length > 0 && (
            <Section title={`New on ${info.remote}`}>
              {info.remoteCommits.map((c) => (
                <CommitRow key={c.hash} {...c} />
              ))}
            </Section>
          )}
          {info.localCommits.length > 0 && (
            <Section title="Committed since launch">
              {info.localCommits.map((c) => (
                <CommitRow key={c.hash} {...c} />
              ))}
            </Section>
          )}
          {info.changedFiles.length > 0 && (
            <Section title="Edited since launch (needs restart)">
              <FileList files={info.changedFiles} />
            </Section>
          )}
          {info.liveFiles.length > 0 && (
            <Section title="UI changes (already live)">
              <FileList files={info.liveFiles} muted />
            </Section>
          )}

          {steps.length > 0 && (
            <div className="space-y-1 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-[11.5px] text-zinc-300">
              {steps.map((s) => (
                <div key={s} className="flex items-center gap-2">
                  <Check size={11} className="text-emerald-400" /> {s}
                </div>
              ))}
            </div>
          )}
          {error && (
            <pre className="max-h-48 overflow-auto rounded-lg border border-rose-400/25 bg-rose-500/[0.08] px-3 py-2 text-[11.5px] whitespace-pre-wrap text-rose-200">
              {error}
            </pre>
          )}
        </div>
      )}
    </Modal>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      <div className="mb-1.5 text-[10.5px] font-semibold tracking-wide text-zinc-500 uppercase">{title}</div>
      <div className="max-h-40 space-y-0.5 overflow-y-auto">{children}</div>
    </div>
  )
}

function CommitRow({ hash, subject }: { hash: string; subject: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 text-zinc-300">
      <GitCommit size={12} className="shrink-0 text-zinc-500" />
      <span className="font-mono text-[11px] text-zinc-500">{hash}</span>
      <span className="truncate">{subject}</span>
    </div>
  )
}

function FileList({ files, muted }: { files: string[]; muted?: boolean }): React.JSX.Element {
  const shown = files.slice(0, 40)
  return (
    <>
      {shown.map((f) => (
        <div key={f} className={cx('truncate font-mono text-[11px]', muted ? 'text-zinc-500' : 'text-zinc-300')}>
          {f}
        </div>
      ))}
      {files.length > shown.length && <div className="text-[11px] text-zinc-500">…and {files.length - shown.length} more</div>}
    </>
  )
}
