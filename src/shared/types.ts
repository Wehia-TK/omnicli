export type CliId = 'claude' | 'agy' | 'codex' | 'copilot'

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

/** An extra, isolated login for a CLI (its own config folder), used as a fallback before switching provider. */
export interface CliAccount {
  id: number
  cli: CliId
  label: string
  config_dir: string
  sort: number
  created_at: string
  authenticated: boolean
  accountLabel: string
  limited: boolean
  resetsAt: string | null
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
  /** When set, the schedule hands its prompt to this team's top role instead of running one AI directly */
  team_id?: number | null
}

// ───────────────────────────── Teams (agent hierarchies) ─────────────────────────────

/** manager = plans, delegates and reviews (never edits); worker = does one job; script = a fixed command, no tokens */
export type TeamRoleKind = 'manager' | 'worker' | 'script'

export interface Team {
  id: number
  name: string
  /** JSON array of `cli:model` keys managers may assign; `[]` = every signed-in model (Fable is never offered) */
  allowed_models: string
  /** Most roles the team may ever hold, the top role included */
  max_roles: number
  /** Most levels in the org chart, the top role included */
  max_depth: number
  /** Follow-up delegation rounds a manager may run after its first one */
  max_rounds: number
  /** Per-run budget in cost-weighted tokens (a token on the most expensive model counts as 1) */
  token_budget: number
  /** Word cap on the report each role sends up to its manager */
  report_words: number
  /** 1 = agents start without MCP servers, skills or sub-agent tools (smaller starting context) */
  lean: number
  /** 1 = a manager's new hires wait for the user's approval */
  approve_hires: number
  created_at: string
  roles?: TeamRole[]
}

export interface TeamRole {
  id: number
  team_id: number
  /** null = the top role */
  parent_id: number | null
  title: string
  /** Standing job description (for the top role: its mission) */
  job: string
  kind: TeamRoleKind
  /** Last model this role ran on (its manager picks one per assignment unless `locked`) */
  cli: CliId | ''
  model: string
  effort: EffortLevel
  /** Script roles only: the command the app runs */
  command: string
  /** 1 = managers may not change this role's model */
  locked: number
  hired_by: 'user' | 'manager'
  created_at: string
}

export type TeamRunState = 'running' | 'done' | 'failed' | 'stopped'

export interface TeamRun {
  id: number
  team_id: number
  project_id: number
  /** The role the task was given to (usually the top role) */
  role_id: number
  prompt: string
  state: TeamRunState
  permission_mode: PermissionMode
  checkout_mode: CheckoutMode
  /** A follow-up continues this earlier run's branch and top-role session */
  continues_run_id: number | null
  result: string
  error: string
  created_at: string
  done_at: string | null
  // Aggregates filled in by the API
  role_title?: string
  root_task_id?: number | null
  branch?: string | null
  steps_total?: number
  steps_done?: number
  tokens?: number
  /** Tokens weighted by each step's model cost */
  weighted?: number
  /** The same tokens weighted as if every step had run on the top role's model */
  weighted_top?: number
  cost_usd?: number
  top_model?: string
}

export type TeamStepState = 'pending' | 'planning' | 'approval' | 'waiting' | 'reviewing' | 'working' | 'done' | 'failed' | 'skipped'

/** One role working on one assignment inside a run. */
export interface TeamStep {
  id: number
  run_id: number
  role_id: number
  parent_step_id: number | null
  /** The hidden project_tasks row (kind = 'agent') holding this role's CLI session and log */
  task_id: number | null
  seq: number
  /** Which of the parent's delegation rounds this step belongs to */
  round: number
  brief: string
  access: 'read' | 'write'
  cli: CliId | ''
  model: string
  effort: EffortLevel
  state: TeamStepState
  /** Last turn launched: plan / review (managers) or work */
  phase: '' | 'plan' | 'review' | 'work'
  /** Delegation rounds this step has started */
  rounds: number
  report: string
  error: string
  notes: string
  tokens: number
  cost_usd: number
  run_ms: number
  /** Assignments waiting for the user's hire approval (JSON) */
  plan_json: string
  created_at: string
  role_title?: string
  role_kind?: TeamRoleKind
}

/** A model a manager can be allowed to assign, with its estimated relative cost. */
export interface TeamModelOption {
  key: string
  cli: CliId
  cliName: string
  model: string
  name: string
  /** Estimated cost per token relative to the most expensive tier (1 = Opus-class) */
  weight: number
  ready: boolean
}

/** A new hire or assignment proposed by a manager (shown when hires need approval). */
export interface TeamAssignment {
  roleId: number | null
  title: string
  kind: TeamRoleKind
  job: string
  cli: CliId | ''
  model: string
  effort: EffortLevel
  access: 'read' | 'write'
  brief: string
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
  native: CliId[]
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
  /** 'agent' = a team role's session (core/teams.ts); hidden from the session list and the task queue */
  kind: 'thread' | 'task' | 'agent'
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
  /** cli_accounts.id used by the last run (0 = the CLI's primary login) */
  account_id?: number
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

export interface QueuedMessage {
  id: number
  task_id: number
  prompt: string
  mentions: string
  cli?: CliId
  model?: string
  effort?: EffortLevel
  permission_mode?: PermissionMode
  created_at: string
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
  copilotPath: string
  claudeTier: 'pro' | 'max5x' | 'max20x'
  agyTier: 'standard' | 'pro'
  codexTier: 'plus' | 'pro'
  copilotTier: 'pro' | 'enterprise'
}

export interface TerminalOutputEvent {
  sessionId: string
  data: string
  stream: 'stdout' | 'stderr' | 'system'
  exitCode?: number | null
}

/** Result of checking whether the running Omni CLI is behind its source checkout. */
export interface UpdateInfo {
  /** false = can't self-update (installed build, no git checkout) — see `reason` */
  supported: boolean
  /** something changed that needs a restart (or a pull) to take effect */
  available: boolean
  checkedAt: number
  launchedAt: number
  branch: string
  /** short HEAD hash */
  commit: string
  /** commits made since Omni CLI was launched */
  localCommits: { hash: string; subject: string }[]
  /** files edited since launch that need a restart (main / preload / core / shared / package files) */
  changedFiles: string[]
  /** renderer files edited since launch — already live via hot reload */
  liveFiles: string[]
  /** upstream commits not yet pulled */
  remoteCommits: { hash: string; subject: string }[]
  /** upstream ref, e.g. origin/main ('' when none) */
  remote: string
  reason: string
}
