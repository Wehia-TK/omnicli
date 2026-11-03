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

/** Per-model (or per-model-family) quota bucket — Antigravity and Claude meter some models separately. */
export interface ModelLimitBucket {
  key: string
  label: string
  /** Base model ids that draw from this bucket */
  modelIds: string[]
  utilizationPct: number
  usedTokens: number
  usedRequests: number
  status: 'ok' | 'warning' | 'rejected'
  resetInLabel: string
  window: '5h' | '7d'
  source: 'live' | 'estimated'
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
  /** 'live' = read from the provider (OAuth usage API / CLI session files); 'estimated' = budget heuristics */
  source?: 'live' | 'estimated'
  modelBuckets?: ModelLimitBucket[]
}

export interface Schedule {
  id: number
  project_id: number
  title: string
  prompt: string
  cli: CliId
  model: string
  effort: EffortLevel
  permission_mode: PermissionMode
  kind: 'daily' | 'weekly' | 'hourly'
  time_of_day: string
  every_hours: number
  weekday: number
  enabled: number
  last_run_at: number | null
  next_run_at: number | null
  created_at: string
}

export interface McpServerEntry {
  name: string
  type: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  /** Which CLIs currently have this server configured */
  installedIn: CliId[]
}

export interface SearchHit {
  taskId: number
  projectId: number
  projectName: string
  title: string
  snippet: string
  at: string
}

export interface PrInfo {
  url: string
  number: number
  state: string
  title: string
  checks: { name: string; state: string }[]
}

export interface DiffHunk {
  index: number
  header: string
  oldStart: number
  newStart: number
  lines: { kind: ' ' | '+' | '-'; text: string; oldNo: number | null; newNo: number | null }[]
}

export interface ApprovalRequest {
  id: string
  taskId: number
  toolName: string
  input: Record<string, unknown>
  summary: string
  createdAt: string
}

export interface SkillInfo {
  name: string
  description: string
  /** Absolute path to SKILL.md */
  path: string
  /** Which CLI natively loads this skill (can be invoked as /name) */
  native: ('claude' | 'agy' | 'codex' | 'gemini' | 'copilot')[]
  scope: 'user' | 'project'
}

export interface GitStatusInfo {
  isRepo: boolean
  branch: string
  hasCommits: boolean
  dirtyFiles: number
  remoteUrl: string
  savedRemoteUrl: string
  ahead: number
  behind: number
  upstream: string
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
  git_remote_url?: string
  sort: number
  archived_at: string | null
  created_at: string
  queued?: number
  doing?: number
  kb_count?: number
  thread_count?: number
}

export interface MentionItem {
  type: 'project' | 'file' | 'kb' | 'skill' | 'image' | 'element'
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
  codex_thread?: string | null
  compare_group?: string | null
  pr_url?: string | null
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
  defaultEffort: EffortLevel
  /** 'compact' sends a short KB index + file pointers; 'full' inlines pinned entries (more tokens) */
  kbPromptMode: 'compact' | 'full'
  /** Build/refresh a graphify code graph during KB scans (no LLM tokens used) */
  useGraphify: boolean
  /** Rebuild the graphify graph automatically when project files change */
  graphifyWatch: boolean
  /** ntfy.sh topic for phone notifications (empty = off) */
  ntfyTopic: string
  /** When an Antigravity model group runs out, switch to a model from another group first */
  agyFamilyFallback: boolean
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
