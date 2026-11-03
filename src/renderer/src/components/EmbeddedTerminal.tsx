import { useEffect, useRef, useState } from 'react'
import { ExternalLink, Play, RotateCcw, Square, Terminal as TerminalIcon, Trash2 } from 'lucide-react'
import type { CliId, CliSubscriptionStatus, TerminalOutputEvent } from '@shared/types'
import { act, api } from '../lib/api'
import { cx } from './ui'

interface EmbeddedTerminalProps {
  sessionId: string
  cwd: string
  clis: CliSubscriptionStatus[]
  initialCommand?: string
  onClose?: () => void
}

export function EmbeddedTerminal({
  sessionId,
  cwd,
  clis,
  initialCommand,
  onClose
}: EmbeddedTerminalProps): React.JSX.Element {
  const [lines, setLines] = useState<{ stream: 'stdout' | 'stderr' | 'system'; text: string }[]>([])
  const [input, setInput] = useState('')
  const [started, setStarted] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!window.aihub) return
    const off = window.aihub.onTerminalOutput((ev: TerminalOutputEvent) => {
      if (ev.sessionId !== sessionId) return
      const clean = ev.data.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      setLines((prev) => [...prev.slice(-600), { stream: ev.stream, text: clean }])
    })
    return off
  }, [sessionId])

  useEffect(() => {
    if (!started && cwd) {
      setStarted(true)
      api.terminal.start(sessionId, cwd, initialCommand)
    }
  }, [started, sessionId, cwd, initialCommand])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [lines])

  const sendCmd = async (cmd?: string): Promise<void> => {
    const toSend = (cmd ?? input).trim()
    if (!toSend) return
    if (cmd === undefined) setInput('')
    await api.terminal.send(sessionId, toSend, cwd)
  }

  return (
    <div className="flex h-full flex-col overflow-hidden card rounded-xl bg-black/40">
      {/* Terminal Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.08] bg-white/[0.03] px-3.5 py-2">
        <div className="flex items-center gap-2">
          <TerminalIcon size={14} className="text-emerald-400" />
          <span className="text-[12.5px] font-semibold text-zinc-200">Embedded CLI Terminal</span>
          <span className="rounded bg-white/[0.06] px-2 py-0.5 font-mono text-[11px] text-zinc-400">{cwd || 'workspace'}</span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {/* Quick CLI Launch / Auth Shortcuts */}
          {clis.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => sendCmd(c.authenticated ? `${c.id === 'claude' ? 'claude --version' : c.id === 'agy' ? 'agy --version' : c.loginCommand}` : c.loginCommand)}
              title={c.authenticated ? `Check ${c.name} in terminal` : `Run '${c.loginCommand}' to sign in`}
              className={cx(
                'inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors',
                c.authenticated
                  ? 'border-white/[0.08] bg-white/[0.04] text-zinc-300 hover:bg-white/[0.1]'
                  : 'border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20'
              )}
            >
              <Play size={10} />
              <span>{c.authenticated ? c.id : c.loginCommand}</span>
            </button>
          ))}

          <button
            type="button"
            onClick={() => act(api.terminal.openExternalCli('claude' as CliId, cwd))}
            title="Open full interactive TUI in external console window"
            className="btn btn-ghost h-6 px-2 text-[11px]"
          >
            <ExternalLink size={11} /> Pop-out TUI
          </button>

          <button
            type="button"
            onClick={() => {
              setLines([])
              api.terminal.start(sessionId, cwd)
            }}
            title="Restart terminal session"
            className="btn btn-ghost btn-icon h-6 w-6"
          >
            <RotateCcw size={12} />
          </button>

          <button
            type="button"
            onClick={() => setLines([])}
            title="Clear output"
            className="btn btn-ghost btn-icon h-6 w-6"
          >
            <Trash2 size={12} />
          </button>

          <button
            type="button"
            onClick={() => api.terminal.stop(sessionId)}
            title="Stop running command"
            className="btn btn-ghost btn-icon h-6 w-6 text-red-400"
          >
            <Square size={11} />
          </button>

          {onClose && (
            <button type="button" onClick={onClose} className="btn btn-ghost h-6 px-2 text-[11px]">
              Hide
            </button>
          )}
        </div>
      </div>

      {/* Terminal Output Stream */}
      <div ref={scrollRef} className="selectable flex-1 overflow-y-auto p-3.5 font-mono text-[12px] leading-relaxed">
        {lines.length === 0 ? (
          <p className="text-zinc-500">Starting embedded PowerShell session in {cwd}…</p>
        ) : (
          lines.map((l, idx) => (
            <pre
              key={idx}
              className={cx(
                'whitespace-pre-wrap break-words font-mono',
                l.stream === 'stderr' ? 'text-red-400' : l.stream === 'system' ? 'text-indigo-400' : 'text-zinc-200'
              )}
            >
              {l.text}
            </pre>
          ))
        )}
      </div>

      {/* Command Input Bar */}
      <div className="flex items-center gap-2 border-t border-white/[0.08] bg-white/[0.02] px-3.5 py-2">
        <span className="font-mono text-[12.5px] font-bold text-emerald-400">PS &gt;</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && sendCmd()}
          placeholder="Run any CLI or shell command (e.g., agy models, claude login, codex login, git status)…"
          className="flex-1 bg-transparent font-mono text-[12.5px] text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
        />
        <button type="button" onClick={() => sendCmd()} className="btn h-7 px-2.5 text-[11.5px]">
          Run
        </button>
      </div>
    </div>
  )
}
