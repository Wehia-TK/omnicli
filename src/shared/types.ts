export type CliId = 'claude' | 'agy' | 'codex' | 'gemini' | 'copilot'

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type PermissionMode = 'default' | 'accept-edits' | 'bypass' | 'plan'

export type CheckoutMode = 'local' | 'worktree'

export type ProjectTaskStatus = 'queued' | 'doing' | 'done'

export type RunState = '' | 'running' | 'waiting' | 'failed'

export type KnowledgeCategory = 'architecture' | 'conventions' | 'feature' | 'decisions' | 'handoff'

export interface CliModel {
  id: string
  name: string
  tier: string
  cli: CliId
  description: string
  efforts: EffortLevel[]
  defaultEffort: EffortLevel
  effortModelMap?: Partial<Record<EffortLevel, string>>
}

export interface CliLimitInfo {
  windowHours: number
  usedTokens: number
  usedRequests: number
  usedMs: number
  maxRequestsWindow: number
  maxTokensWindow: number
  utilizationPct: number
  weeklyUtilizationPct?: number
  weeklyResetInLabel?: string
  status: 'ok' | 'warning' | 'rejected' | 'unauthenticated'
  resetsAt: string | null
  resetInLabel: string
  todayTokens: number
  todayRequests: number
  weekTokens: number
  liveNote?: string
}

export interface CliSubscriptionStatus {
  id: CliId
  name: string
  shortName: string
  provider: string
  planLabel: string
  accentColor: string
  installed: boolean
  authenticated: boolean
  exePath: string
  accountLabel: string
  statusReason: string
  loginCommand: string
  installCommand: string
  models: CliModel[]
  limit: CliLimitInfo
}

export interface Project {
  id: number
  name: string
  folder: string
  notes: string
  check_cmd: string
  auto_run: number
  default_cli: CliId | ''
  default_model: string
  default_effort?: EffortLevel
  default_mode: PermissionMode
  default_checkout: CheckoutMode
  sort: number
  archived_at: string | null
  created_at: string
  queued?: number
  doing?: number
  kb_count?: number
  thread_count?: number
}

export interface MentionItem {
  type: 'project' | 'file' | 'kb'
  label: string
  value: string
}

export interface ProjectTask {
  id: number
  project_id: number
  kind: 'thread' | 'task'
  title: string
  notes: string
  status: ProjectTaskStatus
  sort: number
  created_at: string
  started_at: string | null
  done_at: string | null
  run_state: RunState
  session_id: string | null
  agy_conversation: string | null
  branch: string | null
  worktree: string | null
  base_commit: string | null
  result: string
  error: string
  runs: number
  tokens: number
  cost_usd: number
  run_ms: number
  check_state: '' | 'passed' | 'failed'
  check_output: string
  cli: '' | CliId
  runner: '' | CliId
  model: string
  effort?: EffortLevel
  permission_mode: PermissionMode
  checkout_mode: CheckoutMode
  mentions: string // JSON string of MentionItem[]
}

export interface LogLine {
  at: string
  kind: 'you' | 'text' | 'thinking' | 'tool' | 'info' | 'error' | 'handoff'
  text: string
  cli?: CliId
  model?: string
  meta?: string
}

export interface TaskChanges {
  branch: string
  cwd: string
  commits: { hash: string; subject: string }[]
  files: { path: string; status: string; added: number; removed: number }[]
  uncommitted: boolean
}

export interface KnowledgeEntry {
  id: number
  project_id: number
  category: KnowledgeCategory
  title: string
  content: string
  files: string
  updated_by: string
  pinned: number
  created_at: string
  updated_at: string
}

export interface Settings {
  theme: 'dark' | 'light' | 'system'
  defaultCli: CliId
  defaultModel: string
  defaultPermissionMode: PermissionMode
  defaultCheckoutMode: CheckoutMode
  cliHandover: boolean
  autoUpdateKb: boolean
  syncKbToDisk: boolean
  claudePath: string
  agyPath: string
  codexPath: string
  geminiPath: string
  copilotPath: string
  claudeTier: 'pro' | 'max5x' | 'max20x'
  agyTier: 'standard' | 'pro'
  codexTier: 'plus' | 'pro'
  geminiTier: 'standard' | 'advanced'
  copilotTier: 'pro' | 'enterprise'
}

export interface TerminalOutputEvent {
  sessionId: string
  data: string
  stream: 'stdout' | 'stderr' | 'system'
  exitCode?: number | null
}
