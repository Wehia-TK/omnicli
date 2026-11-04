import { execFile, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CliId, CliLimitInfo, CliModel, CliSubscriptionStatus, EffortLevel, ModelLimitBucket } from '@shared/types'
import { all, get, nowLocal, run, runSilent } from './db'
import { getSettings } from './settings'

const CATALOG_MODELS: Record<CliId, CliModel[]> = {
  agy: [
    {
      id: 'gemini-4-argon',
      name: 'Gemini 4 Argon',
      tier: 'Flagship',
      cli: 'agy',
      description: 'Deep-reasoning flagship model in Antigravity',
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
      effortModelMap: {
        low: 'gemini-4-argon-low',
        medium: 'gemini-4-argon-medium',
        high: 'gemini-4-argon-high'
      }
    },
    {
      id: 'gemini-3.8-flash',
      name: 'Gemini 3.8 Flash',
      tier: 'Fast',
      cli: 'agy',
      description: 'Fast frontier model for everyday coding & tool execution',
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      effortModelMap: {
        low: 'gemini-3.8-flash-low',
        medium: 'gemini-3.8-flash-medium',
        high: 'gemini-3.8-flash-high'
      }
    },
    {
      id: 'claude-opus-5-5',
      name: 'Claude Opus 5.5',
      tier: 'Opus',
      cli: 'agy',
      description: 'Anthropic Opus 5.5 via Antigravity',
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
      effortModelMap: {
        low: 'claude-opus-5-5-low',
        medium: 'claude-opus-5-5-medium',
        high: 'claude-opus-5-5-high'
      }
    },
    {
      id: 'claude-sonnet-5-5',
      name: 'Claude Sonnet 5.5',
      tier: 'Sonnet',
      cli: 'agy',
      description: 'Anthropic Sonnet 5.5 via Antigravity',
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      effortModelMap: {
        low: 'claude-sonnet-5-5-low',
        medium: 'claude-sonnet-5-5-medium',
        high: 'claude-sonnet-5-5-high'
      }
    },
    {
      id: 'gpt-oss-120b',
      name: 'GPT-OSS 120B',
      tier: 'Open',
      cli: 'agy',
      description: 'Open-weight 120B model via Antigravity',
      efforts: ['medium'],
      defaultEffort: 'medium',
      effortModelMap: {
        medium: 'gpt-oss-120b-medium'
      }
    }
  ],
  claude: [
    {
      id: 'claude-opus-5-5',
      name: 'Claude Opus 5.5',
      tier: '1M ctx',
      cli: 'claude',
      description: 'For complex work and everyday tasks',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'medium'
    },
    {
      id: 'claude-sonnet-5-5',
      name: 'Claude Sonnet 5.5',
      tier: '1M ctx',
      cli: 'claude',
      description: 'Most efficient for simpler tasks',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'medium'
    },
    {
      id: 'claude-fable-5-1',
      name: 'Claude Fable 5.1',
      tier: 'Credits',
      cli: 'claude',
      description: 'For your toughest challenges · Requires usage credits',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high'
    },
    {
      id: 'claude-haiku-5-5',
      name: 'Claude Haiku 5.5',
      tier: 'Fast',
      cli: 'claude',
      description: 'Fastest for quick answers',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'medium'
    },
    {
      id: 'claude-opus-5',
      name: 'Claude Opus 5',
      tier: '1M ctx',
      cli: 'claude',
      description: 'Previous-generation Opus 5',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'medium'
    },
    {
      id: 'claude-sonnet-5',
      name: 'Claude Sonnet 5',
      tier: '1M ctx',
      cli: 'claude',
      description: 'Previous-generation Sonnet 5',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high'
    }
  ],
  codex: [
    {
      id: 'gpt-5.2-codex',
      name: 'GPT-5.2 Codex',
      tier: 'Flagship',
      cli: 'codex',
      description: 'OpenAI flagship software engineering agent',
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'high'
    },
    {
      id: 'gpt-5-codex',
      name: 'GPT-5 Codex',
      tier: 'Codex',
      cli: 'codex',
      description: 'Deep full-repo coding and debugging',
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'high'
    },
    {
      id: 'o4-high',
      name: 'OpenAI o4',
      tier: 'Reasoning',
      cli: 'codex',
      description: 'Deep reasoning for hard algorithmic & systems tasks',
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'high'
    },
    {
      id: 'o4-mini',
      name: 'OpenAI o4-mini',
      tier: 'Fast',
      cli: 'codex',
      description: 'Fast reasoning with high rate limits on ChatGPT Plus/Pro',
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium'
    }
  ],
  copilot: [
    {
      id: 'claude-sonnet-5-5',
      name: 'Copilot · Sonnet 5.5',
      tier: 'Sonnet',
      cli: 'copilot',
      description: 'Claude Sonnet 5.5 via GitHub Copilot CLI',
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium'
    },
    {
      id: 'claude-opus-5-5',
      name: 'Copilot · Opus 5.5',
      tier: 'Opus',
      cli: 'copilot',
      description: 'Claude Opus 5.5 via GitHub Copilot CLI',
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'high'
    },
    {
      id: 'gpt-5.2',
      name: 'Copilot · GPT-5.2',
      tier: 'Fast',
      cli: 'copilot',
      description: 'OpenAI GPT-5.2 via GitHub Copilot CLI',
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium'
    }
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

const exeCache = new Map<string, { path: string; at: number }>()

/** Cached for 60s — `where.exe` is a blocking spawn and this is called from hot paths. */
export function findCliExecutable(cli: CliId): string {
  const s = getSettings()
  const key = `${cli}|${s[`${cli}Path` as 'claudePath'] ?? ''}`
  const hit = exeCache.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.path
  const path = locateCliExecutable(cli, s)
  exeCache.set(key, { path, at: Date.now() })
  return path
}

function locateCliExecutable(cli: CliId, s: ReturnType<typeof getSettings>): string {
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
    let rateTier = ''
    if (existsSync(credsJson)) {
      try {
        const creds = JSON.parse(readFileSync(credsJson, 'utf8')) as {
          claudeAiOauth?: { subscriptionType?: string; accessToken?: string; rateLimitTier?: string }
        }
        subType = creds.claudeAiOauth?.subscriptionType || ''
        rateTier = creds.claudeAiOauth?.rateLimitTier || ''
      } catch {
        // ignore
      }
    }
    const hasAuthFiles = Boolean(email) || existsSync(credsJson)
    const installed = Boolean(exePath)
    const planName =
      /20x/i.test(rateTier)
        ? 'Claude Max 20x'
        : /5x/i.test(rateTier)
          ? 'Claude Max 5x'
          : subType === 'max' || orgType.includes('max')
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
    // Prefer the tier detected from ~/.claude/.credentials.json (rateLimitTier) over the manual setting
    const tier = detectedPlan?.includes('20x') ? 'max20x' : detectedPlan?.includes('5x') ? 'max5x' : s.claudeTier
    if (tier === 'max20x') return { maxTokens: 4_500_000, maxRequests: 900, planLabel: 'Claude Max 20x' }
    if (tier === 'max5x') return { maxTokens: 1_200_000, maxRequests: 225, planLabel: 'Claude Max 5x' }
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

const resetLabel = (iso: string | null | undefined, nowMs: number, fallback = '5h window ready'): string => {
  if (!iso) return fallback
  const ms = Date.parse(iso) - nowMs
  return Number.isNaN(ms) || ms <= 0 ? fallback : `Resets in ${formatDurationShort(ms)}`
}

const statusFor = (pct: number): 'ok' | 'warning' | 'rejected' => (pct >= 100 ? 'rejected' : pct >= 80 ? 'warning' : 'ok')

// ───────────────────────────── Claude: live OAuth usage ─────────────────────────────

interface LiveWindow {
  pct: number
  resetsAt: string | null
}

interface LiveClaudeOAuthUsage {
  fetchedAt: number
  fiveHour: LiveWindow
  sevenDay: LiveWindow
  perModel: { key: string; label: string; match: RegExp; window: LiveWindow }[]
}

let cachedClaudeOAuthUsage: LiveClaudeOAuthUsage | null = null
let claudeUsageInFlight: Promise<LiveClaudeOAuthUsage | null> | null = null

/** Real live 5-hour session, 7-day weekly and per-model weekly usage from Anthropic's OAuth usage endpoint (falls back to ~/.claude.json). */
async function fetchLiveClaudeOAuthUsage(force = false): Promise<LiveClaudeOAuthUsage | null> {
  const now = Date.now()
  if (!force && cachedClaudeOAuthUsage && now - cachedClaudeOAuthUsage.fetchedAt < 45_000) return cachedClaudeOAuthUsage
  if (claudeUsageInFlight) return claudeUsageInFlight
  claudeUsageInFlight = (async () => {
    type W = { utilization?: number | null; resets_at?: string | null } | null | undefined
    const win = (w: W): LiveWindow => {
      const resetsAt = w?.resets_at ?? null
      const expired = resetsAt ? Date.parse(resetsAt) <= now : false
      return { pct: expired ? 0 : Math.round(w?.utilization ?? 0), resetsAt: expired ? null : resetsAt }
    }
    const build = (d: Record<string, W>): LiveClaudeOAuthUsage => ({
      fetchedAt: now,
      fiveHour: win(d.five_hour),
      sevenDay: win(d.seven_day),
      perModel: [
        { key: 'seven_day_opus', label: 'Opus · weekly', match: /opus/i },
        { key: 'seven_day_sonnet', label: 'Sonnet · weekly', match: /sonnet/i }
      ]
        .filter((m) => d[m.key] && d[m.key]?.utilization != null)
        .map((m) => ({ ...m, window: win(d[m.key]) }))
    })

    const home = homedir()
    const credsPath = join(home, '.claude', '.credentials.json')
    if (existsSync(credsPath)) {
      try {
        const creds = JSON.parse(readFileSync(credsPath, 'utf8')) as { claudeAiOauth?: { accessToken?: string; expiresAt?: number } }
        const token = creds.claudeAiOauth?.accessToken
        const notExpired = !creds.claudeAiOauth?.expiresAt || creds.claudeAiOauth.expiresAt > now
        if (token && notExpired) {
          const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
            headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' },
            signal: AbortSignal.timeout(4500)
          })
          if (res.ok) return (cachedClaudeOAuthUsage = build((await res.json()) as Record<string, W>))
        }
      } catch {
        // offline — fall through to the CLI's own cache
      }
    }
    const claudeJson = join(home, '.claude.json')
    if (existsSync(claudeJson)) {
      try {
        const cj = JSON.parse(readFileSync(claudeJson, 'utf8')) as { cachedUsageUtilization?: { utilization?: Record<string, W> } }
        const u = cj.cachedUsageUtilization?.utilization
        if (u) return (cachedClaudeOAuthUsage = build(u))
      } catch {
        // ignore
      }
    }
    return null
  })().finally(() => {
    claudeUsageInFlight = null
  })
  return claudeUsageInFlight
}

// ───────────────────── Real token counts from the CLIs' own transcripts ─────────────────────

interface TranscriptTotals {
  at: number
  window: { tokens: number; turns: number; oldest: number | null }
  today: { tokens: number; turns: number }
  week: { tokens: number }
  /** tokens / turns in the 5h window per base model id */
  byModel: Map<string, { tokens: number; turns: number; oldest: number | null }>
}

const emptyTotals = (): TranscriptTotals => ({
  at: Date.now(),
  window: { tokens: 0, turns: 0, oldest: null },
  today: { tokens: 0, turns: 0 },
  week: { tokens: 0 },
  byModel: new Map()
})

function addTurn(t: TranscriptTotals, ts: number, tokens: number, model: string, starts: { window: number; today: number; week: number }): void {
  if (ts < starts.week) return
  t.week.tokens += tokens
  if (ts >= starts.today) {
    t.today.tokens += tokens
    t.today.turns += 1
  }
  if (ts >= starts.window) {
    t.window.tokens += tokens
    t.window.turns += 1
    if (t.window.oldest === null || ts < t.window.oldest) t.window.oldest = ts
    const key = model || 'unknown'
    const m = t.byModel.get(key) ?? { tokens: 0, turns: 0, oldest: null }
    m.tokens += tokens
    m.turns += 1
    if (m.oldest === null || ts < m.oldest) m.oldest = ts
    t.byModel.set(key, m)
  }
}

function listRecentFiles(root: string, test: (name: string) => boolean, sinceMs: number, maxDepth: number): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (depth < maxDepth) walk(full, depth + 1)
      } else if (test(e.name)) {
        try {
          if (statSync(full).mtimeMs >= sinceMs) out.push(full)
        } catch {
          // ignore
        }
      }
    }
  }
  if (existsSync(root)) walk(root, 0)
  return out
}

