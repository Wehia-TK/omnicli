import { execFile, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CliId, CliLimitInfo, CliModel, CliSubscriptionStatus } from '@shared/types'
import { all, get, nowLocal, run, runSilent } from './db'
import { getSettings } from './settings'

const CATALOG_MODELS: Record<CliId, CliModel[]> = {
  agy: [
    { id: 'gemini-4-argon-high', name: 'Gemini 4 Argon', tier: 'High', cli: 'agy', description: 'Flagship deep-reasoning coding agent in Antigravity' },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', tier: 'High', cli: 'agy', description: 'Complex architecture, multi-file edits & long context' },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', tier: 'Fast', cli: 'agy', description: 'Low-latency edits and quick tasks' },
    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', tier: 'High', cli: 'agy', description: 'Anthropic Sonnet routed through Antigravity subscription' }
  ],
  claude: [
    { id: 'sonnet', name: 'Claude Sonnet 4.6', tier: 'High', cli: 'claude', description: 'Best balance of speed, coding intelligence, and 5h limit efficiency' },
    { id: 'opus', name: 'Claude Opus 4.6', tier: 'Max', cli: 'claude', description: 'Deepest reasoning for complex refactors and debugging' },
    { id: 'fable', name: 'Claude Fable', tier: 'High', cli: 'claude', description: 'Latest frontier model in Claude Code' },
    { id: 'haiku', name: 'Claude Haiku 4.5', tier: 'Fast', cli: 'claude', description: 'Ultra-fast, minimal 5h quota consumption' }
  ],
  codex: [
    { id: 'gpt-5-codex', name: 'GPT-5 Codex', tier: 'High', cli: 'codex', description: 'OpenAI flagship software engineering model' },
    { id: 'o3', name: 'OpenAI o3', tier: 'High', cli: 'codex', description: 'Deep reasoning for hard algorithmic and systems problems' },
    { id: 'o4-mini', name: 'OpenAI o4-mini', tier: 'Fast', cli: 'codex', description: 'Fast reasoning with high rate limits on ChatGPT Plus/Pro' },
    { id: 'codex-mini-latest', name: 'Codex Mini', tier: 'Fast', cli: 'codex', description: 'Lightweight agentic coding model' }
  ],
  gemini: [
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', tier: 'High', cli: 'gemini', description: '1M+ context window reasoning & coding via Gemini CLI' },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', tier: 'Fast', cli: 'gemini', description: 'Fast everyday coding and shell assistance' }
  ],
  copilot: [
    { id: 'claude-sonnet-4', name: 'Copilot · Sonnet 4', tier: 'High', cli: 'copilot', description: 'Claude Sonnet 4 via GitHub Copilot CLI subscription' },
    { id: 'gpt-4.1', name: 'Copilot · GPT-4.1', tier: 'Fast', cli: 'copilot', description: 'OpenAI GPT-4.1 via GitHub Copilot CLI subscription' },
    { id: 'o3-mini', name: 'Copilot · o3-mini', tier: 'Fast', cli: 'copilot', description: 'Reasoning model via GitHub Copilot CLI' }
  ]
}

function whereBin(name: string): string {
  try {
    const r = spawnSync('where.exe', [name], { windowsHide: true, timeout: 4000, encoding: 'utf8' })
    if (r.status !== 0 || !r.stdout) return ''
    const hits = r.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    return hits.find((h) => /\.exe$/i.test(h)) ?? hits.find((h) => /\.(cmd|bat)$/i.test(h)) ?? hits[0] ?? ''
  } catch {
    return ''
  }
}

function bundledClaudeCli(): string {
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  const root = join(localAppData, 'Claude-Data')
  const hits: { path: string; at: number }[] = []
  const dirs = (d: string): string[] => {
    try {
      return readdirSync(d, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(d, e.name))
    } catch {
      return []
    }
  }
  for (const install of dirs(root)) {
    for (const version of dirs(join(install, 'claude-code'))) {
      for (const build of dirs(version)) {
        const exe = join(build, 'claude.exe')
        if (existsSync(exe)) hits.push({ path: exe, at: statSync(exe).mtimeMs })
      }
    }
  }
  return hits.sort((a, b) => b.at - a.at)[0]?.path ?? ''
}

