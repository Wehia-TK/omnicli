import { useEffect, useRef, useState } from 'react'
import type {
  ApprovalRequest,
  DiffHunk,
  McpServerEntry,
  PrInfo,
  Schedule,
  SearchHit,
  CheckoutMode,
  CliId,
  CliSubscriptionStatus,
  EffortLevel,
  GitStatusInfo,
  KnowledgeCategory,
  KnowledgeEntry,
  LogLine,
  MentionItem,
  PermissionMode,
  Project,
  ProjectTask,
  ProjectTaskStatus,
  QueuedMessage,
  Settings,
  SkillInfo,
  TaskChanges,
  TerminalOutputEvent,
  UpdateInfo
} from '@shared/types'

declare global {
  interface Window {
    aihub?: {
      platform?: string
      call: (path: string, ...args: unknown[]) => Promise<unknown>
      onChanged: (cb: () => void) => () => void
      onNavigate: (cb: (route: string) => void) => () => void
      onTerminalOutput: (cb: (ev: TerminalOutputEvent) => void) => () => void
      onWindowMaximizedChange?: (cb: (maximized: boolean) => void) => () => void
      pathForFile: (file: File) => string
    }
  }
}

export const isDesktop = typeof window !== 'undefined' && Boolean(window.aihub)

const call = <T>(path: string, ...args: unknown[]): Promise<T> => {
  if (!window.aihub) return Promise.reject(new Error('Desktop IPC bridge is not available'))
  return window.aihub.call(path, ...args) as Promise<T>
}

