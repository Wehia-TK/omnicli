import { useEffect, useState } from 'react'
import type {
  CheckoutMode,
  CliId,
  CliSubscriptionStatus,
  KnowledgeCategory,
  KnowledgeEntry,
  LogLine,
  MentionItem,
  PermissionMode,
  Project,
  ProjectTask,
  ProjectTaskStatus,
  Settings,
  TaskChanges,
  TerminalOutputEvent
} from '@shared/types'

declare global {
  interface Window {
    aihub?: {
      call: (path: string, ...args: unknown[]) => Promise<unknown>
      onChanged: (cb: () => void) => () => void
      onNavigate: (cb: (route: string) => void) => () => void
      onTerminalOutput: (cb: (ev: TerminalOutputEvent) => void) => () => void
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
  app: {
    chooseFolder: () => call<string | null>('app.chooseFolder'),
    openPath: (target: string) => call<true>('app.openPath', target)
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
  projects: {
    list: () => call<Project[]>('projects.list'),
    save: (p: Partial<Project> & { name: string }) => call<Project>('projects.save', p),
    archive: (id: number, archived?: boolean) => call<Project>('projects.archive', id, archived),
    delete: (id: number) => call<true>('projects.delete', id),
    files: (projectId: number) => call<string[]>('projects.files', projectId),
    tasks: (projectId: number) => call<ProjectTask[]>('projects.tasks', projectId),
    createAndRun: (opts: {
      projectId: number
      prompt: string
      notes?: string
      kind?: 'thread' | 'task'
      cli: CliId
      model: string
      permissionMode: PermissionMode
      checkoutMode: CheckoutMode
      mentions?: MentionItem[]
      startImmediately?: boolean
    }) => call<ProjectTask>('projects.createAndRun', opts),
    saveTask: (
      t: Pick<ProjectTask, 'id' | 'title' | 'notes'> &
        Partial<Pick<ProjectTask, 'cli' | 'model' | 'permission_mode' | 'checkout_mode'>>
    ) => call<ProjectTask>('projects.saveTask', t),
    setStatus: (id: number, status: ProjectTaskStatus) => call<ProjectTask>('projects.setStatus', id, status),
    reorder: (projectId: number, ids: number[]) => call<true>('projects.reorder', projectId, ids),
    deleteTask: (id: number) => call<true>('projects.deleteTask', id),
    runQueue: (projectId: number, on: boolean) => call<Project>('projects.runQueue', projectId, on),
    start: (id: number, initialAsk?: string) => call<ProjectTask>('projects.start', id, initialAsk),
    reply: (
      id: number,
      text: string,
      opts?: { cli?: CliId; model?: string; permissionMode?: PermissionMode; mentions?: MentionItem[] }
    ) => call<ProjectTask>('projects.reply', id, text, opts),
    stop: (id: number) => call<ProjectTask>('projects.stop', id),
    check: (id: number) => call<ProjectTask>('projects.check', id),
    log: (id: number) => call<LogLine[]>('projects.log', id),
    changes: (id: number) => call<TaskChanges | null>('projects.changes', id),
    diff: (id: number, file: string) => call<string>('projects.diff', id, file),
    openTerminal: (id: number) => call<true>('projects.openTerminal', id),
    merge: (id: number) => call<ProjectTask>('projects.merge', id),
    discard: (id: number) => call<ProjectTask>('projects.discard', id)
  },
  terminal: {
    start: (sessionId: string, cwd: string, initialCommand?: string) =>
      call<{ sessionId: string; cwd: string }>('terminal.start', sessionId, cwd, initialCommand),
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

const reloadListeners = new Set<() => void>()
if (typeof window !== 'undefined' && window.aihub) {
  window.aihub.onChanged(() => {
    for (const fn of reloadListeners) fn()
  })
}

export function triggerReload(): void {
  for (const fn of reloadListeners) fn()
}

export function useData<T>(fetcher: () => Promise<T>, deps: unknown[] = []): { data: T | undefined; reload: () => void } {
  const [data, setData] = useState<T | undefined>(undefined)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let alive = true
    fetcher()
      .then((res) => {
        if (alive) setData(res)
      })
      .catch((err) => console.error(err))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])

  useEffect(() => {
    const fn = (): void => setTick((n) => n + 1)
    reloadListeners.add(fn)
    return () => {
      reloadListeners.delete(fn)
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