export function findCliExecutable(cli: CliId): string {
  const s = getSettings()
  const home = homedir()
  const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
  const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming')

  if (cli === 'claude') {
    if (s.claudePath.trim() && existsSync(s.claudePath.trim())) return s.claudePath.trim()
    const onPath = whereBin('claude')
    if (onPath) return onPath
    const bundled = bundledClaudeCli()
    if (bundled) return bundled
    const candidates = [
      join(appData, 'npm', 'claude.cmd'),
      join(home, '.local', 'bin', 'claude.exe'),
      join(home, '.claude', 'local', 'claude.exe')
    ]
    return candidates.find((c) => existsSync(c)) ?? ''
  }

  if (cli === 'agy') {
    if (s.agyPath.trim() && existsSync(s.agyPath.trim())) return s.agyPath.trim()
    const onPath = whereBin('agy')
    if (onPath) return onPath
    const candidates = [
      join(localAppData, 'agy', 'bin', 'agy.exe'),
      join(localAppData, 'Programs', 'Antigravity', 'bin', 'agy.exe'),
      join(localAppData, 'Programs', 'Antigravity', 'bin', 'antigravity.cmd')
    ]
    return candidates.find((c) => existsSync(c)) ?? ''
  }

  if (cli === 'codex') {
    if (s.codexPath.trim() && existsSync(s.codexPath.trim())) return s.codexPath.trim()
    const onPath = whereBin('codex')
    if (onPath) return onPath
    const npmCmd = join(appData, 'npm', 'codex.cmd')
    return existsSync(npmCmd) ? npmCmd : ''
  }

  if (cli === 'gemini') {
    if (s.geminiPath.trim() && existsSync(s.geminiPath.trim())) return s.geminiPath.trim()
    const onPath = whereBin('gemini')
    if (onPath) return onPath
    const npmCmd = join(appData, 'npm', 'gemini.cmd')
    return existsSync(npmCmd) ? npmCmd : ''
  }

  if (cli === 'copilot') {
    if (s.copilotPath.trim() && existsSync(s.copilotPath.trim())) return s.copilotPath.trim()
    const onPath = whereBin('copilot')
    if (onPath) return onPath
    const shim = join(localAppData, 'Programs', 'Microsoft VS Code', 'bin', 'copilot-shim', 'copilot.exe')
    return existsSync(shim) ? shim : ''
  }

  return ''
}

