import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { createRequire } from 'node:module'
import type { CliId, TerminalOutputEvent } from '@shared/types'
import { findCliExecutable } from './clis'

type TerminalListener = (ev: TerminalOutputEvent) => void

/** Minimal surface of node-pty we use (loaded lazily so a missing native module never breaks the app). */
interface Pty {
  pid: number
  write: (d: string) => void
  resize: (cols: number, rows: number) => void
  kill: () => void
  onData: (cb: (d: string) => void) => void
  onExit: (cb: (e: { exitCode: number }) => void) => void
}
type PtyModule = { spawn: (file: string, args: string[], opts: Record<string, unknown>) => Pty }

let ptyModule: PtyModule | null | undefined
function loadPty(): PtyModule | null {
  if (ptyModule !== undefined) return ptyModule
  try {
    ptyModule = createRequire(__filename)('@lydell/node-pty') as PtyModule
  } catch {
    ptyModule = null
  }
  return ptyModule
}

type Session = { cwd: string; pty?: Pty; proc?: ChildProcess }
const sessions = new Map<string, Session>()
let emitter: TerminalListener = () => undefined

export function initTerminal(onOutput: TerminalListener): void {
  emitter = onOutput
}

const isWin = process.platform === 'win32'
const defaultShell = isWin ? 'powershell.exe' : (process.env.SHELL || '/bin/zsh')
const shellArgs = isWin ? ['-NoLogo'] : ['-l']

const killTree = (pid?: number): void => {
  if (!pid) return
  if (isWin) {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // ignore
      }
    }
  }
}

function close(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (!s) return
  sessions.delete(sessionId)
  if (s.pty) {
    try {
      s.pty.kill()
    } catch {
      killTree(s.pty.pid)
    }
  } else killTree(s.proc?.pid)
}

export function stopAllTerminals(): void {
  for (const id of [...sessions.keys()]) close(id)
}

const psq = (s: string): string => `'${s.replace(/'/g, "''")}'`

const TERMINAL_CLIS: CliId[] = ['claude', 'agy', 'codex', 'copilot']

/**
 * The CLIs Omni CLI detected aren't always on the user's PATH (e.g. Claude Code bundled with the desktop app,
 * or a custom path in Settings), so typing `claude login` in the embedded terminal would fail.
 * Prepend each detected CLI's folder to PATH for terminal sessions.
 */
function shellEnv(extraEnv: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...extraEnv }
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const sep = isWin ? ';' : ':'
  const current = (env[pathKey] ?? '').split(sep).filter(Boolean)
  const norm = (p: string): string => (isWin ? p.toLowerCase() : p).replace(/[\\/]+$/, '')
  const known = new Set(current.map(norm))
  const extra: string[] = []
  for (const cli of TERMINAL_CLIS) {
    const exe = findCliExecutable(cli)
    if (!exe) continue
    const dir = dirname(exe)
    if (!known.has(norm(dir))) {
      known.add(norm(dir))
      extra.push(dir)
    }
  }
  env[pathKey] = [...extra, ...current].join(sep)
  return env
}