export const api = {
  window: {
    minimize: () => call<true>('window.minimize'),
    maximize: () => call<boolean>('window.maximize'),
    close: () => call<true>('window.close'),
    isMaximized: () => call<boolean>('window.isMaximized')
  },
  app: {
    chooseFolder: () => call<string | null>('app.chooseFolder'),
    openPath: (target: string) => call<true>('app.openPath', target),
    setTheme: (theme: 'dark' | 'light') => call<true>('app.setTheme', theme),
    pickerPreload: () => call<string>('app.pickerPreload')
  },
  updates: {
    check: (fetchRemote = true) => call<UpdateInfo>('updates.check', fetchRemote),
    apply: () => call<{ restarting: true; steps: string[] }>('updates.apply')
  },
  approvals: {
    list: (taskId?: number) => call<ApprovalRequest[]>('approvals.list', taskId),
    decide: (id: string, decision: 'allow' | 'always' | 'deny', message?: string) => call<true>('approvals.decide', id, decision, message)
  },
  rules: {
    get: (projectId: number) =>
      call<{ text: string; files: { name: string; exists: boolean; managed: boolean; otherContent: boolean }[] }>('rules.get', projectId),
    save: (projectId: number, text: string, targets?: string[]) => call<true>('rules.save', projectId, text, targets)
  },
  attachments: {
    saveImage: (dataUrl: string, name?: string) => call<string>('attachments.saveImage', dataUrl, name),
    readImage: (path: string) => call<string>('attachments.readImage', path)
  },
  history: {
    search: (query: string, projectId?: number) => call<SearchHit[]>('history.search', query, projectId),
    importExisting: (projectId: number) => call<{ claude: number; agy: number }>('history.importExisting', projectId)
  },
  github: {
    createPr: (taskId: number, title?: string, body?: string) => call<PrInfo>('github.createPr', taskId, title, body),
    status: (taskId: number) => call<PrInfo>('github.status', taskId)
  },
  review: {
    hunks: (taskId: number, file: string) => call<DiffHunk[]>('review.hunks', taskId, file),
    revertHunk: (taskId: number, file: string, index: number) => call<DiffHunk[]>('review.revertHunk', taskId, file, index)
  },
  schedules: {
    list: (projectId: number) => call<Schedule[]>('schedules.list', projectId),
    save: (s: Partial<Schedule> & { project_id: number; title: string; prompt: string }) => call<Schedule>('schedules.save', s),
    toggle: (id: number) => call<Schedule>('schedules.toggle', id),
    delete: (id: number) => call<true>('schedules.delete', id),
    runNow: (id: number) => call<true>('schedules.runNow', id),
    testPhone: () => call<true>('schedules.testPhone')
  },
  mcp: {
    list: () => call<McpServerEntry[]>('mcp.list'),
    add: (def: Omit<McpServerEntry, 'installedIn'>, targets: CliId[]) => call<McpServerEntry[]>('mcp.add', def, targets),
    remove: (name: string, targets: CliId[]) => call<McpServerEntry[]>('mcp.remove', name, targets)
  },
  settings: {
    get: () => call<Settings>('settings.get'),
    update: (patch: Partial<Settings>) => call<Settings>('settings.update', patch)
  },
  clis: {
    statusAll: (forceRefresh = false) => call<CliSubscriptionStatus[]>('clis.statusAll', forceRefresh),
    clearRateLimit: (cli: CliId) => call<true>('clis.clearRateLimit', cli),
    recentUsage: () =>
      call<{ id: number; cli: CliId; model: string; tokens: number; duration_ms: number; created_at: string }[]>('clis.recentUsage')
  },
  knowledge: {
    list: (projectId: number) => call<KnowledgeEntry[]>('knowledge.list', projectId),
    save: (entry: Partial<KnowledgeEntry> & { project_id: number; title: string; content: string; category?: KnowledgeCategory }) =>
      call<KnowledgeEntry>('knowledge.save', entry),
    togglePin: (id: number) => call<KnowledgeEntry>('knowledge.togglePin', id),
    delete: (id: number) => call<true>('knowledge.delete', id),
    scanRepo: (projectId: number) => call<KnowledgeEntry[]>('knowledge.scanRepo', projectId)
  },
  skills: {
    list: (projectId?: number) => call<SkillInfo[]>('skills.list', projectId),
    targets: () => call<{ cli: CliId; dir: string }[]>('skills.targets'),
    install: (url: string, targets: CliId[]) => call<{ installed: string[]; into: CliId[] }>('skills.install', url, targets),
    remove: (path: string) => call<true>('skills.remove', path),
    read: (path: string) => call<string>('skills.read', path)
  },
  git: {
    status: (projectId: number) => call<GitStatusInfo>('git.status', projectId),
    init: (projectId: number) => call<GitStatusInfo>('git.init', projectId),
    setRemote: (projectId: number, url: string) => call<GitStatusInfo>('git.setRemote', projectId, url),
    push: (projectId: number, url?: string, message?: string) =>
      call<GitStatusInfo & { pushed: string }>('git.push', projectId, url, message)
  },
  projects: {
    list: () => call<Project[]>('projects.list'),
    save: (p: Partial<Project> & { name: string }) => call<Project>('projects.save', p),
    archive: (id: number, archived?: boolean) => call<Project>('projects.archive', id, archived),
    setDefaults: (id: number, d: { cli?: CliId; model?: string; effort?: EffortLevel }) =>
      call<Project>('projects.setDefaults', id, d),
    delete: (id: number) => call<true>('projects.delete', id),
    files: (projectId: number) => call<string[]>('projects.files', projectId),
    estimate: (opts: { projectId: number; taskId?: number | null; cli: CliId; prompt: string; mentions?: MentionItem[] }) =>
      call<{ tokens: number; contextTokens: number; continuing: boolean }>('projects.estimate', opts),
    createCompare: (
      opts: {
        projectId: number
        prompt: string
        kind?: 'thread' | 'task'
        cli: CliId
        model: string
        effort?: EffortLevel
        permissionMode: PermissionMode
        checkoutMode: CheckoutMode
        mentions?: MentionItem[]
      },
      second: { cli: CliId; model: string; effort?: EffortLevel }
    ) => call<ProjectTask[]>('projects.createCompare', opts, second),
    tasks: (projectId: number) => call<ProjectTask[]>('projects.tasks', projectId),
    createAndRun: (opts: {
      projectId: number
      prompt: string
      notes?: string
      kind?: 'thread' | 'task'
      cli: CliId
      model: string
      effort?: EffortLevel
      permissionMode: PermissionMode
      checkoutMode: CheckoutMode
      mentions?: MentionItem[]
      startImmediately?: boolean
    }) => call<ProjectTask>('projects.createAndRun', opts),
    saveTask: (
      t: Pick<ProjectTask, 'id' | 'title' | 'notes'> &
        Partial<Pick<ProjectTask, 'cli' | 'model' | 'effort' | 'permission_mode' | 'checkout_mode'>>
    ) => call<ProjectTask>('projects.saveTask', t),
    setStatus: (id: number, status: ProjectTaskStatus) => call<ProjectTask>('projects.setStatus', id, status),
    reorder: (projectId: number, ids: number[]) => call<true>('projects.reorder', projectId, ids),
    deleteTask: (id: number) => call<true>('projects.deleteTask', id),
    runQueue: (projectId: number, on: boolean) => call<Project>('projects.runQueue', projectId, on),
    start: (id: number, initialAsk?: string) => call<ProjectTask>('projects.start', id, initialAsk),
    reply: (
      id: number,
      text: string,
      opts?: { cli?: CliId; model?: string; effort?: EffortLevel; permissionMode?: PermissionMode; mentions?: MentionItem[] }
    ) => call<ProjectTask>('projects.reply', id, text, opts),
    queueMessage: (
      taskId: number,
      prompt: string,
      opts?: { mentions?: MentionItem[]; cli?: CliId; model?: string; effort?: EffortLevel; permissionMode?: PermissionMode }
    ) => call<QueuedMessage>('projects.queueMessage', taskId, prompt, opts),
    listQueuedMessages: (taskId: number) => call<QueuedMessage[]>('projects.listQueuedMessages', taskId),
    removeQueuedMessage: (id: number) => call<true>('projects.removeQueuedMessage', id),
    sendNow: (
      taskId: number,
      promptOrQueuedId?: string | number,
      opts?: { mentions?: MentionItem[]; cli?: CliId; model?: string; effort?: EffortLevel; permissionMode?: PermissionMode }
    ) => call<ProjectTask>('projects.sendNow', taskId, promptOrQueuedId, opts),
    stop: (id: number) => call<ProjectTask>('projects.stop', id),
    check: (id: number) => call<ProjectTask>('projects.check', id),
    log: (id: number) => call<LogLine[]>('projects.log', id),
    changes: (id: number) => call<TaskChanges | null>('projects.changes', id),
    diff: (id: number, file: string) => call<string>('projects.diff', id, file),
    openTerminal: (id: number) => call<true>('projects.openTerminal', id),
    merge: (id: number) => call<ProjectTask>('projects.merge', id),
    discard: (id: number) => call<ProjectTask>('projects.discard', id)
  },
  voice: {
    engine: () => call<'parakeet' | 'system' | 'none'>('voice.engine'),
    warmup: () => call<true>('voice.warmup'),
    transcribe: (pcm: Float32Array) => call<string>('voice.transcribe', pcm),
    listen: () => call<string>('voice.listen'),
    stop: () => call<true>('voice.stop')
  },
  terminal: {
    start: (sessionId: string, cwd: string, initialCommand?: string, cols?: number, rows?: number) =>
      call<{ sessionId: string; cwd: string; pty: boolean }>('terminal.start', sessionId, cwd, initialCommand, cols, rows),
    write: (sessionId: string, data: string) => call<true>('terminal.write', sessionId, data),
    resize: (sessionId: string, cols: number, rows: number) => call<true>('terminal.resize', sessionId, cols, rows),
    send: (sessionId: string, input: string, cwd?: string) => call<true>('terminal.send', sessionId, input, cwd),
    stop: (sessionId: string) => call<true>('terminal.stop', sessionId),
    openExternalCli: (cli: CliId, cwd: string, extraArgs?: string) =>
      call<true>('terminal.openExternalCli', cli, cwd, extraArgs)
  }
}