let cachedClaudeTranscripts: TranscriptTotals | null = null
let claudeScanInFlight: Promise<TranscriptTotals> | null = null

interface ParsedTurn {
  ts: number
  tokens: number
  model: string
  /** de-dupe key (Claude repeats a message across resumed sessions) */
  id?: string
}

/** Per-file parse cache: transcripts are append-only, so only the bytes added since the last scan are read. */
const turnCache = new Map<string, { size: number; mtime: number; offset: number; turns: ParsedTurn[] }>()

/** Yield to the event loop so IPC and window events keep flowing during a long scan. */
const yieldLoop = (): Promise<void> => new Promise((r) => setImmediate(r))

/**
 * Turns parsed from one JSONL transcript, reading only new complete lines (async, non-blocking).
 * Re-reads from scratch when the file shrank (rotated/rewritten).
 */
async function readTurnsIncremental(file: string, parseLine: (line: string) => ParsedTurn | null): Promise<ParsedTurn[]> {
  let st: Awaited<ReturnType<typeof stat>>
  try {
    st = await stat(file)
  } catch {
    turnCache.delete(file)
    return []
  }
  let entry = turnCache.get(file)
  if (entry && entry.size === st.size && entry.mtime === st.mtimeMs) return entry.turns
  if (!entry || st.size < entry.offset) entry = { size: 0, mtime: 0, offset: 0, turns: [] }
  const len = st.size - entry.offset
  if (len > 0) {
    let fh: Awaited<ReturnType<typeof open>> | null = null
    try {
      fh = await open(file, 'r')
      const buf = Buffer.alloc(len)
      const { bytesRead } = await fh.read(buf, 0, len, entry.offset)
      // Only consume whole lines; a half-written last line is picked up next time
      const lastNl = buf.subarray(0, bytesRead).lastIndexOf(0x0a)
      if (lastNl >= 0) {
        const lines = buf.subarray(0, lastNl).toString('utf8').split('\n')
        for (let i = 0; i < lines.length; i++) {
          const t = parseLine(lines[i])
          if (t) entry.turns.push(t)
          if (i % 2000 === 1999) await yieldLoop()
        }
        entry.offset += lastNl + 1
      }
    } catch {
      return entry.turns
    } finally {
      await fh?.close().catch(() => undefined)
    }
  }
  entry.size = st.size
  entry.mtime = st.mtimeMs
  turnCache.set(file, entry)
  return entry.turns
}