function detectAuth(cli: CliId, exePath: string): { installed: boolean; authenticated: boolean; accountLabel: string; statusReason: string } {
  const home = homedir()
  const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')

  if (cli === 'claude') {
    const claudeJson = join(home, '.claude.json')
    const credsJson = join(home, '.claude', '.credentials.json')
    const claudeDir = join(home, '.claude')
    let email = ''
    if (existsSync(claudeJson)) {
      try {
        const parsed = JSON.parse(readFileSync(claudeJson, 'utf8')) as {
          oauthAccount?: { emailAddress?: string; displayName?: string }
          userID?: string
        }
        email = parsed.oauthAccount?.emailAddress || parsed.oauthAccount?.displayName || (parsed.userID ? 'Claude Account' : '')
      } catch {
        // ignore
      }
    }
    const hasAuthFiles = Boolean(email) || existsSync(credsJson) || existsSync(claudeDir)
    const installed = Boolean(exePath)
    if (installed && hasAuthFiles) {
      return {
        installed: true,
        authenticated: true,
        accountLabel: email || 'Claude Subscription',
        statusReason: 'Authenticated & ready'
      }
    }
    if (!installed && hasAuthFiles) {
      return {
        installed: false,
        authenticated: false,
        accountLabel: email || 'Claude Account',
        statusReason: 'Credentials found, but Claude Code CLI binary was not found on PATH'
      }
    }
    if (installed && !hasAuthFiles) {
      return {
        installed: true,
        authenticated: false,
        accountLabel: 'Not signed in',
        statusReason: 'Installed — run `claude login` to authenticate your subscription'
      }
    }
    return {
      installed: false,
      authenticated: false,
      accountLabel: 'Not installed',
      statusReason: 'Install Claude Code (`npm i -g @anthropic-ai/claude-code`) and sign in'
    }
  }

  if (cli === 'agy') {
    const agyConfigDir = join(home, '.gemini', 'antigravity')
    const hasAgyState = existsSync(agyConfigDir)
    const installed = Boolean(exePath) || hasAgyState
    if (installed && hasAgyState) {
      return {
        installed: true,
        authenticated: true,
        accountLabel: 'Google Antigravity',
        statusReason: 'Authenticated & ready'
      }
    }
    if (installed) {
      return {
        installed: true,
        authenticated: true,
        accountLabel: 'Antigravity CLI',
        statusReason: 'Authenticated & ready'
      }
    }
    return {
      installed: false,
      authenticated: false,
      accountLabel: 'Not installed',
      statusReason: 'Install Antigravity CLI and sign in with `agy`'
    }
  }

  if (cli === 'gemini') {
    const oauthPath = join(home, '.gemini', 'oauth_creds.json')
    const accountsPath = join(home, '.gemini', 'google_accounts.json')
    const agyDir = join(home, '.gemini', 'antigravity')
    let account = 'Google AI Account'
    if (existsSync(accountsPath)) {
      try {
        const parsed = JSON.parse(readFileSync(accountsPath, 'utf8')) as { active?: string }
        if (parsed.active) account = parsed.active
      } catch {
        // ignore
      }
    }
    const hasGeminiAuth = existsSync(oauthPath) || existsSync(accountsPath) || existsSync(agyDir)
    const fallbackExe = exePath || findCliExecutable('agy')
    if (hasGeminiAuth && fallbackExe) {
      return {
        installed: true,
        authenticated: true,
        accountLabel: account,
        statusReason: exePath ? 'Authenticated via Gemini CLI' : 'Authenticated via Google Gemini / Antigravity'
      }
    }
    if (exePath && !hasGeminiAuth) {
      return {
        installed: true,
        authenticated: false,
        accountLabel: 'Not signed in',
        statusReason: 'Installed — run `gemini` in terminal to sign in with Google'
      }
    }
    return {
      installed: false,
      authenticated: false,
      accountLabel: 'Not authenticated',
      statusReason: 'Install `@google/gemini-cli` and sign in with your Google subscription'
    }
  }

  if (cli === 'codex') {
    const authJson = join(home, '.codex', 'auth.json')
    let hasValidToken = false
    if (existsSync(authJson)) {
      try {
        const raw = JSON.parse(readFileSync(authJson, 'utf8')) as { tokens?: unknown; OPENAI_API_KEY?: string; access_token?: string }
        hasValidToken = Boolean(raw.tokens || raw.access_token || raw.OPENAI_API_KEY)
      } catch {
        hasValidToken = false
      }
    }
    if (exePath && hasValidToken) {
      return {
        installed: true,
        authenticated: true,
        accountLabel: 'ChatGPT Subscription',
        statusReason: 'Authenticated via ChatGPT OAuth'
      }
    }
    if (exePath && !hasValidToken) {
      return {
        installed: true,
        authenticated: false,
        accountLabel: 'Not signed in',
        statusReason: 'Subscription not authenticated — run `codex login` to sign in with ChatGPT'
      }
    }
    return {
      installed: false,
      authenticated: false,
      accountLabel: 'Not authenticated',
      statusReason: 'Install `@openai/codex` and run `codex login` with your ChatGPT Plus/Pro subscription'
    }
  }

  if (cli === 'copilot') {
    const hosts1 = join(localAppData, 'github-copilot', 'hosts.json')
    const hosts2 = join(home, '.config', 'github-copilot', 'hosts.json')
    const apps1 = join(localAppData, 'github-copilot', 'apps.json')
    const apps2 = join(home, '.config', 'github-copilot', 'apps.json')
    const hasToken = [hosts1, hosts2, apps1, apps2].some((p) => {
      if (!existsSync(p)) return false
      try {
        const txt = readFileSync(p, 'utf8')
        return txt.includes('oauth_token')
      } catch {
        return false
      }
    })
    if (exePath && hasToken) {
      return {
        installed: true,
        authenticated: true,
        accountLabel: 'GitHub Copilot',
        statusReason: 'Authenticated via GitHub OAuth'
      }
    }
    if (exePath && !hasToken) {
      return {
        installed: true,
        authenticated: false,
        accountLabel: 'Not signed in',
        statusReason: 'Installed, but subscription not authenticated — run `copilot` or `gh auth login`'
      }
    }
    return {
      installed: false,
      authenticated: false,
      accountLabel: 'Not authenticated',
      statusReason: 'Install GitHub Copilot CLI and sign in with your GitHub account'
    }
  }

  return { installed: false, authenticated: false, accountLabel: '', statusReason: 'Unknown CLI' }
}

