import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { CliId, TerminalOutputEvent } from '@shared/types'
import { findCliExecutable } from './clis'

type TerminalListener = (ev: TerminalOutputEvent) => void

const sessions = new Map<string, { proc: ChildProcess; cwd: string }>()
let emitter: TerminalListener = () => undefined

export function initTerminal(onOutput: TerminalListener): void {
  emitter = onOutput
}

export function stopAllTerminals(): void {
  for (const s of sessions.values()) {
    if (s.proc.pid) spawnSync('taskkill', ['/pid', String(s.proc.pid), '/T', '/F'], { windowsHide: true })
  }
  sessions.clear()
}

const psq = (s: string): string => `'${s.replace(/'/g, "''")}'`

export const terminal = {
  /** Start or restart an embedded PowerShell session in `cwd`. */
  start: (sessionId: string, cwd: string, initialCommand?: string): { sessionId: string; cwd: string } => {
    const existing = sessions.get(sessionId)
    if (existing) {
      if (existing.proc.pid) spawnSync('taskkill', ['/pid', String(existing.proc.pid), '/T', '/F'], { windowsHide: true })
      sessions.delete(sessionId)
    }

    const workDir = cwd && existsSync(cwd) ? cwd : process.cwd()
    const proc = spawn('powershell.exe', ['-NoLogo', '-NoExit', '-Command', '-'], {
      cwd: workDir,
      windowsHide: true,
      env: { ...process.env, TERM: 'xterm-256color' }
    })

    sessions.set(sessionId, { proc, cwd: workDir })

    emitter({
      sessionId,
      stream: 'system',
      data: `Connected to embedded PowerShell in ${workDir}\n`
    })

    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (data: string) => {
      emitter({ sessionId, stream: 'stdout', data })
    })

    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (data: string) => {
      emitter({ sessionId, stream: 'stderr', data })
    })

    proc.on('close', (code) => {
      sessions.delete(sessionId)
      emitter({
        sessionId,
        stream: 'system',
        data: `\n[Process exited with code ${code ?? 0}]\n`,
        exitCode: code
      })
    })

    if (initialCommand?.trim()) {
      proc.stdin?.write(`${initialCommand.trim()}\r\n`)
    } else {
      proc.stdin?.write(`Write-Output "Ready ($(Get-Location))"\r\n`)
    }

    return { sessionId, cwd: workDir }
  },

  /** Send a command or line of input to an active embedded terminal session. */
  send: (sessionId: string, input: string, cwd?: string): true => {
    let sess = sessions.get(sessionId)
    if (!sess) {
      terminal.start(sessionId, cwd || process.cwd(), input)
      return true
    }
    emitter({ sessionId, stream: 'system', data: `$ ${input.trim()}\n` })
    sess.proc.stdin?.write(`${input.trim()}\r\n`)
    return true
  },

  /** Stop an embedded terminal session. */
  stop: (sessionId: string): true => {
    const sess = sessions.get(sessionId)
    if (sess) {
      if (sess.proc.pid) spawnSync('taskkill', ['/pid', String(sess.proc.pid), '/T', '/F'], { windowsHide: true })
      sessions.delete(sessionId)
      emitter({ sessionId, stream: 'system', data: '\n[Terminal stopped]\n' })
    }
    return true
  },

  /** Launch a CLI interactive TUI or login flow in a dedicated console window when needed. */
  openExternalCli: (cli: CliId, cwd: string, extraArgs = ''): true => {
    const exe = findCliExecutable(cli) || cli
    const folder = cwd && existsSync(cwd) ? cwd : process.cwd()
    const cmdLine = `& ${psq(exe)} ${extraArgs}`.trim()
    const script = [
      `Set-Location -LiteralPath ${psq(folder)}`,
      `$host.UI.RawUI.WindowTitle = ${psq(`AI Hub — ${cli.toUpperCase()} (${folder})`)}`,
      cmdLine
    ].join('; ')
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const child = spawn(
      'cmd.exe',
      ['/d', '/s', '/c', `"start "AI Hub CLI" powershell.exe -NoExit -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}"`],
      {
        stdio: 'ignore',
        windowsHide: true,
        windowsVerbatimArguments: true
      }
    )
    child.unref()
    return true
  }
}