function parseClaudeLine(line: string): ParsedTurn | null {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return null
  try {
    const o = JSON.parse(line) as {
      type?: string
      timestamp?: string
      message?: { id?: string; model?: string; usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number } }
    }
    const id = o.message?.id
    if (o.type !== 'assistant' || !id || !o.message?.usage) return null
    const u = o.message.usage
    const ts = o.timestamp ? Date.parse(o.timestamp) : 0
    if (!ts) return null
    return {
      id,
      ts,
      tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      model: (o.message.model ?? '').replace(/\[.*\]$/, '')
    }
  } catch {
    return null // partial line
  }
}

/** Sum real token usage from Claude Code transcripts (~/.claude/projects/**.jsonl) — includes usage from Claude Desktop & terminal, not just AI Hub. */
async function scanClaudeTranscripts(starts: { window: number; today: number; week: number }): Promise<TranscriptTotals> {
  if (cachedClaudeTranscripts && Date.now() - cachedClaudeTranscripts.at < 30_000) return cachedClaudeTranscripts
  if (claudeScanInFlight) return claudeScanInFlight
  claudeScanInFlight = (async () => {
    const totals = emptyTotals()
    const seen = new Set<string>()
    for (const file of listRecentFiles(join(homedir(), '.claude', 'projects'), (n) => n.endsWith('.jsonl'), starts.week, 3)) {
      for (const t of await readTurnsIncremental(file, parseClaudeLine)) {
        if (t.id) {
          if (seen.has(t.id)) continue
          seen.add(t.id)
        }
        addTurn(totals, t.ts, t.tokens, t.model, starts)
      }
      await yieldLoop()
    }
    return (cachedClaudeTranscripts = totals)
  })().finally(() => {
    claudeScanInFlight = null
  })
  return claudeScanInFlight
}

let cachedAgyTranscripts: TranscriptTotals | null = null
let agyScanInFlight: Promise<TranscriptTotals> | null = null

function parseAgyLine(line: string): ParsedTurn | null {
  if (!line.includes('PLANNER_RESPONSE')) return null
  try {
    const o = JSON.parse(line) as { type?: string; created_at?: string; input_tokens?: number; output_tokens?: number }
    if (o.type !== 'PLANNER_RESPONSE') return null
    const ts = o.created_at ? Date.parse(o.created_at) : 0
    if (!ts) return null
    return { ts, tokens: (o.input_tokens ?? 0) + (o.output_tokens ?? 0) || Math.round(line.length / 3.5), model: '' }
  } catch {
    return null
  }
}

