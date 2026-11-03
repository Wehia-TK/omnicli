import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Archive,
  BookOpen,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  FileCode2,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitMerge,
  Layers,
  ListChecks,
  ListStart,
  Loader2,
  MessageSquare,
  MessageSquarePlus,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Settings as SettingsIcon,
  ShieldCheck,
  ShieldX,
  Sparkles,
  SquareTerminal,
  Terminal,
  Trash2
} from 'lucide-react'
import type {
  CheckoutMode,
  CliId,
  CliSubscriptionStatus,
  MentionItem,
  PermissionMode,
  Project,
  ProjectTask,
  Settings
} from '@shared/types'
import { CliAvatar, CliSpinner } from './components/CliAvatars'
import { EmbeddedTerminal } from './components/EmbeddedTerminal'
import { KnowledgeBaseView } from './components/KnowledgeBaseView'
import { LiveLimitsModal, SubscriptionStatusStrip } from './components/LiveLimitsModal'
import { SubscriptionComposer } from './components/SubscriptionComposer'
import { confirmAction, cx, Field, Modal } from './components/ui'
import { act, api, toast, useData, useToasts } from './lib/api'
import { relative } from './lib/dates'
import { Markdown } from './lib/markdown'

const fmtTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
const fmtDuration = (ms: number): string =>
  ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)}m`

export default function App(): React.JSX.Element {
  const { data: projectsList } = useData(() => api.projects.list())
  const { data: clis, reload: reloadClis } = useData(() => api.clis.statusAll())
  const { data: settings } = useData(() => api.settings.get())
  const toasts = useToasts()

  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null)
  const [activeTab, setActiveTab] = useState<'session' | 'queue' | 'kb'>('session')
  const [activeTaskId, setActiveTaskId] = useState<number | null>(null)

  // Composer state
  const [selectedCli, setSelectedCli] = useState<CliId>('agy')
  const [selectedModel, setSelectedModel] = useState<string>('gemini-4-argon-high')
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default')
  const [checkoutMode, setCheckoutMode] = useState<CheckoutMode>('local')
  const [submitMode, setSubmitMode] = useState<'thread' | 'task'>('thread')

  // Drawers & Modals
  const [showTerminal, setShowTerminal] = useState(false)
  const [terminalCmd, setTerminalCmd] = useState<string | undefined>(undefined)
  const [editingProject, setEditingProject] = useState<Partial<Project> | null>(null)
  const [showLimitsModal, setShowLimitsModal] = useState(false)
  const [showSettingsModal, setShowSettingsModal] = useState(false)

  const openProjects = (projectsList ?? []).filter((p) => !p.archived_at)
  const archivedProjects = (projectsList ?? []).filter((p) => p.archived_at)
  const currentProject = (projectsList ?? []).find((p) => p.id === selectedProjectId) ?? openProjects[0]

  useEffect(() => {
    if (currentProject && currentProject.id !== selectedProjectId) {
      setSelectedProjectId(currentProject.id)
      if (currentProject.default_cli) setSelectedCli(currentProject.default_cli)
      if (currentProject.default_model) setSelectedModel(currentProject.default_model)
      if (currentProject.default_mode) setPermissionMode(currentProject.default_mode)
      if (currentProject.default_checkout) setCheckoutMode(currentProject.default_checkout)
    }
  }, [currentProject, selectedProjectId])

  // Ensure selectedCli is an authenticated one if the current choice is unauthenticated
  useEffect(() => {
    if (!clis?.length) return
    const cur = clis.find((c) => c.id === selectedCli)
    if (cur && !cur.authenticated) {
      const firstAuth = clis.find((c) => c.authenticated)
      if (firstAuth) {
        setSelectedCli(firstAuth.id)
        if (firstAuth.models[0]) setSelectedModel(firstAuth.models[0].id)
      }
    }
  }, [clis, selectedCli])

  const { data: tasks } = useData(
    () => (currentProject ? api.projects.tasks(currentProject.id) : Promise.resolve([])),
    [currentProject?.id]
  )
  const { data: kbEntries } = useData(
    () => (currentProject ? api.knowledge.list(currentProject.id) : Promise.resolve([])),
    [currentProject?.id]
  )
  const { data: projectFiles } = useData(
    () => (currentProject ? api.projects.files(currentProject.id) : Promise.resolve([])),
    [currentProject?.id]
  )

  const activeTask = (tasks ?? []).find((t) => t.id === activeTaskId) ?? null
  const threads = (tasks ?? []).filter((t) => t.kind === 'thread')
  const queueItems = (tasks ?? []).filter((t) => t.kind === 'task')

  const handleSelectProject = (id: number): void => {
    setSelectedProjectId(id)
    setActiveTaskId(null)
    const p = (projectsList ?? []).find((x) => x.id === id)
    if (p) {
      if (p.default_cli) setSelectedCli(p.default_cli)
      if (p.default_model) setSelectedModel(p.default_model)
      if (p.default_mode) setPermissionMode(p.default_mode)
      if (p.default_checkout) setCheckoutMode(p.default_checkout)
    }
  }

  const handleAuthenticateCli = (sub: CliSubscriptionStatus): void => {
    setTerminalCmd(sub.loginCommand)
    setShowTerminal(true)
    toast(`Running '${sub.loginCommand}' in the embedded terminal`)
  }

  const handleComposerSubmit = async (
    prompt: string,
    mentions: MentionItem[],
    mode: 'thread' | 'task'
  ): Promise<void> => {
    if (!currentProject) {
      setEditingProject({ name: '', folder: '', notes: '' })
      return
    }
    if (activeTask && activeTab === 'session' && mode === 'thread') {
      await act(
        api.projects.reply(activeTask.id, prompt, {
          cli: selectedCli,
          model: selectedModel,
          permissionMode,
          mentions
        })
      )
      return
    }

    const created = await act(
      api.projects.createAndRun({
        projectId: currentProject.id,
        prompt,
        kind: mode,
        cli: selectedCli,
        model: selectedModel,
        permissionMode,
        checkoutMode: mode === 'task' ? 'worktree' : checkoutMode,
        mentions,
        startImmediately: mode === 'thread'
      }),
      mode === 'task' ? 'Added to Project Task Queue' : undefined
    )
    if (created) {
      if (mode === 'thread') {
        setActiveTab('session')
        setActiveTaskId(created.id)
      } else {
        setActiveTab('queue')
      }
    }
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#0b0c10] text-zinc-100">
      {/* Custom Top Title Bar */}
      <header
        className="flex h-10 shrink-0 items-center justify-between border-b border-white/[0.07] bg-[#0e1016]/90 pr-[145px] pl-3.5 backdrop-blur-xl select-none"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex items-center gap-2.5">
          <div className="flex size-5 items-center justify-center rounded-md bg-gradient-to-br from-indigo-500 to-sky-400 text-white shadow-sm">
            <Layers size={12} />
          </div>
          <span className="text-[13px] font-semibold tracking-tight text-zinc-100">AI Hub</span>
          <span className="rounded border border-white/[0.08] bg-white/[0.04] px-1.5 py-0.2 text-[10px] font-medium text-zinc-400">
            Subscriptions Workspace
          </span>
        </div>

        {/* Live Subscription Status Strip in TitleBar */}
        <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <SubscriptionStatusStrip
            clis={clis ?? []}
            selectedCli={selectedCli}
            onSelectCli={(sub) => {
              setSelectedCli(sub.id)
              if (sub.models[0]) setSelectedModel(sub.models[0].id)
            }}
            onOpenLimitsModal={() => setShowLimitsModal(true)}
          />

          <div className="h-4 w-px bg-white/[0.08]" />

          <button
            type="button"
            onClick={() => setShowTerminal(!showTerminal)}
            className={cx(
              'btn h-7 px-2.5 text-[11.5px]',
              showTerminal && 'border-emerald-400/40 bg-emerald-500/15 text-emerald-200'
            )}
            title="Toggle Embedded CLI Terminal"
          >
            <Terminal size={12} /> Terminal
          </button>

          <button
            type="button"
            onClick={() => setShowSettingsModal(true)}
            className="btn btn-ghost btn-icon h-7 w-7"
            title="Settings & CLI Paths"
          >
            <SettingsIcon size={13} />
          </button>
        </div>
      </header>

      {/* Main Layout: Left Sidebar + Center Workspace */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Left Sidebar: Projects & Recent Threads */}
        <aside className="flex w-64 shrink-0 flex-col border-r border-white/[0.07] bg-[#0e1015]/75">
          {/* New Interactive Session Button */}
          <div className="p-3">
            <button
              type="button"
              onClick={() => {
                setActiveTab('session')
                setActiveTaskId(null)
              }}
              className="btn w-full justify-start gap-2 border-white/[0.1] bg-white/[0.06] py-2 text-[13px] font-medium text-white hover:bg-white/[0.1]"
            >
              <MessageSquarePlus size={15} className="text-[#e89a6c]" />
              <span>New AI Session</span>
            </button>
          </div>

          {/* Projects Section */}
          <div className="px-3 pt-1 pb-2">
            <div className="mb-1.5 flex items-center justify-between px-1.5">
              <span className="text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">Projects</span>
              <button
                type="button"
                onClick={() => setEditingProject({ name: '', folder: '', notes: '', check_cmd: '' })}
                className="cursor-pointer rounded p-0.5 text-zinc-400 hover:bg-white/[0.08] hover:text-white"
                title="New Project"
              >
                <Plus size={13} />
              </button>
            </div>

            <div className="space-y-0.5">
              {[...openProjects, ...archivedProjects].map((p) => {
                const isSelected = p.id === currentProject?.id
                return (
                  <div
                    key={p.id}
                    className={cx(
                      'group flex items-center gap-1 rounded-lg px-2 py-1.5 transition-colors',
                      isSelected ? 'bg-white/[0.09] font-medium text-white' : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200',
                      p.archived_at && 'opacity-45'
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => handleSelectProject(p.id)}
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left text-[13px]"
                    >
                      <FolderGit2 size={14} className={cx('shrink-0', isSelected ? 'text-indigo-400' : 'text-zinc-500')} />
                      <span className="truncate">{p.name}</span>
                    </button>

                    {!!p.doing && <span className="size-2 animate-pulse rounded-full bg-emerald-400" title="CLI working" />}
                    {!!p.queued && (
                      <span className="rounded bg-white/[0.07] px-1.5 py-0.2 text-[10.5px] text-zinc-400" title="Queued tasks">
                        {p.queued}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => setEditingProject(p)}
                      className="invisible cursor-pointer rounded p-0.5 text-zinc-400 group-hover:visible hover:text-white"
                      title="Edit project"
                    >
                      <Pencil size={11} />
                    </button>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="mx-3 my-1 border-t border-white/[0.06]" />

          {/* Recent Interactive Sessions for Current Project */}
          <div className="flex min-h-0 flex-1 flex-col px-3 py-2">
            <div className="mb-1.5 flex items-center justify-between px-1.5">
              <span className="text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">
                {currentProject ? `${currentProject.name} Sessions` : 'Sessions'}
              </span>
              <span className="text-[11px] text-zinc-500">{threads.length}</span>
            </div>

            <div className="flex-1 space-y-0.5 overflow-y-auto pr-0.5">
              {threads.length === 0 ? (
                <p className="px-2 py-4 text-[12px] text-zinc-500">
                  No sessions yet. Start one with the composer to stream live from Claude, Antigravity, or Gemini.
                </p>
              ) : (
                threads.map((t) => {
                  const active = activeTab === 'session' && activeTaskId === t.id
                  const cliUsed = (t.runner || t.cli || 'agy') as CliId
                  return (
                    <div
                      key={t.id}
                      className={cx(
                        'group flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12.5px] transition-colors',
                        active ? 'bg-indigo-500/18 font-medium text-white' : 'text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200'
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setActiveTab('session')
                          setActiveTaskId(t.id)
                        }}
                        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                      >
                        <CliAvatar cli={cliUsed} size={14} />
                        <span className="truncate">{t.title}</span>
                      </button>

                      {t.run_state === 'running' && <Loader2 size={12} className="shrink-0 animate-spin text-indigo-400" />}
                      <button
                        type="button"
                        onClick={() => act(api.projects.deleteTask(t.id), 'Session removed').then(() => activeTaskId === t.id && setActiveTaskId(null))}
                        className="invisible cursor-pointer rounded p-0.5 text-zinc-500 group-hover:visible hover:text-red-400"
                        title="Delete session"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  )
                })
              )}
            </div>
          </div>

          {/* Bottom Sidebar Summary: Shared Knowledge Base Shortcut */}
          {currentProject && (
            <div className="border-t border-white/[0.07] p-3">
              <button
                type="button"
                onClick={() => setActiveTab('kb')}
                className={cx(
                  'flex w-full cursor-pointer items-center justify-between rounded-xl border px-3 py-2 text-left transition-colors',
                  activeTab === 'kb'
                    ? 'border-indigo-400/40 bg-indigo-500/15 text-white'
                    : 'border-white/[0.08] bg-white/[0.03] text-zinc-300 hover:bg-white/[0.06]'
                )}
              >
                <div className="flex items-center gap-2">
                  <BookOpen size={14} className="text-indigo-400" />
                  <div>
                    <div className="text-[12.5px] font-medium">Project Knowledge Base</div>
                    <div className="text-[10.5px] text-zinc-400">
                      {(kbEntries ?? []).length} entries shared across all AIs
                    </div>
                  </div>
                </div>
              </button>
            </div>
          )}
        </aside>

        {/* Center Main Workspace */}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Project Workspace Sub-Navigation Bar */}
          {currentProject && (
            <div className="flex shrink-0 items-center justify-between border-b border-white/[0.07] bg-[#101218]/60 px-6 py-2.5">
              <div className="flex items-center gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <h1 className="text-[15px] font-semibold text-white">{currentProject.name}</h1>
                    {currentProject.folder && (
                      <button
                        type="button"
                        onClick={() => api.app.openPath(currentProject.folder)}
                        className="inline-flex cursor-pointer items-center gap-1 rounded bg-white/[0.05] px-2 py-0.5 font-mono text-[11px] text-zinc-400 hover:bg-white/[0.1] hover:text-zinc-200"
                        title="Open folder in Explorer"
                      >
                        <FolderOpen size={11} /> {currentProject.folder}
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Workspace Mode Tabs: Agent Session | Task Queue | Shared Knowledge Base */}
              <div className="flex items-center gap-1 rounded-xl border border-white/[0.08] bg-black/35 p-1">
                <button
                  type="button"
                  onClick={() => setActiveTab('session')}
                  className={cx(
                    'inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1 text-[12.5px] font-medium transition-colors',
                    activeTab === 'session' ? 'bg-white/[0.12] text-white' : 'text-zinc-400 hover:text-zinc-200'
                  )}
                >
                  <MessageSquare size={13} />
                  <span>Agent Workspace</span>
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab('queue')}
                  className={cx(
                    'inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1 text-[12.5px] font-medium transition-colors',
                    activeTab === 'queue' ? 'bg-white/[0.12] text-white' : 'text-zinc-400 hover:text-zinc-200'
                  )}
                >
                  <ListChecks size={13} />
                  <span>Task Queue</span>
                  {queueItems.filter((t) => t.status !== 'done').length > 0 && (
                    <span className="rounded-full bg-indigo-500/25 px-1.5 py-0.2 text-[10.5px] text-indigo-300">
                      {queueItems.filter((t) => t.status !== 'done').length}
                    </span>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab('kb')}
                  className={cx(
                    'inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1 text-[12.5px] font-medium transition-colors',
                    activeTab === 'kb' ? 'bg-white/[0.12] text-white' : 'text-zinc-400 hover:text-zinc-200'
                  )}
                >
                  <BookOpen size={13} />
                  <span>Knowledge Base</span>
                  <span className="rounded-full bg-emerald-500/20 px-1.5 py-0.2 text-[10.5px] text-emerald-300">
                    {(kbEntries ?? []).length}
                  </span>
                </button>
              </div>
            </div>
          )}

          {/* Main Tab Content */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {activeTab === 'session' && (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                {!activeTask ? (
                  /* Centered New Session View — Matches User Screenshot! */
                  <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-8">
                    <div className="w-full max-w-[780px] space-y-6">
                      <div className="space-y-1.5 text-center">
                        <div className="mx-auto mb-2 inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1 text-[12px] text-zinc-300">
                          <CliAvatar cli={selectedCli} size={15} />
                          <span>Centralized AI Subscriptions — Zero API Credit Cost</span>
                        </div>
                        <h2 className="text-2xl font-semibold tracking-tight text-white">
                          What are we building in {currentProject?.name ?? 'your project'}?
                        </h2>
                        <p className="muted text-[13.5px]">
                          Pick any authenticated subscription model below. Every AI automatically shares{' '}
                          <button
                            type="button"
                            onClick={() => setActiveTab('kb')}
                            className="cursor-pointer text-indigo-400 underline hover:text-indigo-300"
                          >
                            {currentProject?.name}&apos;s Knowledge Base
                          </button>
                          .
                        </p>
                      </div>

                      {/* Screenshot Composer Box */}
                      <SubscriptionComposer
                        projects={projectsList ?? []}
                        currentProject={currentProject}
                        onSelectProject={handleSelectProject}
                        onNewProject={() => setEditingProject({ name: '', folder: '', notes: '' })}
                        clis={clis ?? []}
                        selectedCli={selectedCli}
                        selectedModel={selectedModel}
                        onSelectCliModel={(c, m) => {
                          setSelectedCli(c)
                          setSelectedModel(m)
                        }}
                        permissionMode={permissionMode}
                        onChangePermissionMode={setPermissionMode}
                        checkoutMode={checkoutMode}
                        onChangeCheckoutMode={setCheckoutMode}
                        projectFiles={projectFiles ?? []}
                        knowledgeEntries={kbEntries ?? []}
                        onOpenKnowledgeBase={() => setActiveTab('kb')}
                        onAuthenticateCli={handleAuthenticateCli}
                        onRefreshClis={reloadClis}
                        submitMode={submitMode}
                        onChangeSubmitMode={setSubmitMode}
                        onSubmit={handleComposerSubmit}
                      />

                      {/* Quick Action Starter Cards */}
                      {currentProject && (
                        <div className="grid grid-cols-1 gap-2.5 pt-2 sm:grid-cols-3">
                          <button
                            type="button"
                            onClick={() => setActiveTab('kb')}
                            className="card flex cursor-pointer items-start gap-2.5 p-3 text-left transition-colors hover:border-white/[0.16]"
                          >
                            <BookOpen size={16} className="mt-0.5 shrink-0 text-indigo-400" />
                            <div>
                              <div className="text-[12.5px] font-medium text-zinc-200">Shared Knowledge Base</div>
                              <div className="muted text-[11.5px]">
                                {(kbEntries ?? []).length} entries synced to `.ai-kb` for all AIs
                              </div>
                            </div>
                          </button>

                          <button
                            type="button"
                            onClick={() => setActiveTab('queue')}
                            className="card flex cursor-pointer items-start gap-2.5 p-3 text-left transition-colors hover:border-white/[0.16]"
                          >
                            <ListChecks size={16} className="mt-0.5 shrink-0 text-emerald-400" />
                            <div>
                              <div className="text-[12.5px] font-medium text-zinc-200">Unattended Task Queue</div>
                              <div className="muted text-[11.5px]">
                                Auto-runs on git worktrees with limit handover
                              </div>
                            </div>
                          </button>

                          <button
                            type="button"
                            onClick={() => setShowTerminal(true)}
                            className="card flex cursor-pointer items-start gap-2.5 p-3 text-left transition-colors hover:border-white/[0.16]"
                          >
                            <Terminal size={16} className="mt-0.5 shrink-0 text-amber-400" />
                            <div>
                              <div className="text-[12.5px] font-medium text-zinc-200">Embedded CLI Terminal</div>
                              <div className="muted text-[11.5px]">
                                Interact directly with `claude`, `agy`, or `git`
                              </div>
                            </div>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  /* Active Session / Agent Stream View + Bottom Composer */
                  <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
                      <div className="mx-auto max-w-[880px]">
                        <ActiveSessionStream
                          task={activeTask}
                          project={currentProject!}
                          onOpenTerminal={() => setShowTerminal(true)}
                        />
                      </div>
                    </div>

                    <div className="shrink-0 border-t border-white/[0.07] bg-[#0e1016]/90 px-6 py-3">
                      <div className="mx-auto max-w-[880px]">
                        <SubscriptionComposer
                          projects={projectsList ?? []}
                          currentProject={currentProject}
                          onSelectProject={handleSelectProject}
                          onNewProject={() => setEditingProject({ name: '', folder: '', notes: '' })}
                          clis={clis ?? []}
                          selectedCli={selectedCli}
                          selectedModel={selectedModel}
                          onSelectCliModel={(c, m) => {
                            setSelectedCli(c)
                            setSelectedModel(m)
                          }}
                          permissionMode={permissionMode}
                          onChangePermissionMode={setPermissionMode}
                          checkoutMode={activeTask.checkout_mode}
                          onChangeCheckoutMode={(c) =>
                            act(
                              api.projects.saveTask({
                                id: activeTask.id,
                                title: activeTask.title,
                                notes: activeTask.notes,
                                checkout_mode: c
                              })
                            )
                          }
                          projectFiles={projectFiles ?? []}
                          knowledgeEntries={kbEntries ?? []}
                          onOpenKnowledgeBase={() => setActiveTab('kb')}
                          onAuthenticateCli={handleAuthenticateCli}
                          onRefreshClis={reloadClis}
                          isRunning={activeTask.run_state === 'running'}
                          onStop={() => act(api.projects.stop(activeTask.id), 'Stopped')}
                          placeholder={`Reply or continue with ${selectedCli.toUpperCase()} (${selectedModel})…`}
                          onSubmit={handleComposerSubmit}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'queue' && currentProject && (
              <div className="flex-1 overflow-y-auto px-6 py-5">
                <div className="mx-auto max-w-[960px]">
                  <ProjectTaskQueueView
                    project={currentProject}
                    tasks={queueItems}
                    clis={clis ?? []}
                    selectedCli={selectedCli}
                    selectedModel={selectedModel}
                    onSelectCliModel={(c, m) => {
                      setSelectedCli(c)
                      setSelectedModel(m)
                    }}
                    permissionMode={permissionMode}
                    onChangePermissionMode={setPermissionMode}
                    projectFiles={projectFiles ?? []}
                    knowledgeEntries={kbEntries ?? []}
                    onOpenKnowledgeBase={() => setActiveTab('kb')}
                    onAuthenticateCli={handleAuthenticateCli}
                    onRefreshClis={reloadClis}
                    onOpenSession={(taskId) => {
                      setActiveTaskId(taskId)
                      setActiveTab('session')
                    }}
                  />
                </div>
              </div>
            )}

            {activeTab === 'kb' && currentProject && (
              <div className="flex-1 overflow-y-auto px-6 py-5">
                <div className="mx-auto max-w-[960px]">
                  <KnowledgeBaseView project={currentProject} entries={kbEntries ?? []} />
                </div>
              </div>
            )}
          </div>

          {/* Bottom Toggleable Embedded Terminal Drawer */}
          {showTerminal && (
            <div className="h-72 shrink-0 border-t border-white/[0.1] bg-[#0a0b0f] p-2">
              <EmbeddedTerminal
                sessionId={`proj-${currentProject?.id ?? 0}`}
                cwd={activeTask?.worktree || currentProject?.folder || ''}
                clis={clis ?? []}
                initialCommand={terminalCmd}
                onClose={() => {
                  setShowTerminal(false)
                  setTerminalCmd(undefined)
                }}
              />
            </div>
          )}
        </main>
      </div>

      {/* Modals */}
      {editingProject && (
        <ProjectModal
          project={editingProject}
          onClose={() => setEditingProject(null)}
          onSaved={(saved) => {
            setSelectedProjectId(saved.id)
            setEditingProject(null)
          }}
        />
      )}

      {showLimitsModal && (
        <LiveLimitsModal
          clis={clis ?? []}
          settings={settings}
          onAuthenticateCli={handleAuthenticateCli}
          onRefresh={reloadClis}
          onClose={() => setShowLimitsModal(false)}
        />
      )}

      {showSettingsModal && settings && (
        <SettingsModal settings={settings} onClose={() => setShowSettingsModal(false)} />
      )}

      {/* Toast Notifications */}
      {toasts.length > 0 && (
        <div className="fixed right-4 bottom-4 z-50 flex flex-col gap-2">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={cx(
                'rounded-xl border px-3.5 py-2 text-[12.5px] font-medium shadow-xl backdrop-blur-xl',
                t.isError
                  ? 'border-red-500/40 bg-red-950/90 text-red-200'
                  : 'border-white/[0.12] bg-[#181a22]/95 text-white'
              )}
            >
              {t.text}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Live Agent Stream View for an active or completed thread/task, with Tool Calls, Thinking, Diffs, Checks, and Branch Merge! */
function ActiveSessionStream({
  task: t,
  project,
  onOpenTerminal
}: {
  task: ProjectTask
  project: Project
  onOpenTerminal: () => void
}): React.JSX.Element {
  const [subTab, setSubTab] = useState<'stream' | 'changes'>('stream')
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const { data: logs } = useData(() => api.projects.log(t.id), [t.id, t.run_state, t.tokens])
  const { data: changes } = useData(() => api.projects.changes(t.id), [t.id, t.run_state])
  const { data: fileDiff } = useData(
    () => (selectedFile ? api.projects.diff(t.id, selectedFile) : Promise.resolve('')),
    [t.id, selectedFile]
  )
  const bottomRef = useRef<HTMLDivElement>(null)
  const busy = t.run_state === 'running'
  const activeCli = (t.runner || t.cli || 'agy') as CliId

  useEffect(() => {
    if (busy) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs?.length, busy])

  const handleMerge = (): void => {
    if (confirmAction(`Merge branch ${t.branch} into ${project.name}?`)) {
      act(api.projects.merge(t.id), `Merged into ${project.name}`)
    }
  }

  return (
    <div className="space-y-4">
      {/* Session Header Card */}
      <div className="card flex flex-wrap items-center justify-between gap-3 p-3.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <CliAvatar cli={activeCli} size={18} />
            <h3 className="truncate text-[14.5px] font-semibold text-white">{t.title}</h3>
            {t.model && (
              <span className="rounded-full border border-white/[0.1] bg-white/[0.05] px-2 py-0.5 font-mono text-[11px] text-zinc-300">
                {t.model}
              </span>
            )}
            {busy && (
              <span className="inline-flex items-center gap-1 rounded-full bg-indigo-500/20 px-2.5 py-0.5 text-[11px] font-medium text-indigo-300">
                <Loader2 size={11} className="animate-spin" /> Working live
              </span>
            )}
            {t.check_state === 'passed' && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-300">
                <ShieldCheck size={12} /> Checks passed
              </span>
            )}
            {t.check_state === 'failed' && (
              <span className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] text-red-300">
                <ShieldX size={12} /> Checks failed
              </span>
            )}
          </div>

          <div className="muted mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px]">
            {t.branch && (
              <span className="flex items-center gap-1 font-mono text-zinc-300">
                <GitBranch size={11} className="text-emerald-400" /> {t.branch}
              </span>
            )}
            {t.worktree && (
              <button
                type="button"
                onClick={() => api.app.openPath(t.worktree!)}
                className="flex cursor-pointer items-center gap-1 hover:text-white hover:underline"
              >
                <FolderOpen size={11} /> {t.checkout_mode === 'worktree' ? 'Open worktree' : 'Open folder'}
              </button>
            )}
            {t.runs > 0 && (
              <span>
                {t.runs} run{t.runs > 1 ? 's' : ''} · {fmtTokens(t.tokens)} tokens · {fmtDuration(t.run_ms)}
              </span>
            )}
          </div>
        </div>

        {/* Session Actions & Sub-tabs */}
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="flex rounded-lg border border-white/[0.08] bg-black/30 p-0.5">
            <button
              type="button"
              onClick={() => setSubTab('stream')}
              className={cx(
                'cursor-pointer rounded-md px-2.5 py-1 text-[12px] font-medium',
                subTab === 'stream' ? 'bg-white/[0.12] text-white' : 'text-zinc-400 hover:text-zinc-200'
              )}
            >
              Live Stream ({logs?.length ?? 0})
            </button>
            <button
              type="button"
              onClick={() => setSubTab('changes')}
              className={cx(
                'cursor-pointer rounded-md px-2.5 py-1 text-[12px] font-medium',
                subTab === 'changes' ? 'bg-white/[0.12] text-white' : 'text-zinc-400 hover:text-zinc-200'
              )}
            >
              Changes ({changes?.files.length ?? 0})
            </button>
          </div>

          <button
            type="button"
            onClick={onOpenTerminal}
            className="btn h-7 px-2.5 text-[11.5px]"
            title="Open embedded terminal in this workspace"
          >
            <SquareTerminal size={12} /> Terminal
          </button>

          {!busy && !!project.check_cmd && (
            <button
              type="button"
              onClick={() => act(api.projects.check(t.id), 'Running project checks')}
              className="btn h-7 px-2.5 text-[11.5px]"
              title={`Run ${project.check_cmd}`}
            >
              <ShieldCheck size={12} /> Check
            </button>
          )}

          {!busy && t.checkout_mode === 'worktree' && t.branch && (
            <button
              type="button"
              onClick={handleMerge}
              disabled={Boolean(project.check_cmd && t.check_state !== 'passed')}
              className="btn btn-primary h-7 px-2.5 text-[11.5px]"
              title={project.check_cmd && t.check_state !== 'passed' ? 'Run checks first before merging' : `Merge ${t.branch}`}
            >
              <GitMerge size={12} /> Merge Branch
            </button>
          )}
        </div>
      </div>

      {/* Stream Content vs Git Changes Content */}
      {subTab === 'stream' ? (
        <div className="space-y-2.5">
          {(logs ?? []).map((l, i) => {
            if (l.kind === 'you') {
              return (
                <div key={i} className="ml-auto max-w-[85%] rounded-2xl border border-white/[0.1] bg-[#1e2029] px-4 py-2.5 text-[13.5px] text-zinc-100">
                  <div className="mb-1 flex items-center justify-between text-[11px] text-zinc-400">
                    <span className="font-semibold text-zinc-300">You</span>
                    <span>{relative(l.at)}</span>
                  </div>
                  <div className="whitespace-pre-wrap">{l.text}</div>
                </div>
              )
            }

            if (l.kind === 'tool') {
              return (
                <div
                  key={i}
                  className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-black/35 px-3 py-1.5 font-mono text-[12px] text-zinc-300"
                >
                  <FileCode2 size={13} className="shrink-0 text-sky-400" />
                  <span className="truncate">{l.text}</span>
                </div>
              )
            }

            if (l.kind === 'thinking') {
              return (
                <details key={i} className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-1.5 text-[12px] text-zinc-400">
                  <summary className="cursor-pointer font-medium text-zinc-400">Reasoning / Thinking step</summary>
                  <pre className="mt-1.5 whitespace-pre-wrap font-sans text-[12px] text-zinc-400">{l.text}</pre>
                </details>
              )
            }

            if (l.kind === 'handoff') {
              return (
                <div
                  key={i}
                  className="flex items-center gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-[12.5px] text-amber-200"
                >
                  <Sparkles size={15} className="shrink-0 text-amber-400" />
                  <span>{l.text}</span>
                </div>
              )
            }

            if (l.kind === 'error') {
              return (
                <div
                  key={i}
                  className="flex items-start gap-2.5 rounded-xl border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-[12.5px] text-red-300"
                >
                  <AlertTriangle size={15} className="mt-0.5 shrink-0 text-red-400" />
                  <span className="whitespace-pre-wrap">{l.text}</span>
                </div>
              )
            }

            if (l.kind === 'info') {
              return (
                <div key={i} className="px-2 text-[11.5px] italic text-zinc-500">
                  {l.text}
                </div>
              )
            }

            return (
              <div key={i} className="card space-y-1.5 p-4">
                <div className="flex items-center gap-2 text-[11.5px] text-zinc-400">
                  <CliAvatar cli={(l.cli || activeCli) as CliId} size={14} />
                  <span className="font-semibold text-zinc-200">{(l.cli || activeCli).toUpperCase()}</span>
                  {l.model && <span className="font-mono text-zinc-500">{l.model}</span>}
                </div>
                <Markdown text={l.text} />
              </div>
            )
          })}

          {busy && (
            <div className="card flex items-center gap-3.5 p-4">
              <CliAvatar cli={activeCli} size={32} />
              <div>
                <div className="flex items-center gap-1.5 text-[13.5px] font-medium text-white">
                  <CliSpinner />
                  <span className="cli-shimmer">
                    {activeCli.toUpperCase()} ({t.model || 'default'}) is streaming live…
                  </span>
                </div>
                <p className="muted text-[12px]">
                  Tool executions and file edits appear above as they happen.
                </p>
              </div>
            </div>
          )}

          {t.check_state === 'failed' && t.check_output && (
            <div className="card border-red-500/30 p-3.5">
              <div className="mb-1.5 text-[12px] font-semibold text-red-400">Verification Check Output:</div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-black/40 p-2.5 font-mono text-[11.5px] text-zinc-300">
                {t.check_output}
              </pre>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      ) : (
        /* Git Changes & Diff Viewer */
        <div className="card space-y-4 p-4">
          {!changes ? (
            <p className="muted text-[13px]">No git repository detected in this folder.</p>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <span className="text-[12.5px] font-semibold text-zinc-200">
                  Modified Files ({changes.files.length}) on `{changes.branch}`
                </span>
                {changes.uncommitted && (
                  <span className="rounded-full bg-amber-500/15 px-2.5 py-0.5 text-[11px] text-amber-300">
                    Uncommitted edits in working tree
                  </span>
                )}
              </div>

              {changes.files.length === 0 ? (
                <p className="muted text-[12.5px]">No modified files yet.</p>
              ) : (
                <div className="space-y-1">
                  {changes.files.map((f) => (
                    <button
                      key={f.path}
                      type="button"
                      onClick={() => setSelectedFile(selectedFile === f.path ? null : f.path)}
                      className={cx(
                        'flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left font-mono text-[12px] transition-colors',
                        selectedFile === f.path ? 'bg-white/[0.1] text-white' : 'text-zinc-300 hover:bg-white/[0.05]'
                      )}
                    >
                      <span
                        className={cx(
                          'w-4 font-bold',
                          f.status === 'A' ? 'text-emerald-400' : f.status === 'D' ? 'text-red-400' : 'text-amber-400'
                        )}
                      >
                        {f.status}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{f.path}</span>
                      <span className="text-emerald-400">+{f.added}</span>
                      <span className="text-red-400">-{f.removed}</span>
                    </button>
                  ))}
                </div>
              )}

              {selectedFile && (
                <pre className="max-h-96 overflow-auto rounded-lg border border-white/[0.08] bg-black/50 p-3 font-mono text-[11.5px] leading-relaxed">
                  {(fileDiff ?? '').split('\n').map((line, idx) => (
                    <div
                      key={idx}
                      className={cx(
                        line.startsWith('+') && !line.startsWith('+++') && 'bg-emerald-500/15 text-emerald-300',
                        line.startsWith('-') && !line.startsWith('---') && 'bg-red-500/15 text-red-300',
                        line.startsWith('@@') && 'text-indigo-400'
                      )}
                    >
                      {line || ' '}
                    </div>
                  ))}
                </pre>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** Project Task Queue View — Queued, In Progress, Done, Auto-Run Queue on Isolated Git Worktrees! */
function ProjectTaskQueueView({
  project,
  tasks,
  clis,
  selectedCli,
  selectedModel,
  onSelectCliModel,
  permissionMode,
  onChangePermissionMode,
  projectFiles,
  knowledgeEntries,
  onOpenKnowledgeBase,
  onAuthenticateCli,
  onRefreshClis,
  onOpenSession
}: {
  project: Project
  tasks: ProjectTask[]
  clis: CliSubscriptionStatus[]
  selectedCli: CliId
  selectedModel: string
  onSelectCliModel: (c: CliId, m: string) => void
  permissionMode: PermissionMode
  onChangePermissionMode: (m: PermissionMode) => void
  projectFiles: string[]
  knowledgeEntries: import('@shared/types').KnowledgeEntry[]
  onOpenKnowledgeBase: () => void
  onAuthenticateCli: (c: CliSubscriptionStatus) => void
  onRefreshClis: () => void
  onOpenSession: (id: number) => void
}): React.JSX.Element {
  const [showDone, setShowDone] = useState(false)
  const doing = tasks.filter((t) => t.status === 'doing')
  const queued = tasks.filter((t) => t.status === 'queued')
  const done = tasks.filter((t) => t.status === 'done')

  const move = (i: number, by: number): void => {
    const ids = queued.map((t) => t.id)
    const j = i + by
    if (j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    act(api.projects.reorder(project.id, ids))
  }

  const copyPrompt = async (t: ProjectTask): Promise<void> => {
    await navigator.clipboard.writeText(`${t.title}\n\n${t.notes}`.trim())
    toast('Task prompt copied to clipboard')
  }

  const renderTaskRow = (t: ProjectTask, i?: number): React.JSX.Element => {
    const cliUsed = (t.runner || t.cli || 'agy') as CliId
    return (
      <div key={t.id} className="group flex items-center gap-3 px-4 py-3">
        {t.status === 'done' ? (
          <Check size={14} className="shrink-0 text-emerald-400" />
        ) : t.run_state === 'running' ? (
          <CliAvatar cli={cliUsed} size={18} />
        ) : (
          <span className="muted w-5 shrink-0 text-right font-mono text-[11.5px]">{(i ?? 0) + 1}</span>
        )}

        <button
          type="button"
          onClick={() => onOpenSession(t.id)}
          className="min-w-0 flex-1 cursor-pointer text-left"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className={cx('text-[13.5px] font-medium', t.status === 'done' ? 'text-zinc-500 line-through' : 'text-zinc-100')}>
              {t.title}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-white/[0.08] bg-white/[0.04] px-2 py-0.2 text-[10.5px] text-zinc-300">
              <CliAvatar cli={cliUsed} size={11} /> {cliUsed.toUpperCase()} {t.model && `· ${t.model}`}
            </span>
            {t.run_state === 'running' && (
              <span className="rounded-full bg-indigo-500/20 px-2 py-0.2 text-[10.5px] text-indigo-300">Working</span>
            )}
            {t.run_state === 'waiting' && (
              <span className="rounded-full bg-amber-500/20 px-2 py-0.2 text-[10.5px] text-amber-300">Ready to review</span>
            )}
            {t.run_state === 'failed' && (
              <span className="rounded-full bg-red-500/20 px-2 py-0.2 text-[10.5px] text-red-300">Stopped</span>
            )}
          </div>
          {t.branch && (
            <span className="muted mt-0.5 flex items-center gap-1 font-mono text-[11px]">
              <GitBranch size={10} /> {t.branch}
            </span>
          )}
        </button>

        <span className="muted shrink-0 text-[11.5px]">{relative(t.done_at ?? t.started_at ?? t.created_at)}</span>

        <div className="flex shrink-0 items-center gap-1">
          {i !== undefined && (
            <>
              <button
                type="button"
                disabled={i === 0}
                onClick={() => move(i, -1)}
                className="btn btn-ghost btn-icon h-7 w-7"
                title="Move up"
              >
                <ChevronUp size={13} />
              </button>
              <button
                type="button"
                disabled={i === queued.length - 1}
                onClick={() => move(i, 1)}
                className="btn btn-ghost btn-icon h-7 w-7"
                title="Move down"
              >
                <ChevronDown size={13} />
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => copyPrompt(t)}
            className="btn btn-ghost btn-icon h-7 w-7"
            title="Copy prompt"
          >
            <Copy size={12} />
          </button>
          {t.status === 'queued' && (
            <button
              type="button"
              onClick={() => act(api.projects.start(t.id), 'Started on isolated git worktree').then(() => onOpenSession(t.id))}
              className="btn h-7 px-2.5 text-[11.5px]"
            >
              <Play size={11} /> Start
            </button>
          )}
          {t.status === 'doing' && (
            <button type="button" onClick={() => onOpenSession(t.id)} className="btn h-7 px-2.5 text-[11.5px]">
              Open Stream
            </button>
          )}
          {t.status === 'done' && (
            <button
              type="button"
              onClick={() => act(api.projects.setStatus(t.id, 'queued'))}
              className="btn btn-ghost btn-icon h-7 w-7"
              title="Requeue"
            >
              <RotateCcw size={12} />
            </button>
          )}
          <button
            type="button"
            onClick={() =>
              (!t.branch || confirmAction(`Delete "${t.title}" and discard its worktree branch?`)) &&
              act(api.projects.deleteTask(t.id), 'Deleted')
            }
            className="btn btn-ghost btn-icon btn-danger h-7 w-7"
            title="Delete task"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[16px] font-semibold text-white">Unattended Task Queue — {project.name}</h2>
          <p className="muted text-[12.5px]">
            Each queued task runs on its own isolated git worktree branch, shares the Project Knowledge Base, and automatically hands over to another subscription if a rate limit is hit.
          </p>
        </div>

        {project.auto_run ? (
          <button
            type="button"
            onClick={() => act(api.projects.runQueue(project.id, false), 'Queue will pause after current task')}
            className="btn h-8 border-amber-400/35 bg-amber-500/15 text-amber-200"
          >
            <Pause size={13} /> Pause Auto-Queue
          </button>
        ) : (
          <button
            type="button"
            disabled={!queued.some((t) => !t.run_state)}
            onClick={() => act(api.projects.runQueue(project.id, true), 'Auto-running queue')}
            className="btn btn-primary h-8"
          >
            <ListStart size={14} /> Run Queue ({queued.filter((t) => !t.run_state).length})
          </button>
        )}
      </div>

      {/* Composer set to Queue Task mode */}
      <SubscriptionComposer
        projects={[project]}
        currentProject={project}
        onSelectProject={() => undefined}
        onNewProject={() => undefined}
        clis={clis}
        selectedCli={selectedCli}
        selectedModel={selectedModel}
        onSelectCliModel={onSelectCliModel}
        permissionMode={permissionMode}
        onChangePermissionMode={onChangePermissionMode}
        checkoutMode="worktree"
        onChangeCheckoutMode={() => undefined}
        projectFiles={projectFiles}
        knowledgeEntries={knowledgeEntries}
        onOpenKnowledgeBase={onOpenKnowledgeBase}
        onAuthenticateCli={onAuthenticateCli}
        onRefreshClis={onRefreshClis}
        placeholder="Add a task to the queue (Enter adds to queue)…"
        submitMode="task"
        onSubmit={async (prompt, mentions) => {
          await act(
            api.projects.createAndRun({
              projectId: project.id,
              prompt,
              kind: 'task',
              cli: selectedCli,
              model: selectedModel,
              permissionMode,
              checkoutMode: 'worktree',
              mentions,
              startImmediately: false
            }),
            'Task added to queue'
          )
        }}
      />

      {doing.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="text-[11.5px] font-semibold tracking-wider text-emerald-400 uppercase">In Progress ({doing.length})</h3>
          <div className="card divide-y divide-white/[0.06] border-emerald-500/30">{doing.map((t) => renderTaskRow(t))}</div>
        </section>
      )}

      <section className="space-y-1.5">
        <h3 className="text-[11.5px] font-semibold tracking-wider text-zinc-400 uppercase">Queued ({queued.length})</h3>
        {queued.length === 0 ? (
          <div className="card p-6 text-center text-[13px] text-zinc-400">
            No tasks waiting in the queue. Use the composer above to queue tasks for Claude Code or Antigravity.
          </div>
        ) : (
          <div className="card divide-y divide-white/[0.06]">{queued.map((t, i) => renderTaskRow(t, i))}</div>
        )}
      </section>

      {done.length > 0 && (
        <section className="space-y-1.5">
          <button
            type="button"
            onClick={() => setShowDone(!showDone)}
            className="cursor-pointer text-[11.5px] font-semibold tracking-wider text-zinc-400 uppercase hover:text-white"
          >
            {showDone ? 'Hide' : 'Show'} Completed ({done.length})
          </button>
          {showDone && <div className="card divide-y divide-white/[0.06]">{done.map((t) => renderTaskRow(t))}</div>}
        </section>
      )}
    </div>
  )
}

function ProjectModal({
  project,
  onClose,
  onSaved
}: {
  project: Partial<Project>
  onClose: () => void
  onSaved: (p: Project) => void
}): React.JSX.Element {
  const [p, setP] = useState(project)

  const chooseFolder = async (): Promise<void> => {
    const folder = await api.app.chooseFolder()
    if (folder) {
      setP({
        ...p,
        folder,
        name: p.name || folder.split(/[\\/]/).pop() || ''
      })
    }
  }

  const save = async (): Promise<void> => {
    const saved = await act(api.projects.save({ ...p, name: p.name ?? '' }), 'Project saved')
    if (saved) onSaved(saved)
  }

  return (
    <Modal
      title={p.id ? 'Edit Project' : 'New Project'}
      onClose={onClose}
      footer={
        <>
          {p.id && (
            <>
              <button
                type="button"
                onClick={() => act(api.projects.archive(p.id!, !p.archived_at), p.archived_at ? 'Unarchived' : 'Archived').then(onClose)}
                className="btn btn-ghost"
              >
                <Archive size={13} /> {p.archived_at ? 'Unarchive' : 'Archive'}
              </button>
              <button
                type="button"
                onClick={() => confirmAction(`Delete ${p.name} and all its sessions?`) && act(api.projects.delete(p.id!), 'Deleted').then(onClose)}
                className="btn btn-ghost btn-danger"
              >
                <Trash2 size={13} /> Delete
              </button>
            </>
          )}
          <span className="flex-1" />
          <button type="button" onClick={onClose} className="btn">
            Cancel
          </button>
          <button type="button" onClick={save} className="btn btn-primary">
            Save Project
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Project Folder (Git repository or workspace)">
          <div className="flex gap-2">
            <input
              className="input flex-1 font-mono text-[12.5px]"
              value={p.folder ?? ''}
              onChange={(e) => setP({ ...p, folder: e.target.value })}
              placeholder="D:\MyProject"
            />
            <button type="button" onClick={chooseFolder} className="btn h-9">
              <FolderOpen size={13} /> Browse
            </button>
          </div>
        </Field>

        <Field label="Project Name">
          <input
            className="input"
            value={p.name ?? ''}
            onChange={(e) => setP({ ...p, name: e.target.value })}
            placeholder="My App"
            autoFocus={!p.id}
          />
        </Field>

        <Field label="Standing Project Notes (shared across all AI CLIs in Knowledge Base)">
          <textarea
            className="input min-h-[90px]"
            value={p.notes ?? ''}
            onChange={(e) => setP({ ...p, notes: e.target.value })}
            placeholder="Tech stack, coding rules, things to avoid…"
          />
        </Field>

        <Field label="Verification Check Command (run before merging task branches)">
          <input
            className="input font-mono text-[12.5px]"
            value={p.check_cmd ?? ''}
            onChange={(e) => setP({ ...p, check_cmd: e.target.value })}
            placeholder="npm run typecheck && npm run build"
          />
        </Field>
      </div>
    </Modal>
  )
}

function SettingsModal({ settings, onClose }: { settings: Settings; onClose: () => void }): React.JSX.Element {
  const [s, setS] = useState(settings)

  const save = async (): Promise<void> => {
    await act(api.settings.update(s), 'Settings updated')
    onClose()
  }

  return (
    <Modal
      title="CLI Executables & Knowledge Base Settings"
      width="max-w-xl"
      onClose={onClose}
      footer={
        <>
          <span className="flex-1" />
          <button type="button" onClick={onClose} className="btn">
            Cancel
          </button>
          <button type="button" onClick={save} className="btn btn-primary">
            Save Settings
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Antigravity CLI Path (leave empty for auto-detection)" hint="Finds `agy` on PATH or `%LOCALAPPDATA%\agy\bin\agy.exe`">
          <input
            className="input font-mono text-[12px]"
            value={s.agyPath}
            onChange={(e) => setS({ ...s, agyPath: e.target.value })}
            placeholder="Auto-detect agy.exe"
          />
        </Field>

        <Field label="Claude Code CLI Path (leave empty for auto-detection)" hint="Finds `claude` on PATH or Claude Desktop bundled binary">
          <input
            className="input font-mono text-[12px]"
            value={s.claudePath}
            onChange={(e) => setS({ ...s, claudePath: e.target.value })}
            placeholder="Auto-detect claude.exe"
          />
        </Field>

        <Field label="OpenAI Codex CLI Path (leave empty for auto-detection)">
          <input
            className="input font-mono text-[12px]"
            value={s.codexPath}
            onChange={(e) => setS({ ...s, codexPath: e.target.value })}
            placeholder="Auto-detect codex"
          />
        </Field>

        <Field label="Gemini CLI Path (leave empty for auto-detection)">
          <input
            className="input font-mono text-[12px]"
            value={s.geminiPath}
            onChange={(e) => setS({ ...s, geminiPath: e.target.value })}
            placeholder="Auto-detect gemini"
          />
        </Field>

        <div className="space-y-2 pt-2">
          <label className="flex cursor-pointer items-center gap-2 text-[13px] text-zinc-200">
            <input
              type="checkbox"
              checked={s.syncKbToDisk}
              onChange={(e) => setS({ ...s, syncKbToDisk: e.target.checked })}
              className="accent-indigo-500"
            />
            Sync Project Knowledge Base to `.ai-kb/PROJECT_KNOWLEDGE.md` in each project folder
          </label>

          <label className="flex cursor-pointer items-center gap-2 text-[13px] text-zinc-200">
            <input
              type="checkbox"
              checked={s.autoUpdateKb}
              onChange={(e) => setS({ ...s, autoUpdateKb: e.target.checked })}
              className="accent-indigo-500"
            />
            Automatically record AI handoff summaries in the Knowledge Base after each run
          </label>

          <label className="flex cursor-pointer items-center gap-2 text-[13px] text-zinc-200">
            <input
              type="checkbox"
              checked={s.cliHandover}
              onChange={(e) => setS({ ...s, cliHandover: e.target.checked })}
              className="accent-indigo-500"
            />
            Automatically hand over tasks when a CLI reaches its subscription rate limit
          </label>
        </div>
      </div>
    </Modal>
  )
}