type ToastItem = { id: number; text: string; isError?: boolean }
let toastListeners: ((t: ToastItem[]) => void)[] = []
let toasts: ToastItem[] = []
let nextToastId = 1

export function toast(text: string, isError = false): void {
  const id = nextToastId++
  toasts = [...toasts, { id, text, isError }]
  toastListeners.forEach((cb) => cb(toasts))
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id)
    toastListeners.forEach((cb) => cb(toasts))
  }, 3500)
}

export function useToasts(): ToastItem[] {
  const [list, setList] = useState<ToastItem[]>(toasts)
  useEffect(() => {
    toastListeners.push(setList)
    return () => {
      toastListeners = toastListeners.filter((x) => x !== setList)
    }
  }, [])
  return list
}

/** `force` = an explicit refresh after a user action (skips throttling); otherwise a DB-change broadcast. */
const reloadListeners = new Set<(force: boolean) => void>()
if (typeof window !== 'undefined' && window.aihub) {
  window.aihub.onChanged(() => {
    for (const fn of reloadListeners) fn(false)
  })
}

export function triggerReload(): void {
  for (const fn of reloadListeners) fn(true)
}

/**
 * Fetch data and refetch whenever the backend reports a change.
 * - Never more than one request in flight per hook (a refetch requested meanwhile runs once afterwards),
 *   so a streaming run can't pile up IPC calls on the main process.
 * - `throttleMs` caps how often DB-change broadcasts refetch expensive data (git, file scans, network).
 */
