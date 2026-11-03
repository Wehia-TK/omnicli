import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { CliId, McpServerEntry } from '@shared/types'
import { findCliExecutable } from './clis'

/**
 * One MCP server list for every CLI. Claude and Antigravity are changed through their own `mcp add/remove`
 * commands; Codex (config.toml), Gemini (settings.json) and Copilot (mcp-config.json) are edited in place,
 * touching only their MCP section.
 */

type Def = Omit<McpServerEntry, 'installedIn'>

const home = homedir()
const PATHS = {
  claude: join(home, '.claude.json'),
  gemini: join(home, '.gemini', 'settings.json'),
  copilot: join(home, '.copilot', 'mcp-config.json'),
  codex: join(home, '.codex', 'config.toml')
}

const readJson = (p: string): Record<string, unknown> => {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

const fromJsonMap = (map: unknown): Def[] =>
  Object.entries((map ?? {}) as Record<string, { type?: string; command?: string; args?: string[]; url?: string; httpUrl?: string; env?: Record<string, string> }>).map(
    ([name, v]) => ({
      name,
      type: v.url || v.httpUrl || v.type === 'http' || v.type === 'sse' ? 'http' : 'stdio',
      command: v.command,
      args: v.args,
      url: v.url ?? v.httpUrl,
      env: v.env
    })
  )

function readCodexToml(): Def[] {
  if (!existsSync(PATHS.codex)) return []
  const out: Def[] = []
  let cur: Def | null = null
  for (const line of readFileSync(PATHS.codex, 'utf8').split(/\r?\n/)) {
    const sec = line.match(/^\s*\[mcp_servers\.("?)([^\]"]+)\1\]\s*$/)
    if (sec) {
      cur = { name: sec[2], type: 'stdio' }
      out.push(cur)
      continue
    }
    if (/^\s*\[/.test(line)) {
      cur = null
      continue
    }
    if (!cur) continue
    const kv = line.match(/^\s*(\w+)\s*=\s*(.+)$/)
    if (!kv) continue
    try {
      const val = JSON.parse(kv[2].replace(/'/g, '"'))
      if (kv[1] === 'command') cur.command = val
      if (kv[1] === 'args') cur.args = val
      if (kv[1] === 'url') ((cur.url = val), (cur.type = 'http'))
    } catch {
      // ignore complex values
    }
  }
  return out
}

function listAgy(): Promise<Def[]> {
  const exe = findCliExecutable('agy')
  if (!exe) return Promise.resolve([])
  return new Promise((resolve) => {
    execFile(exe, ['mcp', 'list'], { windowsHide: true, timeout: 15_000 }, (_e, out) => {
      const defs: Def[] = []
      for (const line of (out || '').split(/\r?\n/)) {
        const m = line.trim().match(/^([\w.-]+)[\s:]+(.*)$/)
        if (m && !/^(name|no |configured|mcp)/i.test(line.trim())) defs.push({ name: m[1], type: /https?:\/\//.test(m[2]) ? 'http' : 'stdio', command: m[2].trim() })
      }
      resolve(defs)
    }).stdin?.end()
  })
}

const exec = (exe: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(exe, args, { windowsHide: true, timeout: 30_000 }, (e, out, err) => (e ? reject(new Error((err || e.message).trim().split('\n').slice(-2).join(' '))) : resolve(out))).stdin?.end()
  })

const tomlStr = (s: string): string => JSON.stringify(s)

function writeCodex(def: Def | null, name: string): void {
  const raw = existsSync(PATHS.codex) ? readFileSync(PATHS.codex, 'utf8') : ''
  const lines = raw.split(/\r?\n/)
  const out: string[] = []
  let skipping = false
  for (const line of lines) {
    const sec = line.match(/^\s*\[([^\]]+)\]\s*$/)
    if (sec) skipping = sec[1].replace(/"/g, '') === `mcp_servers.${name}` || sec[1].replace(/"/g, '').startsWith(`mcp_servers.${name}.`)
    if (!skipping) out.push(line)
  }
  if (def) {
    out.push('', `[mcp_servers.${/^[\w-]+$/.test(name) ? name : tomlStr(name)}]`)
    if (def.type === 'http') out.push(`url = ${tomlStr(def.url ?? '')}`)
    else {
      out.push(`command = ${tomlStr(def.command ?? '')}`)
      if (def.args?.length) out.push(`args = [${def.args.map(tomlStr).join(', ')}]`)
      if (def.env && Object.keys(def.env).length) out.push(`env = { ${Object.entries(def.env).map(([k, v]) => `${k} = ${tomlStr(v)}`).join(', ')} }`)
    }
  }
  mkdirSync(dirname(PATHS.codex), { recursive: true })
  writeFileSync(PATHS.codex, out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n', 'utf8')
}

function writeJsonMap(path: string, key: string, def: Def | null, name: string): void {
  const j = readJson(path)
  const map = { ...((j[key] as Record<string, unknown>) ?? {}) }
  if (def) map[name] = def.type === 'http' ? { url: def.url } : { command: def.command, args: def.args ?? [], ...(def.env ? { env: def.env } : {}) }
  else delete map[name]
  j[key] = map
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(j, null, 2), 'utf8')
}

export const mcp = {
  /** Every server configured in any CLI, merged by name, with where it's installed. */
  list: async (): Promise<McpServerEntry[]> => {
    const sources: [CliId, Def[]][] = [
      ['claude', fromJsonMap(readJson(PATHS.claude).mcpServers)],
      ['agy', await listAgy()],
      ['codex', readCodexToml()],
      ['gemini', fromJsonMap(readJson(PATHS.gemini).mcpServers)],
      ['copilot', fromJsonMap(readJson(PATHS.copilot).mcpServers)]
    ]
    const merged = new Map<string, McpServerEntry>()
    for (const [cli, defs] of sources) {
      for (const d of defs) {
        const cur = merged.get(d.name)
        if (cur) {
          if (!cur.installedIn.includes(cli)) cur.installedIn.push(cli)
          if (!cur.command && d.command) cur.command = d.command
          if (!cur.args && d.args) cur.args = d.args
        } else merged.set(d.name, { ...d, installedIn: [cli] })
      }
    }
    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))
  },

  /** Add/update one server in the chosen CLIs. */
  add: async (def: Def, targets: CliId[]): Promise<McpServerEntry[]> => {
    const name = def.name.trim()
    if (!/^[\w.-]+$/.test(name)) throw new Error('Server names may only use letters, numbers, dot, dash and underscore')
    if (def.type === 'http' ? !def.url : !def.command) throw new Error(def.type === 'http' ? 'Enter the server URL' : 'Enter the command that starts the server')
    const errors: string[] = []
    for (const cli of targets) {
      try {
        if (cli === 'claude') {
          const exe = findCliExecutable('claude')
          if (!exe) throw new Error('Claude Code not installed')
          await exec(exe, ['mcp', 'remove', '-s', 'user', name]).catch(() => undefined)
          const json = def.type === 'http' ? { type: 'http', url: def.url } : { type: 'stdio', command: def.command, args: def.args ?? [], env: def.env ?? {} }
          await exec(exe, ['mcp', 'add-json', '-s', 'user', name, JSON.stringify(json)])
        } else if (cli === 'agy') {
          const exe = findCliExecutable('agy')
          if (!exe) throw new Error('Antigravity not installed')
          const envFlags = Object.entries(def.env ?? {}).flatMap(([k, v]) => ['--env', `${k}=${v}`])
          await exec(exe, ['mcp', 'add', ...envFlags, name, ...(def.type === 'http' ? [def.url!] : ['--', def.command!, ...(def.args ?? [])])])
        } else if (cli === 'codex') writeCodex(def, name)
        else if (cli === 'gemini') writeJsonMap(PATHS.gemini, 'mcpServers', def, name)
        else if (cli === 'copilot') writeJsonMap(PATHS.copilot, 'mcpServers', def, name)
      } catch (e) {
        errors.push(`${cli}: ${(e as Error).message}`)
      }
    }
    if (errors.length) throw new Error(`Saved where possible, but: ${errors.join(' · ')}`)
    return mcp.list()
  },

  remove: async (name: string, targets: CliId[]): Promise<McpServerEntry[]> => {
    for (const cli of targets) {
      try {
        if (cli === 'claude') {
          const exe = findCliExecutable('claude')
          if (exe) await exec(exe, ['mcp', 'remove', '-s', 'user', name])
        } else if (cli === 'agy') {
          const exe = findCliExecutable('agy')
          if (exe) await exec(exe, ['mcp', 'remove', name])
        } else if (cli === 'codex') writeCodex(null, name)
        else if (cli === 'gemini') writeJsonMap(PATHS.gemini, 'mcpServers', null, name)
        else if (cli === 'copilot') writeJsonMap(PATHS.copilot, 'mcpServers', null, name)
      } catch {
        // already gone
      }
    }
    return mcp.list()
  }
}