/** Tier window budgets (5-hour rolling window) for live progress bar calculation. */
function windowBudgetFor(cli: CliId): { maxTokens: number; maxRequests: number; planLabel: string } {
  const s = getSettings()
  if (cli === 'claude') {
    if (s.claudeTier === 'max20x') return { maxTokens: 4_500_000, maxRequests: 900, planLabel: 'Claude Max 20x' }
    if (s.claudeTier === 'max5x') return { maxTokens: 1_200_000, maxRequests: 225, planLabel: 'Claude Max 5x' }
    return { maxTokens: 300_000, maxRequests: 45, planLabel: 'Claude Pro (5h window)' }
  }
  if (cli === 'agy') {
    if (s.agyTier === 'pro') return { maxTokens: 2_000_000, maxRequests: 200, planLabel: 'Antigravity Pro' }
    return { maxTokens: 600_000, maxRequests: 60, planLabel: 'Antigravity Standard' }
  }
  if (cli === 'codex') {
    if (s.codexTier === 'pro') return { maxTokens: 2_500_000, maxRequests: 300, planLabel: 'ChatGPT Pro' }
    return { maxTokens: 500_000, maxRequests: 80, planLabel: 'ChatGPT Plus' }
  }
  if (cli === 'gemini') {
    if (s.geminiTier === 'advanced') return { maxTokens: 2_000_000, maxRequests: 250, planLabel: 'Google AI Pro' }
    return { maxTokens: 500_000, maxRequests: 60, planLabel: 'Gemini Standard' }
  }
  return {
    maxTokens: 600_000,
    maxRequests: 120,
    planLabel: s.copilotTier === 'enterprise' ? 'Copilot Enterprise' : 'Copilot Pro'
  }
}

function formatDurationShort(ms: number): string {
  if (ms <= 0) return 'now'
  const totalMinutes = Math.ceil(ms / 60_000)
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  if (h > 0 && m > 0) return `${h}h ${m}m`
  if (h > 0) return `${h}h`
  return `${m}m`
}

let cachedExternalClaude: { at: number; windowTokens: number; windowReqs: number; todayTokens: number; oldestInWindowMs: number | null } | null = null