export function useData<T>(
  fetcher: () => Promise<T>,
  deps: unknown[] = [],
  opts: { throttleMs?: number } = {}
): { data: T | undefined; reload: () => void } {
  const [data, setData] = useState<T | undefined>(undefined)
  const [tick, setTick] = useState(0)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const throttleRef = useRef(opts.throttleMs ?? 0)
  throttleRef.current = opts.throttleMs ?? 0
  const state = useRef({ seq: 0, inFlight: false, queued: false, lastAt: 0, timer: null as ReturnType<typeof setTimeout> | null })

  useEffect(() => {
    let alive = true
    const s = state.current
    const mySeq = ++s.seq
    s.inFlight = true
    fetcherRef
      .current()
      .then((res) => {
        if (alive) setData(res)
      })
      .catch((err) => console.error(err))
      .finally(() => {
        if (mySeq !== s.seq) return
        s.inFlight = false
        s.lastAt = Date.now()
        if (s.queued && alive) {
          s.queued = false
          setTick((n) => n + 1)
        }
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])

  useEffect(() => {
    const s = state.current
    const fn = (force: boolean): void => {
      if (s.inFlight) {
        s.queued = true
        return
      }
      const wait = force ? 0 : throttleRef.current - (Date.now() - s.lastAt)
      if (wait <= 0) {
        if (s.timer) clearTimeout(s.timer)
        s.timer = null
        setTick((n) => n + 1)
      } else if (!s.timer) {
        s.timer = setTimeout(() => {
          s.timer = null
          if (s.inFlight) s.queued = true
          else setTick((n) => n + 1)
        }, wait)
      }
    }
    reloadListeners.add(fn)
    return () => {
      reloadListeners.delete(fn)
      if (s.timer) clearTimeout(s.timer)
      s.timer = null
    }
  }, [])

  return { data, reload: () => setTick((n) => n + 1) }
}
export async function act<T>(promise: Promise<T>, okToast?: string): Promise<T | undefined> {
  try {
    const res = await promise
    triggerReload()
    if (okToast) toast(okToast)
    return res
  } catch (e) {
    toast((e as Error).message || 'Action failed', true)
    return undefined
  }
}
