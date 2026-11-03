import { execFile, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CliId, CliLimitInfo, CliModel, CliSubscriptionStatus } from '@shared/types'
import { all, get, nowLocal, run, runSilent } from './db'
import { getSettings } from './settings'

const CATALOG_MODELS: Record<CliId, CliModel[]> = {
  agy: [
    { id: 'gemini-4-argon-high', name: 'Gemini 4 Argon', tier: 'High', cli: 'agy', description: 'Deep-reasoning flagship model in Antigravity (High effort)' },
    { id: 'gemini-4-argon-medium', name: 'Gemini 4 Argon', tier: 'Medium', cli: 'agy', description: 'Balanced reasoning and speed in Antigravity (Medium effort)' },
    { id: 'gemini-4-argon-low', name: 'Gemini 4 Argon', tier: 'Low', cli: 'agy', description: 'Low-latency Gemini 4 Argon (Low effort)' },
    { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash', tier: 'High', cli: 'agy', description: 'Fast frontier model with high reasoning effort' },
    { id: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash', tier: 'Medium', cli: 'agy', description: 'Fast everyday coding & tool execution' },
    { id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash', tier: 'Low', cli: 'agy', description: 'Ultra-fast responses & quick edits' },
    { id: 'claude-opus-5-5-high', name: 'Claude Opus 5.5', tier: 'High', cli: 'agy', description: 'Anthropic Opus 5.5 (High effort) via Antigravity' },
    { id: 'claude-opus-5-5-medium', name: 'Claude Opus 5.5', tier: 'Medium', cli: 'agy', description: 'Anthropic Opus 5.5 (Medium effort) via Antigravity' },
    { id: 'claude-sonnet-5-5-high', name: 'Claude Sonnet 5.5', tier: 'High', cli: 'agy', description: 'Anthropic Sonnet 5.5 (High effort) via Antigravity' },
    { id: 'claude-sonnet-5-5-medium', name: 'Claude Sonnet 5.5', tier: 'Medium', cli: 'agy', description: 'Anthropic Sonnet 5.5 (Medium effort) via Antigravity' },
    { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B', tier: 'Medium', cli: 'agy', description: 'Open-weight 120B model via Antigravity' }
  ],
  claude: [
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', tier: 'High', cli: 'claude', description: 'For complex work and everyday tasks (1M context)' },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', tier: 'Medium', cli: 'claude', description: 'Most efficient for simpler tasks (1M context)' },
    { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', tier: 'High', cli: 'claude', description: 'For your toughest challenges · Requires usage credits' },
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', tier: 'Fast', cli: 'claude', description: 'Fastest for quick answers' },
    { id: 'claude-opus-5', name: 'Claude Opus 5', tier: 'High', cli: 'claude', description: 'Previous-generation Opus 5' },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', tier: 'High', cli: 'claude', description: 'Previous-generation Sonnet 5' },
    { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', tier: 'High', cli: 'claude', description: 'Claude 4.8 Opus' }
  ],
  codex: [
    { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', tier: 'High', cli: 'codex', description: 'OpenAI flagship software engineering agent' },
    { id: 'gpt-5-codex', name: 'GPT-5 Codex', tier: 'High', cli: 'codex', description: 'Deep full-repo coding and debugging' },
    { id: 'o4-high', name: 'OpenAI o4', tier: 'High', cli: 'codex', description: 'Deep reasoning for hard algorithmic & systems tasks' },
    { id: 'o4-mini', name: 'OpenAI o4-mini', tier: 'Fast', cli: 'codex', description: 'Fast reasoning with high rate limits on ChatGPT Plus/Pro' }
  ],
  gemini: [
    { id: 'gemini-4-argon', name: 'Gemini 4 Argon', tier: 'High', cli: 'gemini', description: 'Flagship reasoning & coding via standalone Gemini CLI' },
    { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', tier: 'Fast', cli: 'gemini', description: 'High-speed coding and shell assistance' }
  ],
  copilot: [
    { id: 'claude-sonnet-5-5', name: 'Copilot · Sonnet 5.5', tier: 'High', cli: 'copilot', description: 'Claude Sonnet 5.5 via GitHub Copilot CLI' },
    { id: 'claude-opus-5-5', name: 'Copilot · Opus 5.5', tier: 'High', cli: 'copilot', description: 'Claude Opus 5.5 via GitHub Copilot CLI' },
    { id: 'gpt-5.2', name: 'Copilot · GPT-5.2', tier: 'Fast', cli: 'copilot', description: 'OpenAI GPT-5.2 via GitHub Copilot CLI' }
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

function detectAuth(cli: CliId, exePath: string): {
  installed: boolean
  authenticated: boolean
  accountLabel: string
  statusReason: string
  detectedPlan?: string
} {
  const home = homedir()
  const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')

  if (cli === 'claude') {
    const claudeJson = join(home, '.claude.json')
    const credsJson = join(home, '.claude', '.credentials.json')
    let email = ''
    let orgType = ''
    if (existsSync(claudeJson)) {
      try {
        const parsed = JSON.parse(readFileSync(claudeJson, 'utf8')) as {
          oauthAccount?: { emailAddress?: string; displayName?: string; organizationType?: string }
          userID?: string
        }
        email = parsed.oauthAccount?.emailAddress || parsed.oauthAccount?.displayName || (parsed.userID ? 'Claude Account' : '')
        orgType = parsed.oauthAccount?.organizationType || ''
      } catch {
        // ignore
      }
    }
    let subType = ''
    if (existsSync(credsJson)) {
      try {
        const creds = JSON.parse(readFileSync(credsJson, 'utf8')) as {
          claudeAiOauth?: { subscriptionType?: string; accessToken?: string }
        }
        subType = creds.claudeAiOauth?.subscriptionType || ''
      } catch {
        // ignore
      }
    }
    const hasAuthFiles = Boolean(email) || existsSync(credsJson)
    const installed = Boolean(exePath)
    const planName =
      subType === 'max' || orgType.includes('max')
        ? 'Claude Max'
        : subType === 'pro' || orgType.includes('pro')
          ? 'Claude Pro'
          : 'Claude Subscription'

    if (installed && hasAuthFiles) {
      return {
        installed: true,
        authenticated: true,
        accountLabel: email || 'Claude Account',
        statusReason: 'Authenticated & ready',
        detectedPlan: planName
      }
    }
    if (!installed && hasAuthFiles) {
      return {
        installed: false,
        authenticated: false,
        accountLabel: email || 'Claude Account',
        statusReason: 'Credentials found, but Claude Code binary not found'
      }
    }
    if (installed && !hasAuthFiles) {
      return {
        installed: true,
        authenticated: false,
        accountLabel: 'Not signed in',
        statusReason: 'Installed — run `claude login` to authenticate'
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
    const agyCliDir = join(home, '.gemini', 'antigravity-cli')
    const hasAgyState = existsSync(agyConfigDir) || existsSync(agyCliDir)
    const installed = Boolean(exePath)
    if (installed && hasAgyState) {
      return {
        installed: true,
        authenticated: true,
        accountLabel: 'Google Antigravity',
        statusReason: 'Authenticated & ready',
        detectedPlan: 'Antigravity Pro'
      }
    }
    if (installed) {
      return {
        installed: true,
        authenticated: true,
        accountLabel: 'Antigravity CLI',
        statusReason: 'Authenticated & ready',
        detectedPlan: 'Antigravity Pro'
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
    const hasStandaloneGeminiAuth = existsSync(oauthPath) || existsSync(accountsPath)
    if (exePath && hasStandaloneGeminiAuth) {
      return {
        installed: true,
        authenticated: true,
        accountLabel: 'Google Account',
        statusReason: 'Authenticated via Gemini CLI'
      }
    }
    if (exePath && !hasStandaloneGeminiAuth) {
      return {
        installed: true,
        authenticated: false,
        accountLabel: 'Not signed in',
        statusReason: 'Installed — run `gemini` to sign in with Google'
      }
    }
    return {
      installed: false,
      authenticated: false,
      accountLabel: 'Not installed',
      statusReason: 'Standalone Gemini CLI not installed (use Antigravity or `npm i -g @google/gemini-cli`)'
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
        statusReason: 'Subscription not authenticated — run `codex login`'
      }
    }
    return {
      installed: false,
      authenticated: false,
      accountLabel: 'Not installed',
      statusReason: 'Install `@openai/codex` and run `codex login` with ChatGPT Plus/Pro'
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
        return readFileSync(p, 'utf8').includes('oauth_token')
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
        statusReason: 'Installed, but subscription not authenticated — run `gh auth login`'
      }
    }
    return {
      installed: false,
      authenticated: false,
      accountLabel: 'Not authenticated',
      statusReason: 'Install GitHub Copilot CLI and sign in with GitHub'
    }
  }

  return { installed: false, authenticated: false, accountLabel: '', statusReason: 'Unknown CLI' }
}

function windowBudgetFor(cli: CliId, detectedPlan?: string): { maxTokens: number; maxRequests: number; planLabel: string } {
  const s = getSettings()
  if (cli === 'claude') {
    if (s.claudeTier === 'max20x') return { maxTokens: 4_500_000, maxRequests: 900, planLabel: 'Claude Max 20x' }
    if (s.claudeTier === 'max5x') return { maxTokens: 1_200_000, maxRequests: 225, planLabel: 'Claude Max 5x' }
    return { maxTokens: 500_000, maxRequests: 60, planLabel: detectedPlan || 'Claude Pro' }
  }
  if (cli === 'agy') {
    if (s.agyTier === 'pro') return { maxTokens: 2_000_000, maxRequests: 150, planLabel: 'Antigravity Pro' }
    return { maxTokens: 600_000, maxRequests: 60, planLabel: 'Antigravity Standard' }
  }
  if (cli === 'codex') {
    if (s.codexTier === 'pro') return { maxTokens: 2_500_000, maxRequests: 300, planLabel: 'ChatGPT Pro' }
    return { maxTokens: 500_000, maxRequests: 80, planLabel: 'ChatGPT Plus' }
  }
  if (cli === 'gemini') {
    return { maxTokens: 1_500_000, maxRequests: 150, planLabel: 'Google AI Pro' }
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
  const d = Math.floor(totalMinutes / (60 * 24))
  const h = Math.floor((totalMinutes % (60 * 24)) / 60)
  const m = totalMinutes % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0 && m > 0) return `${h}h ${m}m`
  if (h > 0) return `${h}h`
  return `${m}m`
}

interface LiveClaudeOAuthUsage {
  fetchedAt: number
  fiveHourPct: number
  fiveHourResetsAt: string | null
  sevenDayPct: number
  sevenDayResetsAt: string | null
}

let cachedClaudeOAuthUsage: LiveClaudeOAuthUsage | null = null

/** Fetch real live 5-hour session & 7-day weekly usage directly from Anthropic's OAuth Usage API (or fallback to ~/.claude.json). */
async function fetchLiveClaudeOAuthUsage(force = false): Promise<LiveClaudeOAuthUsage | null> {
  const now = Date.now()
  if (!force && cachedClaudeOAuthUsage && now - cachedClaudeOAuthUsage.fetchedAt < 30_000) {
    return cachedClaudeOAuthUsage
  }

  const home = homedir()
  const credsPath = join(home, '.claude', '.credentials.json')
  if (existsSync(credsPath)) {
    try {
      const creds = JSON.parse(readFileSync(credsPath, 'utf8')) as {
        claudeAiOauth?: { accessToken?: string }
      }
      const token = creds.claudeAiOauth?.accessToken
      if (token) {
        const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            'anthropic-beta': 'oauth-2025-04-20',
            Accept: 'application/json'
          },
          signal: AbortSignal.timeout(4500)
        })
        if (res.ok) {
          const data = (await res.json()) as {
            five_hour?: { utilization?: number; resets_at?: string | null }
            seven_day?: { utilization?: number; resets_at?: string | null }
          }
          cachedClaudeOAuthUsage = {
            fetchedAt: now,
            fiveHourPct: Math.round(data.five_hour?.utilization ?? 0),
            fiveHourResetsAt: data.five_hour?.resets_at ?? null,
            sevenDayPct: Math.round(data.seven_day?.utilization ?? 0),
            sevenDayResetsAt: data.seven_day?.resets_at ?? null
          }
          return cachedClaudeOAuthUsage
        }
      }
    } catch {
      // fall through to cachedUsageUtilization in ~/.claude.json
    }
  }

  // Fallback to ~/.claude.json cachedUsageUtilization if offline
  const claudeJson = join(home, '.claude.json')
  if (existsSync(claudeJson)) {
    try {
      const cj = JSON.parse(readFileSync(claudeJson, 'utf8')) as {
        cachedUsageUtilization?: {
          utilization?: {
            five_hour?: { utilization?: number; resets_at?: string | null }
            seven_day?: { utilization?: number; resets_at?: string | null }
          }
        }
      }
      const u = cj.cachedUsageUtilization?.utilization
      if (u) {
        const fiveReset = u.five_hour?.resets_at ? Date.parse(u.five_hour.resets_at) : 0
        const sevenReset = u.seven_day?.resets_at ? Date.parse(u.seven_day.resets_at) : 0
        cachedClaudeOAuthUsage = {
          fetchedAt: now,
          fiveHourPct: fiveReset > now ? Math.round(u.five_hour?.utilization ?? 0) : 0,
          fiveHourResetsAt: fiveReset > now ? (u.five_hour?.resets_at ?? null) : null,
          sevenDayPct: sevenReset > now ? Math.round(u.seven_day?.utilization ?? 0) : 0,
          sevenDayResetsAt: sevenReset > now ? (u.seven_day?.resets_at ?? null) : null
        }
        return cachedClaudeOAuthUsage
      }
    } catch {
      // ignore
    }
  }
  return null
}

let cachedAgyBrainActivity: {
  at: number
  windowTurns: number
  windowTokens: number
  todayTokens: number
  oldestInWindowMs: number | null
} | null = null

/** Scan ~/.gemini/antigravity/brain and ~/.gemini/antigravity-cli/brain for real 5-hour rolling activity. */
function scanAgyActivity(windowStartMs: number, todayStartMs: number): {
  windowTurns: number
  windowTokens: number
  todayTokens: number
  oldestInWindowMs: number | null
} {
  const now = Date.now()
  if (cachedAgyBrainActivity && now - cachedAgyBrainActivity.at < 15_000) {
    return cachedAgyBrainActivity
  }
  let windowTurns = 0
  let windowTokens = 0
  let todayTokens = 0
  let oldestInWindowMs: number | null = null

  const home = homedir()
  const roots = [
    join(home, '.gemini', 'antigravity', 'brain'),
    join(home, '.gemini', 'antigravity-cli', 'brain')
  ]

  for (const root of roots) {
    if (!existsSync(root)) continue
    try {
      const convos = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
      for (const c of convos) {
        const transcript = join(root, c.name, '.system_generated', 'logs', 'transcript.jsonl')
        if (!existsSync(transcript)) continue
        const st = statSync(transcript)
        if (st.mtimeMs < todayStartMs) continue
        const raw = readFileSync(transcript, 'utf8')
        for (const line of raw.split('\n')) {
          if (!line.includes('PLANNER_RESPONSE')) continue
          try {
            const obj = JSON.parse(line) as { created_at?: string; type?: string }
            if (obj.type !== 'PLANNER_RESPONSE') continue
            const ts = obj.created_at ? Date.parse(obj.created_at) : st.mtimeMs
            const estTokens = Math.max(600, Math.round(line.length / 3.5))
            if (ts >= todayStartMs) todayTokens += estTokens
            if (ts >= windowStartMs) {
              windowTurns += 1
              windowTokens += estTokens
              if (oldestInWindowMs === null || ts < oldestInWindowMs) oldestInWindowMs = ts
            }
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
  }

  cachedAgyBrainActivity = { at: now, windowTurns, windowTokens, todayTokens, oldestInWindowMs }
  return cachedAgyBrainActivity
}

export async function computeLimitInfo(cli: CliId, authenticated: boolean, detectedPlan?: string, forceRefresh = false): Promise<CliLimitInfo> {
  const windowHours = 5
  const nowMs = Date.now()
  const windowStartMs = nowMs - windowHours * 3600_000
  const todayStartMs = nowMs - 24 * 3600_000
  const weekStartMs = nowMs - 7 * 24 * 3600_000

  const budget = windowBudgetFor(cli, detectedPlan)

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

  // 1. For Claude Code: use official Anthropic OAuth Usage endpoint (`five_hour` & `seven_day` utilization!)
  if (cli === 'claude') {
    const liveClaude = await fetchLiveClaudeOAuthUsage(forceRefresh)
    if (liveClaude) {
      const pct = rateEv?.status === 'rejected' ? 100 : liveClaude.fiveHourPct
      let resetInLabel = '5h window ready'
      if (liveClaude.fiveHourResetsAt) {
        const resetMs = Date.parse(liveClaude.fiveHourResetsAt) - nowMs
        if (resetMs > 0) resetInLabel = `Resets in ${formatDurationShort(resetMs)}`
      }
      let weeklyResetInLabel: string | undefined
      if (liveClaude.sevenDayResetsAt) {
        const wMs = Date.parse(liveClaude.sevenDayResetsAt) - nowMs
        if (wMs > 0) weeklyResetInLabel = `7d resets in ${formatDurationShort(wMs)}`
      }
      const status: CliLimitInfo['status'] =
        pct >= 100 ? 'rejected' : pct >= 80 ? 'warning' : 'ok'

      return {
        windowHours,
        usedTokens: windowStats.tokens,
        usedRequests: windowStats.reqs,
        usedMs: windowStats.ms,
        maxRequestsWindow: budget.maxRequests,
        maxTokensWindow: budget.maxTokens,
        utilizationPct: pct,
        weeklyUtilizationPct: liveClaude.sevenDayPct,
        weeklyResetInLabel,
        status,
        resetsAt: liveClaude.fiveHourResetsAt,
        resetInLabel,
        todayTokens: todayStats.tokens,
        todayRequests: todayStats.reqs,
        weekTokens: weekStats.tokens,
        liveNote: `Weekly: ${liveClaude.sevenDayPct}% used`
      }
    }
  }

  // 2. For Antigravity: combine AI Hub usage_logs with real ~/.gemini/antigravity brain turns in the last 5h
  if (cli === 'agy') {
    const agyAct = scanAgyActivity(windowStartMs, todayStartMs)
    windowStats.reqs = Math.max(windowStats.reqs, agyAct.windowTurns)
    windowStats.tokens = Math.max(windowStats.tokens, agyAct.windowTokens)
    todayStats.tokens = Math.max(todayStats.tokens, agyAct.todayTokens)
    if (agyAct.oldestInWindowMs && (!windowStats.oldest || agyAct.oldestInWindowMs < windowStats.oldest)) {
      windowStats.oldest = agyAct.oldestInWindowMs
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
  let resetInLabel = '5h window ready'

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
    liveNote: windowStats.reqs > 0 ? `${windowStats.reqs} turns in 5h window` : undefined
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
  if (opts.cli === 'claude') cachedClaudeOAuthUsage = null
  if (opts.cli === 'agy') cachedAgyBrainActivity = null
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

/** Parse `agy models` tab-separated output: `<id>\t<Display Name (Tier)>` */
async function loadDynamicAgyModels(exePath: string): Promise<CliModel[]> {
  if (dynamicAgyModels !== null) return dynamicAgyModels
  if (!exePath) return []
  return new Promise((resolve) => {
    execFile(exePath, ['models'], { windowsHide: true, timeout: 6000 }, (err, out) => {
      if (err || !out) {
        dynamicAgyModels = []
        return resolve([])
      }
      const parsed: CliModel[] = []
      for (const rawLine of out.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line || line.startsWith('Fetching')) continue
        const parts = line.split(/\t+/)
        const id = parts[0]?.trim() ?? ''
        if (!/^[a-z0-9][\w.:-]*$/i.test(id) || !/\d/.test(id)) continue
        const labelPart = parts[1]?.trim() ?? id
        const tierMatch = labelPart.match(/\(([^)]+)\)\s*$/)
        const tier = tierMatch ? tierMatch[1] : /high/i.test(id) ? 'High' : /low/i.test(id) ? 'Low' : 'Medium'
        const cleanName = labelPart.replace(/\s*\([^)]+\)\s*$/, '').trim()
        parsed.push({
          id,
          name: cleanName || id,
          tier,
          cli: 'agy',
          description: `${cleanName} (${tier}) via Antigravity CLI`
        })
      }
      dynamicAgyModels = parsed
      resolve(parsed)
    }).stdin?.end()
  })
}

/** Read Claude Code's official cached model catalog from `~/.claude/cache/model-catalog/*.json` if present. */
function loadClaudeCatalogModels(): CliModel[] {
  try {
    const dir = join(homedir(), '.claude', 'cache', 'model-catalog')
    if (!existsSync(dir)) return CATALOG_MODELS.claude
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('-cc.json') || f.endsWith('-ccd.json'))
      .map((f) => ({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    if (!files.length) return CATALOG_MODELS.claude

    const raw = JSON.parse(readFileSync(files[0].path, 'utf8')) as {
      catalog?: {
        config?: {
          models?: {
            id: string
            name: string
            description?: string
            section?: string
            badge?: { message?: string }
            runtime?: { default_effort?: string }
          }[]
        }
      }
    }
    const list = raw.catalog?.config?.models
    if (!list?.length) return CATALOG_MODELS.claude

    return list.map((m) => {
      const effort = m.runtime?.default_effort ?? 'high'
      const tier = effort === 'xhigh' || effort === 'max' ? 'Max' : effort === 'high' ? 'High' : 'Medium'
      const badgeText = m.badge?.message ? ` · ${m.badge.message}` : ''
      return {
        id: m.id,
        name: m.name.startsWith('Claude ') ? m.name : `Claude ${m.name}`,
        tier,
        cli: 'claude' as const,
        description: `${m.description || m.name}${badgeText}`
      }
    })
  } catch {
    return CATALOG_MODELS.claude
  }
}

export const clis = {
  /** All 5 AI subscriptions with live authentication state, up-to-date models, and live 5-hour/7-day usage limits. */
  statusAll: async (forceRefresh = false): Promise<CliSubscriptionStatus[]> => {
    if (forceRefresh) {
      dynamicAgyModels = null
      cachedClaudeOAuthUsage = null
      cachedAgyBrainActivity = null
    }
    const meta: {
      id: CliId
      name: string
      shortName: string
      provider: string
      accentColor: string
      loginCommand: string
      installCommand: string
    }[] = [
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
        id: 'codex',
        name: 'OpenAI Codex',
        shortName: 'Codex',
        provider: 'OpenAI',
        accentColor: '#10b981',
        loginCommand: 'codex login',
        installCommand: 'npm install -g @openai/codex'
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
      const budget = windowBudgetFor(m.id, auth.detectedPlan)
      let models = [...CATALOG_MODELS[m.id]]

      if (m.id === 'agy' && exePath) {
        const dyn = await loadDynamicAgyModels(exePath)
        if (dyn.length > 0) {
          // Put Gemini 4 Argon High first, followed by the rest of `agy models`
          const argonHigh = dyn.find((x) => x.id === 'gemini-4-argon-high')
          models = argonHigh ? [argonHigh, ...dyn.filter((x) => x.id !== 'gemini-4-argon-high')] : dyn
        }
      } else if (m.id === 'claude') {
        models = loadClaudeCatalogModels()
      }

      const limit = await computeLimitInfo(m.id, auth.authenticated, auth.detectedPlan, forceRefresh)

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
        limit
      })
    }
    return out
  },

  clearRateLimit: (cli: CliId): true => {
    run('DELETE FROM cli_rate_events WHERE cli = ?', cli)
    return true
  },

  recentUsage: (): { id: number; cli: CliId; model: string; tokens: number; duration_ms: number; created_at: string }[] =>
    all('SELECT id, cli, model, tokens, duration_ms, created_at FROM usage_logs ORDER BY id DESC LIMIT 40')
}
