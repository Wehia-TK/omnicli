import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { ExternalLink, Play, RotateCcw, Square, Terminal as TerminalIcon, Trash2 } from 'lucide-react'
import type { CliId, CliSubscriptionStatus, TerminalOutputEvent } from '@shared/types'
import { act, api } from '../lib/api'
import { cx } from './ui'

interface EmbeddedTerminalProps {
  sessionId: string
  cwd: string
  clis: CliSubscriptionStatus[]
  initialCommand?: string
  /** Start the session as this saved account's CLI login (its own config folder) instead of a plain shell */
  loginAccountId?: number
  onClose?: () => void
}

/** A real terminal (xterm.js on a ConPTY): colours, cursor movement, interactive logins and TUIs all work. */
export function EmbeddedTerminal({ sessionId, cwd, clis, initialCommand, loginAccountId, onClose }: EmbeddedTerminalProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    if (!hostRef.current || !window.aihub) return
    const term = new XTerm({
      fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
      fontSize: 12.5,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      theme: {
        background: '#00000000',
        foreground: '#e7e8ea',
        cursor: '#a5b4fc',
        selectionBackground: '#6366f155',
        black: '#1f2125',
        brightBlack: '#4b4e56',
        red: '#f87171',
        green: '#34d399',
        yellow: '#fbbf24',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#e7e8ea'
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current)
    termRef.current = term
    fitRef.current = fit
    const doFit = (): void => {
      try {
        fit.fit()
        api.terminal.resize(sessionId, term.cols, term.rows)
      } catch {
        // not visible yet
      }
    }
    requestAnimationFrame(doFit)

    const off = window.aihub.onTerminalOutput((ev: TerminalOutputEvent) => {
      if (ev.sessionId !== sessionId) return
      term.write(ev.stream === 'stderr' ? `\x1b[31m${ev.data}\x1b[0m` : ev.stream === 'system' ? `\x1b[38;5;111m${ev.data}\x1b[0m` : ev.data)
    })
    const input = term.onData((d) => api.terminal.write(sessionId, d))
    const ro = new ResizeObserver(() => doFit())
    ro.observe(hostRef.current)

    if (loginAccountId) void api.accounts.login(loginAccountId, sessionId, term.cols, term.rows)
    else api.terminal.start(sessionId, cwd, initialCommand, term.cols, term.rows)

    return () => {
      off()
      input.dispose()
      ro.disconnect()
      term.dispose()
    }
    // re-create only when the terminal session or folder changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, cwd])

  // A new login command while the panel is open (e.g. "Authenticate" clicked)
  useEffect(() => {
    if (initialCommand && termRef.current) api.terminal.send(sessionId, initialCommand, cwd)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCommand])

  const run = (cmd: string): void => {
    api.terminal.send(sessionId, cmd, cwd)
    termRef.current?.focus()
  }

  return (
    <div className="card terminal-surface flex h-full flex-col overflow-hidden rounded-xl bg-black/45">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.08] bg-white/[0.03] px-3.5 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <TerminalIcon size={14} className="shrink-0 text-emerald-400" />
          <span className="text-[12.5px] font-semibold text-zinc-200">Terminal</span>
          <span className="truncate rounded bg-white/[0.06] px-2 py-0.5 font-mono text-[11px] text-zinc-400">{cwd || 'workspace'}</span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {clis.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => run(c.authenticated ? (c.id === 'agy' ? 'agy' : c.id) : c.loginCommand)}
              title={c.authenticated ? `Start ${c.name} interactively` : `Run '${c.loginCommand}' to sign in`}
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
            title="Open Claude in a separate console window"
            className="btn btn-ghost h-6 px-2 text-[11px]"
          >
            <ExternalLink size={11} /> Pop out
          </button>
          <button
            type="button"
            onClick={() => {
              termRef.current?.reset()
              const t = termRef.current
              if (loginAccountId) void api.accounts.login(loginAccountId, sessionId, t?.cols, t?.rows)
              else api.terminal.start(sessionId, cwd, undefined, t?.cols, t?.rows)
            }}
            title="Restart terminal"
            className="btn btn-ghost btn-icon h-6 w-6"
          >
            <RotateCcw size={12} />
          </button>
          <button type="button" onClick={() => termRef.current?.clear()} title="Clear" className="btn btn-ghost btn-icon h-6 w-6">
            <Trash2 size={12} />
          </button>
          <button type="button" onClick={() => api.terminal.stop(sessionId)} title="Interrupt (Ctrl+C)" className="btn btn-ghost btn-icon h-6 w-6 text-red-400">
            <Square size={11} />
          </button>
          {onClose && (
            <button type="button" onClick={onClose} className="btn btn-ghost h-6 px-2 text-[11px]">
              Hide
            </button>
          )}
        </div>
      </div>
      <div ref={hostRef} className="selectable min-h-0 flex-1 px-2 py-1.5" />
    </div>
  )
}