function scanExternalClaudeUsage(windowStartMs: number, todayStartMs: number): {
  windowTokens: number
  windowReqs: number
  todayTokens: number
  oldestInWindowMs: number | null
} {
  const now = Date.now()
  if (cachedExternalClaude && now - cachedExternalClaude.at < 20_000) {
    return cachedExternalClaude
  }
  let windowTokens = 0
  let windowReqs = 0
  let todayTokens = 0
  let oldestInWindowMs: number | null = null

  try {
    const projectsRoot = join(homedir(), '.claude', 'projects')
    if (existsSync(projectsRoot)) {
      const dirs = readdirSync(projectsRoot, { withFileTypes: true }).filter((e) => e.isDirectory())
      for (const d of dirs.slice(0, 30)) {
        const subDir = join(projectsRoot, d.name)
        const files = readdirSync(subDir, { withFileTypes: true }).filter((f) => f.isFile() && f.name.endsWith('.jsonl'))
        for (const f of files) {
          const full = join(subDir, f.name)
          const st = statSync(full)
          if (st.mtimeMs < todayStartMs) continue
          const content = readFileSync(full, 'utf8')
          for (const line of content.split('\n')) {
            if (!line.includes('"usage"')) continue
            try {
              const ev = JSON.parse(line) as {
                timestamp?: string
                message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number } }
              }
              const u = ev.message?.usage
              if (!u) continue
              const tok = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
              const ts = ev.timestamp ? Date.parse(ev.timestamp) : st.mtimeMs
              if (ts >= todayStartMs) todayTokens += tok
              if (ts >= windowStartMs) {
                windowTokens += tok
                windowReqs += 1
                if (oldestInWindowMs === null || ts < oldestInWindowMs) oldestInWindowMs = ts
              }
            } catch {
              // ignore line parse error
            }
          }
        }
      }
    }
  } catch {
    // ignore if ~/.claude is not readable
  }

  cachedExternalClaude = { at: now, windowTokens, windowReqs, todayTokens, oldestInWindowMs }
  return cachedExternalClaude
}

export function computeLimitInfo(cli: CliId, authenticated: boolean): CliLimitInfo {
  const windowHours = 5
  const nowMs = Date.now()
  const windowStartMs = nowMs - windowHours * 3600_000
  const todayStartMs = nowMs - 24 * 3600_000
  const weekStartMs = nowMs - 7 * 24 * 3600_000

  const budget = windowBudgetFor(cli)

  const windowStats = get<{ tokens: number; reqs: number; ms: number; oldest: number | null }>(
    `SELECT COALESCE(SUM(tokens), 0) AS tokens,
            COUNT(*) AS reqs,
            COALESCE(SUM(duration_ms), 0) AS ms,
            MIN(epoch_ms) AS oldest
     FROM usage_logs
     WHERE cli = ? AND epoch_ms >= ?`,
    cli,
    windowStartMs
  ) ?? { tokens: 0, reqs: 0, ms: 0, oldest: null }

  const todayStats = get<{ tokens: number; reqs: number }>(
    `SELECT COALESCE(SUM(tokens), 0) AS tokens, COUNT(*) AS reqs
     FROM usage_logs WHERE cli = ? AND epoch_ms >= ?`,
    cli,
    todayStartMs
  ) ?? { tokens: 0, reqs: 0 }

  if (cli === 'claude' && authenticated) {
    const ext = scanExternalClaudeUsage(windowStartMs, todayStartMs)
    windowStats.tokens = Math.max(windowStats.tokens, ext.windowTokens)
    windowStats.reqs = Math.max(windowStats.reqs, ext.windowReqs)
    todayStats.tokens = Math.max(todayStats.tokens, ext.todayTokens)
    if (ext.oldestInWindowMs && (!windowStats.oldest || ext.oldestInWindowMs < windowStats.oldest)) {
      windowStats.oldest = ext.oldestInWindowMs
    }
  }

  const weekStats = get<{ tokens: number }>(
    `SELECT COALESCE(SUM(tokens), 0) AS tokens
     FROM usage_logs WHERE cli = ? AND epoch_ms >= ?`,
    cli,
    weekStartMs
  ) ?? { tokens: 0 }

  const rateEv = get<{ status: string; utilization_pct: number | null; resets_at: string | null; note: string }>(
    'SELECT * FROM cli_rate_events WHERE cli = ?',
    cli
  )

  if (!authenticated) {
    return {
      windowHours,
      usedTokens: 0,
      usedRequests: 0,
      usedMs: 0,
      maxRequestsWindow: budget.maxRequests,
      maxTokensWindow: budget.maxTokens,
      utilizationPct: 0,
      status: 'unauthenticated',
      resetsAt: null,
      resetInLabel: 'Sign in required',
      todayTokens: 0,
      todayRequests: 0,
      weekTokens: 0
    }
  }

  const tokenPct = (windowStats.tokens / Math.max(1, budget.maxTokens)) * 100
  const reqPct = (windowStats.reqs / Math.max(1, budget.maxRequests)) * 100
  let utilizationPct = Math.min(100, Math.round(Math.max(tokenPct, reqPct)))

  if (rateEv?.utilization_pct != null && rateEv.utilization_pct > utilizationPct) {
    utilizationPct = Math.min(100, Math.round(rateEv.utilization_pct))
  }
  if (rateEv?.status === 'rejected') {
    utilizationPct = 100
  }

  let resetsAt: string | null = null
  let resetInLabel = '5h window clear'

  if (rateEv?.resets_at) {
    const resetEpoch = Date.parse(rateEv.resets_at)
    if (!Number.isNaN(resetEpoch) && resetEpoch > nowMs) {
      resetsAt = rateEv.resets_at
      resetInLabel = `Resets in ${formatDurationShort(resetEpoch - nowMs)}`
    }
  }

  if (!resetsAt && windowStats.oldest) {
    const resetEpoch = windowStats.oldest + windowHours * 3600_000
    if (resetEpoch > nowMs) {
      resetsAt = new Date(resetEpoch).toISOString()
      resetInLabel = `Resets in ${formatDurationShort(resetEpoch - nowMs)}`
    }
  }

  const status: CliLimitInfo['status'] =
    rateEv?.status === 'rejected' || utilizationPct >= 100
      ? 'rejected'
      : rateEv?.status === 'warning' || utilizationPct >= 80
        ? 'warning'
        : 'ok'

  return {
    windowHours,
    usedTokens: windowStats.tokens,
    usedRequests: windowStats.reqs,
    usedMs: windowStats.ms,
    maxRequestsWindow: budget.maxRequests,
    maxTokensWindow: budget.maxTokens,
    utilizationPct,
    status,
    resetsAt,
    resetInLabel,
    todayTokens: todayStats.tokens,
    todayRequests: todayStats.reqs,
    weekTokens: weekStats.tokens,
    liveNote: rateEv?.note || undefined
  }
}