/** Real Antigravity token usage from ~/.gemini/antigravity*\/brain/*\/transcript.jsonl (input+output tokens per model turn). */
async function scanAgyTranscripts(starts: { window: number; today: number; week: number }): Promise<TranscriptTotals> {
  if (cachedAgyTranscripts && Date.now() - cachedAgyTranscripts.at < 20_000) return cachedAgyTranscripts
  if (agyScanInFlight) return agyScanInFlight
  agyScanInFlight = (async () => {
    const totals = emptyTotals()
    // Conversations started from AI Hub know their model; others are attributed to "unknown"
    const convModel = new Map<string, string>()
    try {
      for (const r of all<{ agy_conversation: string; model: string }>(
        "SELECT agy_conversation, model FROM project_tasks WHERE agy_conversation IS NOT NULL AND agy_conversation != ''"
      )) {
        convModel.set(r.agy_conversation, r.model)
      }
    } catch {
      // ignore
    }
    const home = homedir()
    for (const root of [join(home, '.gemini', 'antigravity', 'brain'), join(home, '.gemini', 'antigravity-cli', 'brain')]) {
      let convos: string[] = []
      try {
        convos = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
      } catch {
        continue
      }
      for (const c of convos) {
        const transcript = join(root, c, '.system_generated', 'logs', 'transcript.jsonl')
        try {
          const st = await stat(transcript)
          if (st.mtimeMs < starts.week) continue
        } catch {
          continue
        }
        const model = (convModel.get(c) ?? '').replace(/-(low|medium|high)$/i, '')
        for (const t of await readTurnsIncremental(transcript, parseAgyLine)) addTurn(totals, t.ts, t.tokens, model, starts)
        await yieldLoop()
      }
    }
    return (cachedAgyTranscripts = totals)
  })().finally(() => {
    agyScanInFlight = null
  })
  return agyScanInFlight
}
/** Exact token usage for one Antigravity conversation since a given time (used to bill a run accurately). */
export function agyConversationTokens(conversationId: string, sinceMs: number): number {
  const home = homedir()
  for (const root of [join(home, '.gemini', 'antigravity-cli', 'brain'), join(home, '.gemini', 'antigravity', 'brain')]) {
    const transcript = join(root, conversationId, '.system_generated', 'logs', 'transcript.jsonl')
    if (!existsSync(transcript)) continue
    let sum = 0
    try {
      for (const line of readFileSync(transcript, 'utf8').split('\n')) {
        if (!line.includes('PLANNER_RESPONSE')) continue
        try {
          const o = JSON.parse(line) as { created_at?: string; input_tokens?: number; output_tokens?: number }
          // created_at has second precision — allow a little slack
          if (o.created_at && Date.parse(o.created_at) >= sinceMs - 2000) sum += (o.input_tokens ?? 0) + (o.output_tokens ?? 0)
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
    return sum
  }
  return 0
}

/**
 * Actions Antigravity's print mode refused because nobody could answer its permission prompt
 * (reading files outside the project, running commands in Accept Edits mode, …).
 */
export function agyDeniedActions(conversationId: string, sinceMs: number): string[] {
  const home = homedir()
  for (const root of [join(home, '.gemini', 'antigravity-cli', 'brain'), join(home, '.gemini', 'antigravity', 'brain')]) {
    const dir = join(root, conversationId, '.system_generated', 'logs')
    const file = existsSync(join(dir, 'transcript_full.jsonl')) ? join(dir, 'transcript_full.jsonl') : join(dir, 'transcript.jsonl')
    if (!existsSync(file)) continue
    const out: string[] = []
    try {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.includes('permission check failed')) continue
        try {
          const o = JSON.parse(line) as { created_at?: string; error?: string }
          if (o.created_at && Date.parse(o.created_at) < sinceMs - 2000) continue
          const m = (o.error ?? '').match(/permission check failed for ([^"]*)"([^"]{0,160})/)
          const what = m ? `${m[1].trim().replace(/^unsandboxed$/, 'command')}: ${m[2]}` : (o.error ?? '').split('\n')[0].slice(0, 180)
          if (what && !out.includes(what)) out.push(what)
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
    return out
  }
  return []
}

// ───────────────────────────── Codex: live rate limits ─────────────────────────────

interface CodexLive {
  at: number
  primary: LiveWindow & { windowMinutes: number }
  secondary: (LiveWindow & { windowMinutes: number }) | null
}
let cachedCodexLive: { at: number; value: CodexLive | null } | null = null

/** Last maxBytes of a file (async) — enough to find the newest rate-limit line without reading huge rollouts. */
async function readTail(file: string, maxBytes: number): Promise<string> {
  const fh = await open(file, 'r')
  try {
    const { size } = await fh.stat()
    const len = Math.min(size, maxBytes)
    const buf = Buffer.alloc(len)
    const { bytesRead } = await fh.read(buf, 0, len, size - len)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await fh.close().catch(() => undefined)
  }
}

/** Codex writes the server's rate-limit snapshot into ~/.codex/sessions/**\/rollout-*.jsonl on every turn. */
async function readCodexLiveLimits(nowMs: number): Promise<CodexLive | null> {
  if (cachedCodexLive && nowMs - cachedCodexLive.at < 20_000) return cachedCodexLive.value
  let value: CodexLive | null = null
  const files = listRecentFiles(join(homedir(), '.codex', 'sessions'), (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'), nowMs - 7 * 86_400_000, 4)
    .map((f) => ({ f, m: statSync(f).mtimeMs }))
    .sort((a, b) => b.m - a.m)
  type Win = { used_percent?: number; window_minutes?: number; resets_at?: number | string; resets_in_seconds?: number }
  const conv = (w: Win | undefined, fileMtime: number): (LiveWindow & { windowMinutes: number }) | null => {
    if (!w || typeof w.used_percent !== 'number') return null
    let resetsMs = 0
    if (typeof w.resets_at === 'number') resetsMs = w.resets_at * (w.resets_at < 1e12 ? 1000 : 1)
    else if (typeof w.resets_at === 'string') resetsMs = Date.parse(w.resets_at)
    else if (typeof w.resets_in_seconds === 'number') resetsMs = fileMtime + w.resets_in_seconds * 1000
    const expired = resetsMs > 0 && resetsMs <= nowMs
    return {
      pct: expired ? 0 : Math.round(w.used_percent),
      resetsAt: resetsMs && !expired ? new Date(resetsMs).toISOString() : null,
      windowMinutes: w.window_minutes ?? 300
    }
  }
  for (const { f, m } of files.slice(0, 6)) {
    try {
      const lines = (await readTail(f, 512 * 1024)).split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('rate_limits')) continue
        const o = JSON.parse(lines[i]) as { payload?: { rate_limits?: { primary?: Win; secondary?: Win } }; rate_limits?: { primary?: Win; secondary?: Win } }
        const rl = o.payload?.rate_limits ?? o.rate_limits
        const primary = conv(rl?.primary, m)
        if (primary) {
          value = { at: nowMs, primary, secondary: conv(rl?.secondary, m) }
          break
        }
      }
    } catch {
      // ignore
    }
    if (value) break
  }
  cachedCodexLive = { at: nowMs, value }
  return value
}

// ───────────────────────────── Antigravity: live quota via `agy -p /usage` ─────────────────────────────

interface AgyQuotaGroup {
  name: string
  description?: string
  buckets: { id: string; name: string; window: string; remaining_fraction: number; reset_time?: string }[]
}
let cachedAgyQuota: { at: number; groups: AgyQuotaGroup[] | null } | null = null
let agyQuotaInFlight: Promise<AgyQuotaGroup[] | null> | null = null

/**
 * Antigravity's own `/usage` command returns the exact quota groups shown in the Antigravity app
 * (Gemini models / Claude & GPT models / Gemini 4 Argon, each with 5h + weekly windows). It runs locally,
 * costs 0 tokens, and the CLI uses its own sign-in — AI Hub never touches the token.
 */
async function fetchAgyLiveQuota(force = false): Promise<AgyQuotaGroup[] | null> {
  const now = Date.now()
  if (!force && cachedAgyQuota && now - cachedAgyQuota.at < 60_000) return cachedAgyQuota.groups
  if (agyQuotaInFlight) return agyQuotaInFlight
  const exe = findCliExecutable('agy')
  if (!exe || /\.(cmd|bat)$/i.test(exe)) return null
  agyQuotaInFlight = new Promise<AgyQuotaGroup[] | null>((resolve) => {
    execFile(exe, ['-p', '/usage', '--output-format', 'json'], { windowsHide: true, timeout: 25_000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      let groups: AgyQuotaGroup[] | null = null
      if (!err && out) {
        try {
          const j = JSON.parse(out.slice(out.indexOf('{'))) as { command?: { name?: string; data?: { groups?: AgyQuotaGroup[] } } }
          if (j.command?.name === 'usage' && Array.isArray(j.command.data?.groups)) groups = j.command.data!.groups!
        } catch {
          // not the structured usage payload
        }
      }
      cachedAgyQuota = { at: Date.now(), groups }
      resolve(groups)
    }).stdin?.end()
  }).finally(() => {
    agyQuotaInFlight = null
  })
  return agyQuotaInFlight
}

/** Which catalog models draw from a quota group: exact model-name groups ("Gemini 4 Argon") or vendor lists ("Models within this group: Gemini Flash, Claude Opus…"). */
function agyGroupModels(group: AgyQuotaGroup, catalog: CliModel[]): string[] {
  const gname = group.name.toLowerCase()
  const listed = (group.description ?? '').split(':')[1] ?? ''
  const vendors = listed
    .split(',')
    .map((s) => s.trim().toLowerCase().split(/\s+/)[0])
    .filter(Boolean)
  return catalog
    .filter((m) => {
      const name = m.name.toLowerCase()
      const id = m.id.toLowerCase()
      if (name.includes(gname) || gname.includes(name)) return true
      return vendors.some((v) => id.startsWith(v) || name.startsWith(v))
    })
    .map((m) => m.id)
}

export async function refreshAgyQuota(): Promise<void> {
  await fetchAgyLiveQuota(true)
}

const agyCatalog = (): CliModel[] => (dynamicAgyModels?.length ? dynamicAgyModels : CATALOG_MODELS.agy)

function agyBucketsFor(modelId: string): AgyQuotaGroup['buckets'] {
  const groups = cachedAgyQuota?.groups ?? []
  return groups.flatMap((g) => (agyGroupModels(g, agyCatalog()).includes(modelId) ? g.buckets : []))
}

/** True when any quota window this model draws from is (almost) empty, per the last /usage read. */
export function agyModelExhausted(modelId: string): boolean {
  return agyBucketsFor(modelId).some((b) => (b.remaining_fraction ?? 1) <= 0.02)
}

/** A model from a different quota group that still has room, preferring the strongest (catalog order). */
export function pickAgyAlternative(current: string, tried: Set<string>): string | null {
  const blocked = new Set(agyBucketsFor(current).filter((b) => (b.remaining_fraction ?? 1) <= 0.02).map((b) => b.id))
  for (const m of agyCatalog()) {
    if (m.id === current || tried.has(m.id)) continue
    const buckets = agyBucketsFor(m.id)
    if (!buckets.length && cachedAgyQuota?.groups) continue
    if (buckets.some((b) => blocked.has(b.id) || (b.remaining_fraction ?? 1) <= 0.02)) continue
    return m.id
  }
  return null
}

// ───────────────────────────── Antigravity per-model quota buckets ─────────────────────────────

/** Antigravity meters model families separately (Gemini Pro, Gemini Flash, Anthropic, OpenAI). */
export function agyModelFamily(modelId: string): { key: string; label: string } {
  const id = modelId.toLowerCase()
  if (id.includes('flash')) return { key: 'gemini-flash', label: 'Gemini Flash' }
  if (id.startsWith('gemini') || id.includes('argon')) return { key: 'gemini-pro', label: 'Gemini Pro / Argon' }
  if (id.startsWith('claude')) return { key: 'anthropic', label: 'Claude models' }
  if (id.startsWith('gpt') || id.includes('oss')) return { key: 'openai', label: 'GPT-OSS' }
  return { key: 'other', label: 'Other models' }
}

function agyFamilyBudget(key: string): number {
  const pro = getSettings().agyTier === 'pro'
  const base: Record<string, number> = { 'gemini-pro': 1_500_000, 'gemini-flash': 4_000_000, anthropic: 1_000_000, openai: 1_500_000, other: 1_000_000 }
  return Math.round((base[key] ?? 1_000_000) * (pro ? 1 : 0.35))
}

// ───────────────────────────── Rate-limit events (expiring) ─────────────────────────────

interface RateEvent {
  cli: string
  status: string
  utilization_pct: number | null
  resets_at: string | null
  note: string
  updated_at: string
}

/** A recorded rejection only counts until its reset time (or 5h after it was seen when the CLI gave no reset time). */
function activeRateEvent(key: string, nowMs: number): RateEvent | undefined {
  const ev = get<RateEvent>('SELECT * FROM cli_rate_events WHERE cli = ?', key)
  if (!ev) return undefined
  const until = ev.resets_at ? Date.parse(ev.resets_at) : Date.parse(ev.updated_at) + 5 * 3600_000
  if (Number.isNaN(until) || until <= nowMs) return undefined
  return ev
}

export async function computeLimitInfo(cli: CliId, authenticated: boolean, detectedPlan?: string, forceRefresh = false): Promise<CliLimitInfo> {
  const windowHours = 5
  const nowMs = Date.now()
  const starts = { window: nowMs - windowHours * 3600_000, today: nowMs - 24 * 3600_000, week: nowMs - 7 * 24 * 3600_000 }
  const budget = windowBudgetFor(cli, detectedPlan)

  const base: CliLimitInfo = {
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
    weekTokens: 0,
    source: 'estimated'
  }
  if (!authenticated) return base

  // AI Hub's own run log (always available)
  const hub = (since: number): { tokens: number; reqs: number; ms: number; oldest: number | null } =>
    get<{ tokens: number; reqs: number; ms: number; oldest: number | null }>(
      `SELECT COALESCE(SUM(tokens), 0) AS tokens, COUNT(*) AS reqs, COALESCE(SUM(duration_ms), 0) AS ms, MIN(epoch_ms) AS oldest
       FROM usage_logs WHERE cli = ? AND epoch_ms >= ?`,
      cli,
      since
    ) ?? { tokens: 0, reqs: 0, ms: 0, oldest: null }
  const win = hub(starts.window)
  const today = hub(starts.today)
  const week = hub(starts.week)
  const out: CliLimitInfo = {
    ...base,
    status: 'ok',
    resetInLabel: '5h window ready',
    usedTokens: win.tokens,
    usedRequests: win.reqs,
    usedMs: win.ms,
    todayTokens: today.tokens,
    todayRequests: today.reqs,
    weekTokens: week.tokens
  }

  const rateEv = activeRateEvent(cli, nowMs)

  if (cli === 'claude') {
    const tx = await scanClaudeTranscripts(starts)
    out.usedTokens = Math.max(win.tokens, tx.window.tokens)
    out.usedRequests = Math.max(win.reqs, tx.window.turns)
    out.todayTokens = Math.max(today.tokens, tx.today.tokens)
    out.todayRequests = Math.max(today.reqs, tx.today.turns)
    out.weekTokens = Math.max(week.tokens, tx.week.tokens)

    const live = await fetchLiveClaudeOAuthUsage(forceRefresh)
    if (live) {
      const pct = rateEv?.status === 'rejected' ? 100 : live.fiveHour.pct
      out.source = 'live'
      out.utilizationPct = pct
      out.status = statusFor(pct)
      out.resetsAt = live.fiveHour.resetsAt
      out.resetInLabel = resetLabel(live.fiveHour.resetsAt, nowMs)
      out.weeklyUtilizationPct = live.sevenDay.pct
      out.weeklyResetInLabel = live.sevenDay.resetsAt ? `7d resets in ${formatDurationShort(Date.parse(live.sevenDay.resetsAt) - nowMs)}` : undefined
      out.liveNote = `Live from Anthropic · weekly ${live.sevenDay.pct}%`
      const modelTokens = (re: RegExp): { tokens: number; turns: number } => {
        let tokens = 0
        let turns = 0
        for (const [id, v] of tx.byModel) if (re.test(id)) ((tokens += v.tokens), (turns += v.turns))
        return { tokens, turns }
      }
      out.modelBuckets = live.perModel.map((m) => {
        const used = modelTokens(m.match)
        return {
          key: m.key,
          label: m.label,
          modelIds: [],
          utilizationPct: m.window.pct,
          usedTokens: used.tokens,
          usedRequests: used.turns,
          status: statusFor(m.window.pct),
          resetInLabel: resetLabel(m.window.resetsAt, nowMs, '7d window ready'),
          window: '7d' as const,
          source: 'live' as const
        }
      })
      return out
    }
  }

  if (cli === 'codex') {
    const live = await readCodexLiveLimits(nowMs)
    if (live) {
      out.source = 'live'
      out.utilizationPct = rateEv?.status === 'rejected' ? 100 : live.primary.pct
      out.status = statusFor(out.utilizationPct)
      out.resetsAt = live.primary.resetsAt
      out.resetInLabel = resetLabel(live.primary.resetsAt, nowMs)
      if (live.secondary) {
        out.weeklyUtilizationPct = live.secondary.pct
        out.weeklyResetInLabel = live.secondary.resetsAt ? `7d resets in ${formatDurationShort(Date.parse(live.secondary.resetsAt) - nowMs)}` : undefined
      }
      out.liveNote = 'Live from Codex session data'
      return out
    }
  }

  if (cli === 'agy') {
    const tx = await scanAgyTranscripts(starts)
    out.usedTokens = Math.max(win.tokens, tx.window.tokens)
    out.usedRequests = Math.max(win.reqs, tx.window.turns)
    out.todayTokens = Math.max(today.tokens, tx.today.tokens)
    out.todayRequests = Math.max(today.reqs, tx.today.turns)
    out.weekTokens = Math.max(week.tokens, tx.week.tokens)
    if (tx.window.oldest && (!win.oldest || tx.window.oldest < win.oldest)) win.oldest = tx.window.oldest

    const live = await fetchAgyLiveQuota(forceRefresh)
    if (live?.length) {
      const catalog = dynamicAgyModels?.length ? dynamicAgyModels : CATALOG_MODELS.agy
      const buckets: ModelLimitBucket[] = []
      for (const g of live) {
        const ids = agyGroupModels(g, catalog)
        for (const b of g.buckets) {
          const pct = Math.max(0, Math.min(100, Math.round((1 - (b.remaining_fraction ?? 1)) * 100)))
          const weekly = /week/i.test(b.window)
          buckets.push({
            key: b.id,
            label: `${g.name} · ${weekly ? 'weekly' : '5h'}`,
            modelIds: ids,
            utilizationPct: pct,
            usedTokens: ids.reduce((sum, id) => sum + (tx.byModel.get(id)?.tokens ?? 0), 0),
            usedRequests: ids.reduce((sum, id) => sum + (tx.byModel.get(id)?.turns ?? 0), 0),
            status: statusFor(pct),
            resetInLabel: resetLabel(b.reset_time, nowMs, weekly ? '7d window ready' : '5h window ready'),
            window: weekly ? '7d' : '5h',
            source: 'live'
          })
        }
      }
      const worst = (w: '5h' | '7d'): ModelLimitBucket | undefined =>
        buckets.filter((b) => b.window === w).sort((a, b) => b.utilizationPct - a.utilizationPct)[0]
      const five = worst('5h')
      const week = worst('7d')
      const rejected = rateEv?.status === 'rejected' && (five?.utilizationPct ?? 0) >= 99
      out.source = 'live'
      out.modelBuckets = buckets
      out.utilizationPct = rejected ? 100 : (five?.utilizationPct ?? 0)
      out.status = statusFor(out.utilizationPct)
      out.resetInLabel = five?.resetInLabel ?? '5h window ready'
      out.resetsAt = live.flatMap((g) => g.buckets).find((b) => b.id === five?.key)?.reset_time ?? null
      if (week) {
        out.weeklyUtilizationPct = week.utilizationPct
        out.weeklyResetInLabel = week.resetInLabel.replace(/^Resets/, '7d resets')
      }
      out.liveNote = `Live from Antigravity · tightest weekly: ${week?.label ?? '—'}`
      return out
    }

    // Per-family buckets: Antigravity applies separate quotas per model family
    const families = new Map<string, { label: string; tokens: number; turns: number; oldest: number | null; ids: Set<string> }>()
    const catalog = dynamicAgyModels?.length ? dynamicAgyModels : CATALOG_MODELS.agy
    for (const m of catalog) {
      const f = agyModelFamily(m.id)
      const cur = families.get(f.key) ?? { label: f.label, tokens: 0, turns: 0, oldest: null, ids: new Set<string>() }
      cur.ids.add(m.id)
      families.set(f.key, cur)
    }
    for (const [model, v] of tx.byModel) {
      if (model === 'unknown') continue
      const f = families.get(agyModelFamily(model).key)
      if (!f) continue
      f.tokens += v.tokens
      f.turns += v.turns
      if (v.oldest && (f.oldest === null || v.oldest < f.oldest)) f.oldest = v.oldest
    }
    out.modelBuckets = [...families.entries()].map(([key, f]) => {
      const ev = activeRateEvent(`agy:${key}`, nowMs)
      const pct = ev?.status === 'rejected' ? 100 : Math.min(100, Math.round((f.tokens / agyFamilyBudget(key)) * 100))
      const resetIso = ev?.resets_at ?? (f.oldest ? new Date(f.oldest + windowHours * 3600_000).toISOString() : null)
      return {
        key,
        label: f.label,
        modelIds: [...f.ids],
        utilizationPct: pct,
        usedTokens: f.tokens,
        usedRequests: f.turns,
        status: statusFor(pct),
        resetInLabel: resetLabel(resetIso, nowMs),
        window: '5h' as const,
        source: ev ? ('live' as const) : ('estimated' as const)
      }
    })
    const unknown = tx.byModel.get('unknown')
    if (unknown) out.liveNote = `${unknown.turns} turns from Antigravity outside AI Hub (model not recorded)`
  }

  // Estimated path (Gemini, Copilot, Antigravity overall, and offline fallbacks)
  const tokenPct = (out.usedTokens / Math.max(1, budget.maxTokens)) * 100
  const reqPct = (out.usedRequests / Math.max(1, budget.maxRequests)) * 100
  let utilizationPct = Math.min(100, Math.round(Math.max(tokenPct, reqPct)))
  const bucketMax = Math.max(0, ...(out.modelBuckets ?? []).map((b) => b.utilizationPct))
  if (bucketMax > utilizationPct) utilizationPct = bucketMax
  if (rateEv?.utilization_pct != null && rateEv.utilization_pct > utilizationPct) utilizationPct = Math.min(100, Math.round(rateEv.utilization_pct))
  if (rateEv?.status === 'rejected') utilizationPct = 100

  let resetsAt: string | null = rateEv?.resets_at ?? null
  if (!resetsAt && win.oldest) {
    const resetEpoch = win.oldest + windowHours * 3600_000
    if (resetEpoch > nowMs) resetsAt = new Date(resetEpoch).toISOString()
  }
  out.utilizationPct = utilizationPct
  out.resetsAt = resetsAt
  out.resetInLabel = resetLabel(resetsAt, nowMs)
  out.status = rateEv?.status === 'rejected' ? 'rejected' : rateEv?.status === 'warning' ? (utilizationPct >= 100 ? 'rejected' : 'warning') : statusFor(utilizationPct)
  if (!out.liveNote && out.usedRequests > 0) out.liveNote = `${out.usedRequests} turns in 5h window (estimated budget)`
  return out
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
  if (opts.cli === 'claude') ((cachedClaudeOAuthUsage = null), (cachedClaudeTranscripts = null))
  if (opts.cli === 'agy') ((cachedAgyTranscripts = null), (cachedAgyQuota = null))
  if (opts.cli === 'codex') cachedCodexLive = null
  statusCache = null
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

/** Parse `agy models` tab-separated output and group effort variants (`-low`, `-medium`, `-high`) into single base models! */
async function loadDynamicAgyModels(exePath: string): Promise<CliModel[]> {
  if (dynamicAgyModels !== null) return dynamicAgyModels
  if (!exePath) return []
  return new Promise((resolve) => {
    execFile(exePath, ['models'], { windowsHide: true, timeout: 6000 }, (err, out) => {
      if (err || !out) {
        dynamicAgyModels = []
        return resolve([])
      }
      const grouped = new Map<string, CliModel>()
      for (const rawLine of out.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line || line.startsWith('Fetching')) continue
        const parts = line.split(/\t+/)
        const rawId = parts[0]?.trim() ?? ''
        if (!/^[a-z0-9][\w.:-]*$/i.test(rawId) || !/\d/.test(rawId)) continue
        const labelPart = parts[1]?.trim() ?? rawId

        // Extract effort suffix (`-high`, `-medium`, `-low`) from model ID
        const effortMatch = rawId.match(/^(.*?)-(low|medium|high)$/i)
        const baseId = effortMatch ? effortMatch[1] : rawId
        const effortVal = (effortMatch ? effortMatch[2].toLowerCase() : 'medium') as EffortLevel
        const cleanName = labelPart.replace(/\s*\([^)]+\)\s*$/, '').trim() || baseId

        const existing = grouped.get(baseId)
        if (existing) {
          if (!existing.efforts.includes(effortVal)) {
            existing.efforts.push(effortVal)
            const order: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
            existing.efforts.sort((a, b) => order.indexOf(a) - order.indexOf(b))
          }
          existing.effortModelMap = { ...(existing.effortModelMap ?? {}), [effortVal]: rawId }
          if (effortVal === 'high') existing.defaultEffort = 'high'
        } else {
          const tier = /argon/i.test(baseId)
            ? 'Flagship'
            : /flash/i.test(baseId)
              ? 'Fast'
              : /opus/i.test(baseId)
                ? 'Opus'
                : /sonnet/i.test(baseId)
                  ? 'Sonnet'
                  : 'Model'
          grouped.set(baseId, {
            id: baseId,
            name: cleanName,
            tier,
            cli: 'agy',
            description: `${cleanName} via Antigravity CLI`,
            efforts: [effortVal],
            defaultEffort: effortVal,
            effortModelMap: { [effortVal]: rawId }
          })
        }
      }
      const parsed = Array.from(grouped.values())
      // Put Gemini 4 Argon first
      const argon = parsed.find((x) => x.id === 'gemini-4-argon')
      dynamicAgyModels = argon ? [argon, ...parsed.filter((x) => x.id !== 'gemini-4-argon')] : parsed
      resolve(dynamicAgyModels)
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
            runtime?: {
              default_effort?: string
              effort_levels?: string[]
            }
          }[]
        }
      }
    }
    const list = raw.catalog?.config?.models
    if (!list?.length) return CATALOG_MODELS.claude

    const validEfforts = new Set<EffortLevel>(['low', 'medium', 'high', 'xhigh', 'max'])
    return list.map((m) => {
      const rawEfforts = (m.runtime?.effort_levels ?? ['low', 'medium', 'high', 'xhigh', 'max']).filter((e): e is EffortLevel =>
        validEfforts.has(e as EffortLevel)
      )
      const efforts: EffortLevel[] = rawEfforts.length ? rawEfforts : ['low', 'medium', 'high']
      const defRaw = (m.runtime?.default_effort ?? 'medium') as EffortLevel
      const defaultEffort: EffortLevel = efforts.includes(defRaw) ? defRaw : efforts[0]
      const badgeText = m.badge?.message ? ` · ${m.badge.message}` : ''
      const tier = m.badge?.message ? 'Credits' : /haiku/i.test(m.id) ? 'Fast' : '1M ctx'
      return {
        id: m.id,
        name: m.name.startsWith('Claude ') ? m.name : `Claude ${m.name}`,
        tier,
        cli: 'claude' as const,
        description: `${m.description || m.name}${badgeText}`,
        efforts,
        defaultEffort
      }
    })
  } catch {
    return CATALOG_MODELS.claude
  }
}

/** Resolve a base model ID + effort level into the exact CLI `--model` string and `--effort` flag. */
export function resolveCliModelWithEffort(
  cli: CliId,
  modelId: string,
  effort: EffortLevel
): { cliModelArg: string; effortArg: EffortLevel } {
  const cleanEffort: EffortLevel = ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort) ? effort : 'high'
  if (cli === 'agy') {
    // Strip any existing `-low|-medium|-high` suffix first
    const base = modelId.replace(/-(low|medium|high)$/i, '') || 'gemini-4-argon'
    const allAgy = dynamicAgyModels?.length ? dynamicAgyModels : CATALOG_MODELS.agy
    const found = allAgy.find((m) => m.id === base)
    const agyEffort: EffortLevel = cleanEffort === 'xhigh' || cleanEffort === 'max' ? 'high' : cleanEffort
    if (found?.effortModelMap) {
      const mapped =
        found.effortModelMap[agyEffort] ||
        found.effortModelMap[found.defaultEffort] ||
        Object.values(found.effortModelMap)[0]
      if (mapped) return { cliModelArg: mapped, effortArg: agyEffort }
    }
    return { cliModelArg: `${base}-${agyEffort}`, effortArg: agyEffort }
  }
  // Clamp to what the chosen model actually supports (e.g. Codex has no xhigh/max)
  const known = modelsForCli(cli).find((m) => m.id === modelId)
  const supported: EffortLevel[] = known?.efforts?.length ? known.efforts : cli === 'claude' ? ['low', 'medium', 'high', 'xhigh', 'max'] : ['low', 'medium', 'high']
  return { cliModelArg: modelId, effortArg: clampEffort(cleanEffort, supported, known?.defaultEffort) }
}

const EFFORT_ORDER: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** Pick the supported effort closest to (and not above) the requested one. */
export function clampEffort(effort: EffortLevel, supported: EffortLevel[], fallback?: EffortLevel): EffortLevel {
  if (supported.includes(effort)) return effort
  const want = EFFORT_ORDER.indexOf(effort)
  const below = supported.filter((e) => EFFORT_ORDER.indexOf(e) <= want).sort((a, b) => EFFORT_ORDER.indexOf(b) - EFFORT_ORDER.indexOf(a))[0]
  return below ?? fallback ?? supported[0] ?? 'medium'
}

let lastModels: Partial<Record<CliId, CliModel[]>> = {}

/** Models known for a CLI (live list from the last status scan, else the built-in catalog). */
export function modelsForCli(cli: CliId): CliModel[] {
  return lastModels[cli]?.length ? lastModels[cli]! : cli === 'claude' ? loadClaudeCatalogModels() : CATALOG_MODELS[cli]
}

/** A CLI can take over work only if it is installed AND signed in. */
export function isCliReady(cli: CliId): boolean {
  const exe = findCliExecutable(cli)
  return Boolean(exe) && detectAuth(cli, exe).authenticated
}

let statusCache: { at: number; value: CliSubscriptionStatus[] } | null = null
let statusInFlight: Promise<CliSubscriptionStatus[]> | null = null

export const clis = {
  /** All 4 AI subscriptions with live authentication state, up-to-date models, and live 5-hour/7-day usage limits. */
  /** Cached for a few seconds: the renderer re-requests this on every DB change while a run streams. */
  statusAll: async (forceRefresh = false): Promise<CliSubscriptionStatus[]> => {
    if (!forceRefresh && statusCache && Date.now() - statusCache.at < 8000) return statusCache.value
    if (!forceRefresh && statusInFlight) return statusInFlight
    if (forceRefresh) {
      dynamicAgyModels = null
      cachedClaudeOAuthUsage = null
      cachedClaudeTranscripts = null
      cachedAgyTranscripts = null
      cachedAgyQuota = null
      cachedCodexLive = null
      exeCache.clear()
    }
    statusInFlight = clis.computeStatus(forceRefresh).finally(() => {
      statusInFlight = null
    })
    return statusInFlight
  },

  computeStatus: async (forceRefresh: boolean): Promise<CliSubscriptionStatus[]> => {
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
        id: 'claude',
        name: 'Claude Code',
        shortName: 'Claude',
        provider: 'Anthropic',
        accentColor: '#d97757',
        loginCommand: 'claude login',
        installCommand: 'npm install -g @anthropic-ai/claude-code'
      },
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

    // Each CLI is independent (Antigravity's /usage takes a few seconds) — gather them in parallel
    const out: CliSubscriptionStatus[] = []
    await Promise.all(meta.map(async (m, index) => {
      const exePath = findCliExecutable(m.id)
      const auth = detectAuth(m.id, exePath)
      const budget = windowBudgetFor(m.id, auth.detectedPlan)
      let models = [...CATALOG_MODELS[m.id]]

      if (m.id === 'agy' && exePath) {
        const dyn = await loadDynamicAgyModels(exePath)
        if (dyn.length > 0) models = dyn
      } else if (m.id === 'claude') {
        models = loadClaudeCatalogModels()
      }

      const limit = await computeLimitInfo(m.id, auth.authenticated, auth.detectedPlan, forceRefresh)

      out[index] = {
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
      }
      lastModels[m.id] = models
    }))
    statusCache = { at: Date.now(), value: out }
    return out
  },

  clearRateLimit: (cli: CliId): true => {
    run("DELETE FROM cli_rate_events WHERE cli = ? OR cli LIKE ?", cli, `${cli}:%`)
    statusCache = null
    return true
  },

  recentUsage: (): { id: number; cli: CliId; model: string; tokens: number; duration_ms: number; created_at: string }[] =>
    all('SELECT id, cli, model, tokens, duration_ms, created_at FROM usage_logs ORDER BY id DESC LIMIT 40')
}
