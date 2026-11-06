import { execFile, spawn, type ChildProcess, type ExecFileOptions, type SpawnOptions } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Safe launching of AI CLIs that may be Windows batch shims (npm installs `claude.cmd`, `codex.cmd`, `copilot.cmd`).
 *
 * Node refuses to start .cmd/.bat files without a shell (CVE-2024-27980), and going through cmd.exe with naive
 * quoting lets a prompt containing `"` + `&` run arbitrary commands, while newlines silently cut the prompt off.
 * So, in order of preference:
 *  1. not a batch file → run it directly, no shell;
 *  2. an npm cmd-shim → run the JS entry point (or native .exe) it wraps directly, no shell;
 *  3. anything else → cmd.exe with full CommandLineToArgvW + cmd metacharacter escaping (newlines become spaces,
 *     since cmd.exe cannot carry them).
 */

const isWin = process.platform === 'win32'
const isBatch = (file: string): boolean => isWin && /\.(cmd|bat)$/i.test(file)

type Resolved = { file: string; args: string[]; verbatim: boolean }

/** npm cmd-shim ends with: "%_prog%"  "%dp0%\node_modules\pkg\cli.js" %*   (or "%dp0%\...\tool.exe" %*). */
function resolveNpmShim(shim: string, args: string[]): Resolved | null {
  let src: string
  try {
    src = readFileSync(shim, 'utf8')
  } catch {
    return null
  }
  const m = src.match(/"%~?dp0%?\\([^"%]+)"\s+%\*/i)
  if (!m) return null
  const target = resolve(dirname(shim), m[1])
  if (!existsSync(target)) return null
  if (/\.exe$/i.test(target)) return { file: target, args, verbatim: false }
  const localNode = join(dirname(shim), 'node.exe')
  return { file: existsSync(localNode) ? localNode : 'node', args: [target, ...args], verbatim: false }
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g

/** Quote one argument for CommandLineToArgvW, then escape cmd.exe metacharacters (twice: cmd + the batch file's %*). */
export function quoteCmdArg(arg: string): string {
  let a = arg.replace(/\r?\n/g, ' ')
  a = a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')
  return `"${a}"`.replace(CMD_META, '^$1').replace(CMD_META, '^$1')
}

export function resolveCliCommand(exe: string, args: string[]): Resolved {
  if (!isBatch(exe)) return { file: exe, args, verbatim: false }
  const shim = resolveNpmShim(exe, args)
  if (shim) return shim
  const line = [exe.replace(CMD_META, '^$1'), ...args.map(quoteCmdArg)].join(' ')
  return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true }
}

/** `spawn` for a CLI executable without ever exposing its arguments to shell parsing. */
export function spawnCli(exe: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
  const r = resolveCliCommand(exe, args)
  return spawn(r.file, r.args, { ...opts, shell: false, windowsVerbatimArguments: r.verbatim })
}

/** `execFile` for a CLI executable (same rules as spawnCli). */
export function execCli(
  exe: string,
  args: string[],
  opts: ExecFileOptions,
  cb: (err: Error | null, stdout: string, stderr: string) => void
): ChildProcess {
  const r = resolveCliCommand(exe, args)
  return execFile(r.file, r.args, { ...opts, encoding: 'utf8', shell: false, windowsVerbatimArguments: r.verbatim }, (err, out, errOut) =>
    cb(err, String(out ?? ''), String(errOut ?? ''))
  )
}
