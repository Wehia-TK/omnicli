import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { CliAccount, CliId } from '@shared/types'
import { all, get, nowLocal, run } from './db'
import { activeRateEvent, clearAccountCaches } from './clis'
import { terminal } from './terminal'

/** CLIs whose login lives in a relocatable config folder (selected with an env var). */
export const MULTI_ACCOUNT_CLIS: CliId[] = ['claude', 'codex']

const ENV_VAR: Partial<Record<CliId, string>> = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' }
const LOGIN_CMD: Partial<Record<CliId, string>> = { claude: 'claude login', codex: 'codex login' }

let dataDir = ''
export function initAccounts(dir: string): void {
  dataDir = dir
}

interface AccountRow {
  id: number
  cli: CliId
  label: string
  config_dir: string
  sort: number
  created_at: string
}

/** Rate-limit key: the primary (system login, id 0) keeps the legacy key so existing locks keep working. */
export function rateKey(cli: CliId, accountId: number, suffix = ''): CliId {
  const base = accountId ? `${cli}#${accountId}` : cli
  return (suffix ? `${base}:${suffix}` : base) as CliId
}

export function isAccountLimited(cli: CliId, accountId: number): boolean {
  return activeRateEvent(rateKey(cli, accountId), Date.now())?.status === 'rejected'
}

function readAuth(row: AccountRow): { authenticated: boolean; accountLabel: string } {
  try {
    if (row.cli === 'claude') {
      const creds = existsSync(join(row.config_dir, '.credentials.json'))
      let email = ''
      const cj = join(row.config_dir, '.claude.json')
      if (existsSync(cj)) {
        const parsed = JSON.parse(readFileSync(cj, 'utf8')) as { oauthAccount?: { emailAddress?: string; displayName?: string } }
        email = parsed.oauthAccount?.emailAddress || parsed.oauthAccount?.displayName || ''
      }
      return { authenticated: creds || Boolean(email), accountLabel: email || (creds ? 'Signed in' : 'Not signed in') }
    }
    const authFile = join(row.config_dir, 'auth.json')
    if (existsSync(authFile)) {
      const raw = JSON.parse(readFileSync(authFile, 'utf8')) as { tokens?: unknown; access_token?: string; OPENAI_API_KEY?: string }
      const ok = Boolean(raw.tokens || raw.access_token || raw.OPENAI_API_KEY)
      return { authenticated: ok, accountLabel: ok ? 'Signed in' : 'Not signed in' }
    }
  } catch {
    // unreadable — treat as signed out
  }
  return { authenticated: false, accountLabel: 'Not signed in' }
}

function toAccount(row: AccountRow): CliAccount {
  const auth = readAuth(row)
  const ev = activeRateEvent(rateKey(row.cli, row.id), Date.now())
  return { ...row, ...auth, limited: ev?.status === 'rejected', resetsAt: ev?.status === 'rejected' ? ev.resets_at : null }
}

function rows(cli?: CliId): AccountRow[] {
  return cli
    ? all<AccountRow>('SELECT * FROM cli_accounts WHERE cli = ? ORDER BY sort, id', cli)
    : all<AccountRow>('SELECT * FROM cli_accounts ORDER BY cli, sort, id')
}

/** Environment overrides that point a CLI at an account's own config folder (empty for the primary login). */
export function accountEnv(cli: CliId, accountId: number): Record<string, string> {
  if (!accountId) return {}
  const row = get<AccountRow>('SELECT * FROM cli_accounts WHERE id = ? AND cli = ?', accountId, cli)
  const name = ENV_VAR[cli]
  return row && name ? { [name]: row.config_dir } : {}
}

/**
 * Which account a run should use: the primary login first, then saved accounts in order —
 * skipping any that are signed out or currently rate limited. Returns null when every account is exhausted.
 * The primary (0) is only offered when `primaryReady` says the system login works.
 */
export function pickAccountId(cli: CliId, primaryReady: boolean, exclude: Set<number> = new Set()): number | null {
  if (!MULTI_ACCOUNT_CLIS.includes(cli)) return 0
  if (primaryReady && !exclude.has(0) && !isAccountLimited(cli, 0)) return 0
  for (const r of rows(cli)) {
    if (exclude.has(r.id) || isAccountLimited(cli, r.id)) continue
    if (readAuth(r).authenticated) return r.id
  }
  return null
}