export const terminal = {
  /** True when a real pseudo-terminal is available — interactive TUIs and logins render correctly. */
  isPty: (): boolean => Boolean(loadPty()),

  /** Start or restart an interactive shell session in `cwd`. */
  start: (sessionId: string, cwd: string, initialCommand?: string, cols = 120, rows = 30, extraEnv: Record<string, string> = {}): { sessionId: string; cwd: string; pty: boolean } => {
    close(sessionId)
    const workDir = cwd && existsSync(cwd) ? cwd : process.cwd()
    const pty = loadPty()

    if (pty) {
      const term = pty.spawn(defaultShell, shellArgs, {
        name: 'xterm-256color',
        cols: Math.max(20, cols),
        rows: Math.max(5, rows),
        cwd: workDir,
        env: { ...shellEnv(extraEnv), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        ...(isWin ? { useConpty: true } : {})
      })
      sessions.set(sessionId, { cwd: workDir, pty: term })
      term.onData((data) => emitter({ sessionId, stream: 'stdout', data }))
      term.onExit(({ exitCode }) => {
        if (sessions.get(sessionId)?.pty === term) sessions.delete(sessionId)
        emitter({ sessionId, stream: 'system', data: `\r\n[Process exited with code ${exitCode}]\r\n`, exitCode })
      })
      if (initialCommand?.trim()) setTimeout(() => term.write(`${initialCommand.trim()}\r`), 400)
      return { sessionId, cwd: workDir, pty: true }
    }

    // Fallback: plain pipes (no TUI support)
    const proc = isWin
      ? spawn('powershell.exe', ['-NoLogo', '-NoExit', '-Command', '-'], { cwd: workDir, windowsHide: true, env: { ...shellEnv(extraEnv), TERM: 'xterm-256color' } })
      : spawn(defaultShell, ['-i'], { cwd: workDir, env: { ...shellEnv(extraEnv), TERM: 'xterm-256color' } })
    sessions.set(sessionId, { cwd: workDir, proc })
    emitter({ sessionId, stream: 'system', data: `Connected to ${isWin ? 'PowerShell' : defaultShell} in ${workDir} (basic mode)\r\n` })
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (data: string) => emitter({ sessionId, stream: 'stdout', data: data.replace(/\r?\n/g, '\r\n') }))
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (data: string) => emitter({ sessionId, stream: 'stderr', data: data.replace(/\r?\n/g, '\r\n') }))
    proc.on('close', (code) => {
      if (sessions.get(sessionId)?.proc === proc) sessions.delete(sessionId)
      emitter({ sessionId, stream: 'system', data: `\r\n[Process exited with code ${code ?? 0}]\r\n`, exitCode: code })
    })
    proc.stdin?.write(`${initialCommand?.trim() || (isWin ? 'Write-Output "Ready ($(Get-Location))"' : 'echo "Ready ($(pwd))"')}\r\n`)
    return { sessionId, cwd: workDir, pty: false }
  },

  /** Raw keystrokes from the terminal view (PTY mode), or a full line in basic mode. */
  write: (sessionId: string, data: string): true => {
    const s = sessions.get(sessionId)
    if (s?.pty) s.pty.write(data)
    else if (s?.proc) {
      // basic mode: echo and forward on Enter
      emitter({ sessionId, stream: 'stdout', data: data === '\r' ? '\r\n' : data })
      s.proc.stdin?.write(data === '\r' ? '\r\n' : data)
    }
    return true
  },

  /** Run a command line (shortcut buttons). */
  send: (sessionId: string, input: string, cwd?: string): true => {
    const s = sessions.get(sessionId)
    if (!s) {
      terminal.start(sessionId, cwd || process.cwd(), input)
      return true
    }
    if (s.pty) s.pty.write(`${input.trim()}\r`)
    else s.proc?.stdin?.write(`${input.trim()}\r\n`)
    return true
  },

  resize: (sessionId: string, cols: number, rows: number): true => {
    const s = sessions.get(sessionId)
    try {
      s?.pty?.resize(Math.max(20, Math.floor(cols)), Math.max(5, Math.floor(rows)))
    } catch {
      // ignore resize races
    }
    return true
  },

  /** Ctrl+C the running command (PTY) or stop the session. */
  stop: (sessionId: string): true => {
    const s = sessions.get(sessionId)
    if (s?.pty) s.pty.write('\x03')
    else if (s) {
      close(sessionId)
      emitter({ sessionId, stream: 'system', data: '\r\n[Terminal stopped]\r\n' })
    }
    return true
  },

  /** Launch a CLI interactive TUI or login flow in a dedicated console window when needed. */
  openExternalCli: (cli: CliId, cwd: string, extraArgs = ''): true => {
    const exe = findCliExecutable(cli) || cli
    const folder = cwd && existsSync(cwd) ? cwd : process.cwd()

    if (process.platform === 'darwin') {
      // AppleScript string literal; `quoted form of` then makes each value a single safe shell word
      const as = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
      const script = `tell application "Terminal"
        activate
        do script "cd " & quoted form of ${as(folder)} & " && " & quoted form of ${as(exe)} & ${as(extraArgs ? ` ${extraArgs}` : '')}
      end tell`
      const child = spawn('osascript', ['-e', script], { stdio: 'ignore' })
      child.unref()
      return true
    }

    const cmdLine = `& ${psq(exe)} ${extraArgs}`.trim()
    const script = [`Set-Location -LiteralPath ${psq(folder)}`, `$host.UI.RawUI.WindowTitle = ${psq(`Omni CLI — ${cli.toUpperCase()} (${folder})`)}`, cmdLine].join('; ')
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const child = spawn('cmd.exe', ['/d', '/s', '/c', `"start "Omni CLI" powershell.exe -NoExit -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}"`], {
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true
    })
    child.unref()
    return true
  }
}