export function recordCliUsage(opts: {
  cli: CliId
  model: string
  projectId?: number
  taskId?: number
  tokens: number
  costUsd?: number
  durationMs: number
}): void {
  if (opts.tokens <= 0 && opts.durationMs <= 0) return
  run(
    `INSERT INTO usage_logs (cli, model, project_id, task_id, tokens, cost_usd, duration_ms, created_at, epoch_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    opts.cli,
    opts.model,
    opts.projectId ?? null,
    opts.taskId ?? null,
    Math.max(0, Math.round(opts.tokens)),
    opts.costUsd ?? 0,
    Math.max(0, Math.round(opts.durationMs)),
    nowLocal(),
    Date.now()
  )
}

export function recordCliRateEvent(
  cli: CliId,
  status: 'ok' | 'warning' | 'rejected',
  utilizationPct?: number | null,
  resetsAt?: string | null,
  note = ''
): void {
  runSilent(
    `INSERT INTO cli_rate_events (cli, status, utilization_pct, resets_at, note, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(cli) DO UPDATE SET
       status = excluded.status,
       utilization_pct = COALESCE(excluded.utilization_pct, cli_rate_events.utilization_pct),
       resets_at = COALESCE(excluded.resets_at, cli_rate_events.resets_at),
       note = excluded.note,
       updated_at = excluded.updated_at`,
    cli,
    status,
    utilizationPct ?? null,
    resetsAt ?? null,
    note,
    nowLocal()
  )
}

let dynamicAgyModels: CliModel[] | null = null

async function loadDynamicAgyModels(exePath: string): Promise<CliModel[]> {
  if (dynamicAgyModels !== null) return dynamicAgyModels
  if (!exePath) return []
  return new Promise((resolve) => {
    execFile(exePath, ['models'], { windowsHide: true, timeout: 6000 }, (err, out) => {
      if (err || !out) {
        dynamicAgyModels = []
        return resolve([])
      }
      const parsed = out
        .split(/\r?\n/)
        .map((l) => l.trim().split(/\s+/)[0])
        .filter((m) => /^[a-z0-9][\w.:-]*$/i.test(m) && /\d/.test(m))
        .map((id) => ({
          id,
          name: id
            .replace(/-/g, ' ')
            .replace(/\b\w/g, (c) => c.toUpperCase()),
          tier: /flash|lite|mini/i.test(id) ? 'Fast' : 'High',
          cli: 'agy' as const,
          description: 'Discovered from Antigravity CLI'
        }))
      dynamicAgyModels = parsed
      resolve(parsed)
    }).stdin?.end()
  })
}

export const clis = {
  /** All 5 AI subscriptions with live authentication state, models, and 5-hour rolling window usage limits. */
  statusAll: async (forceRefresh = false): Promise<CliSubscriptionStatus[]> => {
    if (forceRefresh) dynamicAgyModels = null
    const meta: { id: CliId; name: string; shortName: string; provider: string; accentColor: string; loginCommand: string; installCommand: string }[] = [
      {
        id: 'agy',
        name: 'Antigravity',
        shortName: 'Antigravity',
        provider: 'Google DeepMind',
        accentColor: '#38bdf8',
        loginCommand: 'agy',
        installCommand: 'irm https://antigravity.google/cli/install.ps1 | iex'
      },
      {
        id: 'claude',
        name: 'Claude Code',
        shortName: 'Claude',
        provider: 'Anthropic',
        accentColor: '#d97757',
        loginCommand: 'claude login',
        installCommand: 'npm install -g @anthropic-ai/claude-code'
      },
      {
        id: 'gemini',
        name: 'Gemini CLI',
        shortName: 'Gemini',
        provider: 'Google',
        accentColor: '#8b5cf6',
        loginCommand: 'gemini',
        installCommand: 'npm install -g @google/gemini-cli'
      },
      {
        id: 'codex',
        name: 'OpenAI Codex',
        shortName: 'Codex',
        provider: 'OpenAI',
        accentColor: '#10b981',
        loginCommand: 'codex login',
        installCommand: 'npm install -g @openai/codex'
      },
      {
        id: 'copilot',
        name: 'GitHub Copilot CLI',
        shortName: 'Copilot',
        provider: 'GitHub',
        accentColor: '#6366f1',
        loginCommand: 'gh auth login',
        installCommand: 'npm install -g @github/copilot'
      }
    ]

    const out: CliSubscriptionStatus[] = []
    for (const m of meta) {
      const exePath = findCliExecutable(m.id)
      const auth = detectAuth(m.id, exePath)
      const budget = windowBudgetFor(m.id)
      let models = [...CATALOG_MODELS[m.id]]
      if (m.id === 'agy' && exePath) {
        const dyn = await loadDynamicAgyModels(exePath)
        for (const dm of dyn) {
          if (!models.some((x) => x.id.toLowerCase() === dm.id.toLowerCase())) {
            models.push(dm)
          }
        }
      }
      out.push({
        id: m.id,
        name: m.name,
        shortName: m.shortName,
        provider: m.provider,
        planLabel: budget.planLabel,
        accentColor: m.accentColor,
        installed: auth.installed,
        authenticated: auth.authenticated,
        exePath,
        accountLabel: auth.accountLabel,
        statusReason: auth.statusReason,
        loginCommand: m.loginCommand,
        installCommand: m.installCommand,
        models,
        limit: computeLimitInfo(m.id, auth.authenticated)
      })
    }
    return out
  },

  /** Reset or clear a rate limit lock manually if the window has passed. */
  clearRateLimit: (cli: CliId): true => {
    run('DELETE FROM cli_rate_events WHERE cli = ?', cli)
    return true
  },

  /** Recent usage history across all subscriptions for the Live Limits dashboard. */
  recentUsage: (): { id: number; cli: CliId; model: string; tokens: number; duration_ms: number; created_at: string }[] =>
    all('SELECT id, cli, model, tokens, duration_ms, created_at FROM usage_logs ORDER BY id DESC LIMIT 40')
}