export function hasExtraAccounts(cli: CliId): boolean {
  return rows(cli).length > 0
}

export function accountLabel(cli: CliId, accountId: number): string {
  if (!accountId) return 'primary account'
  return get<AccountRow>('SELECT * FROM cli_accounts WHERE id = ?', accountId)?.label ?? `account ${accountId}`
}

export const accounts = {
  list: (): CliAccount[] => rows().map(toAccount),

  add: (cli: CliId, label: string): CliAccount => {
    if (!MULTI_ACCOUNT_CLIS.includes(cli)) throw new Error(`Multiple accounts aren't supported for ${cli} yet`)
    const name = label.trim()
    if (!name) throw new Error('Give the account a name')
    if (!dataDir) throw new Error('Accounts are not initialised')
    const sort = (get<{ m: number | null }>('SELECT MAX(sort) AS m FROM cli_accounts WHERE cli = ?', cli)?.m ?? 0) + 1
    const id = run('INSERT INTO cli_accounts (cli, label, config_dir, sort, created_at) VALUES (?, ?, ?, ?, ?)', cli, name, '', sort, nowLocal())
    const dir = join(dataDir, 'accounts', `${cli}-${id}`)
    mkdirSync(dir, { recursive: true })
    run('UPDATE cli_accounts SET config_dir = ? WHERE id = ?', dir, id)
    clearAccountCaches()
    return toAccount(get<AccountRow>('SELECT * FROM cli_accounts WHERE id = ?', id)!)
  },

  rename: (id: number, label: string): true => {
    if (!label.trim()) throw new Error('Give the account a name')
    run('UPDATE cli_accounts SET label = ? WHERE id = ?', label.trim(), id)
    return true
  },

  /** Move an account up (-1) or down (+1) in the fallback order. */
  move: (id: number, dir: -1 | 1): true => {
    const row = get<AccountRow>('SELECT * FROM cli_accounts WHERE id = ?', id)
    if (!row) return true
    const list = rows(row.cli)
    const i = list.findIndex((r) => r.id === id)
    const j = i + dir
    if (j < 0 || j >= list.length) return true
    list.splice(j, 0, list.splice(i, 1)[0])
    list.forEach((r, n) => run('UPDATE cli_accounts SET sort = ? WHERE id = ?', n + 1, r.id))
    return true
  },

  remove: (id: number): true => {
    const row = get<AccountRow>('SELECT * FROM cli_accounts WHERE id = ?', id)
    if (!row) return true
    run('DELETE FROM cli_accounts WHERE id = ?', id)
    run('DELETE FROM cli_rate_events WHERE cli = ? OR cli LIKE ?', rateKey(row.cli, id), `${rateKey(row.cli, id)}:%`)
    // only ever delete folders this app created
    if (dataDir && row.config_dir.startsWith(join(dataDir, 'accounts'))) {
      try {
        rmSync(row.config_dir, { recursive: true, force: true })
      } catch {
        // leave it behind rather than fail
      }
    }
    clearAccountCaches()
    return true
  },

  clearLimit: (id: number): true => {
    const row = get<AccountRow>('SELECT * FROM cli_accounts WHERE id = ?', id)
    if (row) run('DELETE FROM cli_rate_events WHERE cli = ? OR cli LIKE ?', rateKey(row.cli, id), `${rateKey(row.cli, id)}:%`)
    return true
  },

  /** Open the embedded terminal for `sessionId` and run the CLI's own login with this account's config folder. */
  login: (id: number, sessionId: string, cols?: number, rows?: number): { sessionId: string; pty: boolean } => {
    const row = get<AccountRow>('SELECT * FROM cli_accounts WHERE id = ?', id)
    if (!row) throw new Error('Account not found')
    mkdirSync(row.config_dir, { recursive: true })
    const r = terminal.start(sessionId, row.config_dir, LOGIN_CMD[row.cli], cols, rows, accountEnv(row.cli, row.id))
    return { sessionId, pty: r.pty }
  }
}
