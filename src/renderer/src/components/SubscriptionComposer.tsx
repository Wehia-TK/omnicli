import { useEffect, useRef, useState } from 'react'
import {
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  FileText,
  Folder,
  GitBranch,
  Lock,
  Mic,
  Monitor,
  Plus,
  RefreshCw,
  Shield,
  Square,
  Terminal,
  X
} from 'lucide-react'
import type {
  CheckoutMode,
  CliId,
  CliSubscriptionStatus,
  KnowledgeEntry,
  MentionItem,
  PermissionMode,
  Project
} from '@shared/types'
import { CliAvatar } from './CliAvatars'
import { cx } from './ui'

interface SubscriptionComposerProps {
  projects: Project[]
  currentProject: Project | undefined
  onSelectProject: (id: number) => void
  onNewProject: () => void
  clis: CliSubscriptionStatus[]
  selectedCli: CliId
  selectedModel: string
  onSelectCliModel: (cli: CliId, model: string) => void
  permissionMode: PermissionMode
  onChangePermissionMode: (m: PermissionMode) => void
  checkoutMode: CheckoutMode
  onChangeCheckoutMode: (c: CheckoutMode) => void
  projectFiles: string[]
  knowledgeEntries: KnowledgeEntry[]
  onOpenKnowledgeBase: () => void
  onAuthenticateCli: (cli: CliSubscriptionStatus) => void
  onRefreshClis: () => void
  isRunning?: boolean
  onStop?: () => void
  placeholder?: string
  submitMode?: 'thread' | 'task'
  onChangeSubmitMode?: (m: 'thread' | 'task') => void
  onSubmit: (prompt: string, mentions: MentionItem[], mode: 'thread' | 'task') => Promise<void>
}

const PERMISSION_MODES: { id: PermissionMode; label: string; desc: string }[] = [
  { id: 'default', label: 'Default', desc: 'Standard safe tool execution & file edits' },
  { id: 'accept-edits', label: 'Accept Edits', desc: 'Automatically apply file edits without prompting' },
  { id: 'bypass', label: 'Full Auto', desc: 'Bypass permission prompts for unattended runs' },
  { id: 'plan', label: 'Plan Only', desc: 'Read & design a plan without modifying files' }
]

export function SubscriptionComposer({
  projects,
  currentProject,
  onSelectProject,
  onNewProject,
  clis,
  selectedCli,
  selectedModel,
  onSelectCliModel,
  permissionMode,
  onChangePermissionMode,
  checkoutMode,
  onChangeCheckoutMode,
  projectFiles,
  knowledgeEntries,
  onOpenKnowledgeBase,
  onAuthenticateCli,
  onRefreshClis,
  isRunning,
  onStop,
  placeholder = 'Ask anything, build a feature, or queue a task across your subscriptions…',
  submitMode = 'thread',
  onChangeSubmitMode,
  onSubmit
}: SubscriptionComposerProps): React.JSX.Element {
  const [text, setText] = useState('')
  const [mentions, setMentions] = useState<MentionItem[]>([])
  const [openMenu, setOpenMenu] = useState<'project' | 'model' | 'mode' | 'checkout' | 'attach' | null>(null)
  const [fileFilter, setFileFilter] = useState('')
  const [listening, setListening] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const onClickOutside = (e: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpenMenu(null)
      }
    }
    window.addEventListener('mousedown', onClickOutside)
    return () => window.removeEventListener('mousedown', onClickOutside)
  }, [])

  const activeSub = clis.find((c) => c.id === selectedCli) ?? clis[0]
  const activeModelObj =
    activeSub?.models.find((m) => m.id === selectedModel) ??
    activeSub?.models[0] ?? {
      id: selectedModel || 'gemini-4-argon-high',
      name: selectedModel || 'Gemini 4 Argon',
      tier: 'High',
      cli: selectedCli,
      description: ''
    }

  const pinnedKbCount = knowledgeEntries.filter((k) => k.pinned).length

  const handleSend = async (): Promise<void> => {
    if (!text.trim() || isRunning) return
    if (activeSub && !activeSub.authenticated) return
    const payload = text
    const attached = [...mentions]
    setText('')
    setMentions([])
    await onSubmit(payload, attached, submitMode)
  }

  const addMention = (item: MentionItem): void => {
    if (!mentions.some((m) => m.type === item.type && m.value === item.value)) {
      setMentions([...mentions, item])
    }
    setOpenMenu(null)
    textareaRef.current?.focus()
  }

  const removeMention = (idx: number): void => {
    setMentions(mentions.filter((_, i) => i !== idx))
  }

  const toggleDictation = (): void => {
    const SpeechRecognition =
      (window as unknown as { SpeechRecognition?: new () => unknown; webkitSpeechRecognition?: new () => unknown })
        .SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: new () => unknown }).webkitSpeechRecognition
    if (!SpeechRecognition) {
      setText((prev) => (prev ? `${prev} ` : '') + '')
      textareaRef.current?.focus()
      return
    }
    if (listening) {
      setListening(false)
      return
    }
    try {
      const rec = new SpeechRecognition() as {
        lang: string
        interimResults: boolean
        onresult: (e: { results: { [k: number]: { [k: number]: { transcript: string } } } }) => void
        onend: () => void
        onerror: () => void
        start: () => void
      }
      rec.lang = 'en-US'
      rec.interimResults = false
      setListening(true)
      rec.onresult = (ev) => {
        const transcript = ev.results?.[0]?.[0]?.transcript ?? ''
        if (transcript) setText((prev) => (prev ? `${prev} ${transcript}` : transcript))
      }
      rec.onend = () => setListening(false)
      rec.onerror = () => setListening(false)
      rec.start()
    } catch {
      setListening(false)
    }
  }

  return (
    <div ref={containerRef} className="w-full select-none">
      {/* Top strip above composer box — matches screenshot `📁 AI Wrapper v` */}
      <div className="mb-2 flex items-center justify-between px-1">
        <div className="relative flex items-center gap-2">
          <button
            type="button"
            onClick={() => setOpenMenu(openMenu === 'project' ? null : 'project')}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] font-medium text-zinc-400 transition-colors hover:bg-white/[0.05] hover:text-zinc-200"
          >
            <Folder size={14} className="text-zinc-400" />
            <span>{currentProject?.name ?? 'Select Project'}</span>
            <ChevronDown size={13} className="opacity-70" />
          </button>

          {currentProject && (
            <button
              type="button"
              onClick={onOpenKnowledgeBase}
              title="Shared Project Knowledge Base — automatically accessible by all AI subscriptions"
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-indigo-500/25 bg-indigo-500/10 px-2.5 py-0.5 text-[11.5px] font-medium text-indigo-300 transition-colors hover:bg-indigo-500/20"
            >
              <BookOpen size={11} />
              <span>{pinnedKbCount} KB context shared across AIs</span>
            </button>
          )}

          {openMenu === 'project' && (
            <div className=" absolute top-full left-0 z-50 mt-1.5 w-64 rounded-xl border border-white/[0.12] bg-[#181920] p-1.5 shadow-2xl">
              <div className="px-2.5 py-1 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">Projects</div>
              {projects
                .filter((p) => !p.archived_at)
                .map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      onSelectProject(p.id)
                      setOpenMenu(null)
                    }}
                    className={cx(
                      'flex w-full cursor-pointer items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors',
                      p.id === currentProject?.id ? 'bg-white/[0.09] font-medium text-white' : 'text-zinc-300 hover:bg-white/[0.05]'
                    )}
                  >
                    <span className="flex items-center gap-2 truncate">
                      <Folder size={13} className="shrink-0 text-indigo-400" />
                      <span className="truncate">{p.name}</span>
                    </span>
                    {p.id === currentProject?.id && <Check size={13} className="text-indigo-400" />}
                  </button>
                ))}
              <div className="my-1 border-t border-white/[0.08]" />
              <button
                type="button"
                onClick={() => {
                  setOpenMenu(null)
                  onNewProject()
                }}
                className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-indigo-400 hover:bg-white/[0.05]"
              >
                <Plus size={13} /> New Project…
              </button>
            </div>
          )}
        </div>

        {/* Optional switch between interactive thread & task queue */}
        {onChangeSubmitMode && (
          <div className="flex items-center gap-1 rounded-lg border border-white/[0.07] bg-black/30 p-0.5 text-[11.5px]">
            <button
              type="button"
              onClick={() => onChangeSubmitMode('thread')}
              className={cx(
                'cursor-pointer rounded-md px-2.5 py-0.5 font-medium transition-colors',
                submitMode === 'thread' ? 'bg-white/[0.12] text-white' : 'text-zinc-400 hover:text-zinc-200'
              )}
            >
              Live Session
            </button>
            <button
              type="button"
              onClick={() => onChangeSubmitMode('task')}
              className={cx(
                'cursor-pointer rounded-md px-2.5 py-0.5 font-medium transition-colors',
                submitMode === 'task' ? 'bg-white/[0.12] text-white' : 'text-zinc-400 hover:text-zinc-200'
              )}
            >
              Queue Task
            </button>
          </div>
        )}
      </div>

      {/* Main Dark Rounded Composer Box — exact match to screenshot */}
      <div className="composer-box relative rounded-2xl px-4 pt-3.5 pb-2.5 transition-all">
        {/* Mention Chips Row (like `[📄 Personal App]` in the screenshot) */}
        {mentions.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            {mentions.map((m, idx) => (
              <span
                key={`${m.type}-${m.value}`}
                className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.1] bg-white/[0.07] px-2 py-0.5 text-[12.5px] font-semibold text-zinc-100"
              >
                {m.type === 'kb' ? <BookOpen size={12} className="text-indigo-400" /> : <FileText size={12} className="text-zinc-400" />}
                <span>{m.label}</span>
                <button
                  type="button"
                  onClick={() => removeMention(idx)}
                  className="ml-0.5 cursor-pointer rounded p-0.5 text-zinc-400 hover:bg-white/[0.1] hover:text-white"
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          rows={Math.min(6, Math.max(2, text.split('\n').length))}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSend()
            }
          }}
          placeholder={placeholder}
          className="w-full resize-none bg-transparent text-[14.5px] leading-relaxed text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
        />

        {/* Bottom Toolbar inside Composer Box */}
        <div className="mt-2 flex items-center justify-between gap-2 pt-1">
          {/* Left Controls: `+` and `Gemini 4 Argon High v` */}
          <div className="flex items-center gap-1.5">
            {/* `+` Attach / Mention Button */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setOpenMenu(openMenu === 'attach' ? null : 'attach')}
                title="Reference a file, project, or Knowledge Base entry"
                className="flex size-7 cursor-pointer items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-white/[0.08] hover:text-zinc-200"
              >
                <Plus size={16} />
              </button>

              {openMenu === 'attach' && (
                <div className="absolute bottom-full left-0 z-50 mb-2 w-80 rounded-xl border border-white/[0.12] bg-[#181920] p-2 shadow-2xl">
                  <div className="mb-1.5 px-2 text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">
                    Reference Project or Knowledge Base
                  </div>
                  <div className="max-h-28 space-y-0.5 overflow-y-auto">
                    {projects.map((p) => (
                      <button
                        key={`proj-${p.id}`}
                        type="button"
                        onClick={() => addMention({ type: 'project', label: p.name, value: p.folder || p.name })}
                        className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-left text-[12.5px] text-zinc-200 hover:bg-white/[0.07]"
                      >
                        <FileText size={13} className="shrink-0 text-amber-400" />
                        <span className="font-medium">{p.name}</span>
                        <span className="muted ml-auto truncate text-[11px]">{p.folder}</span>
                      </button>
                    ))}
                    {knowledgeEntries.map((k) => (
                      <button
                        key={`kb-${k.id}`}
                        type="button"
                        onClick={() => addMention({ type: 'kb', label: k.title, value: k.content })}
                        className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-left text-[12.5px] text-zinc-200 hover:bg-white/[0.07]"
                      >
                        <BookOpen size={13} className="shrink-0 text-indigo-400" />
                        <span className="truncate">{k.title}</span>
                        <span className="ml-auto rounded bg-indigo-500/15 px-1.5 py-0.2 text-[10px] text-indigo-300">KB</span>
                      </button>
                    ))}
                  </div>

                  {projectFiles.length > 0 && (
                    <>
                      <div className="my-1.5 border-t border-white/[0.08]" />
                      <input
                        className="input mb-1.5 h-7 text-[12px]"
                        placeholder="Filter project files…"
                        value={fileFilter}
                        onChange={(e) => setFileFilter(e.target.value)}
                      />
                      <div className="max-h-36 space-y-0.5 overflow-y-auto">
                        {projectFiles
                          .filter((f) => !fileFilter || f.toLowerCase().includes(fileFilter.toLowerCase()))
                          .slice(0, 25)
                          .map((f) => (
                            <button
                              key={f}
                              type="button"
                              onClick={() => addMention({ type: 'file', label: f.split('/').pop() || f, value: f })}
                              className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-left font-mono text-[11.5px] text-zinc-300 hover:bg-white/[0.07]"
                            >
                              <FileText size={12} className="shrink-0 text-zinc-500" />
                              <span className="truncate">{f}</span>
                            </button>
                          ))}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Unified Subscription & Model Selector — matches `Gemini 4 Argon High v` */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setOpenMenu(openMenu === 'model' ? null : 'model')}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1 text-[13.5px] transition-colors hover:bg-white/[0.07]"
              >
                <CliAvatar cli={selectedCli} size={15} />
                <span className="font-medium text-zinc-200">{activeModelObj.name}</span>
                {activeModelObj.tier && <span className="text-zinc-500">{activeModelObj.tier}</span>}
                <ChevronDown size={13} className="text-zinc-500" />
              </button>

              {openMenu === 'model' && (
                <div className="absolute bottom-full left-0 z-50 mb-2 max-h-[440px] w-[390px] overflow-y-auto rounded-2xl border border-white/[0.12] bg-[#16171d] p-2.5 shadow-2xl">
                  <div className="mb-2 flex items-center justify-between px-1.5">
                    <span className="text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">
                      AI Subscriptions & Live Limits
                    </span>
                    <button
                      type="button"
                      onClick={onRefreshClis}
                      className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-white/[0.08] hover:text-white"
                    >
                      <RefreshCw size={11} /> Refresh
                    </button>
                  </div>

                  <div className="space-y-2.5">
                    {clis.map((sub) => {
                      const locked = !sub.authenticated
                      const pct = sub.limit.utilizationPct
                      const barColor =
                        sub.limit.status === 'rejected'
                          ? 'bg-red-500'
                          : sub.limit.status === 'warning'
                            ? 'bg-amber-500'
                            : 'bg-emerald-500'

                      return (
                        <div
                          key={sub.id}
                          className={cx(
                            'rounded-xl border p-2.5 transition-all',
                            locked
                              ? 'border-white/[0.05] bg-black/25 opacity-55'
                              : sub.id === selectedCli
                                ? 'border-white/[0.16] bg-white/[0.04]'
                                : 'border-white/[0.08] bg-white/[0.02]'
                          )}
                        >
                          {/* Subscription Header + Live Limit Bar */}
                          <div className="mb-1.5 flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <CliAvatar cli={sub.id} size={18} />
                              <div>
                                <div className="flex items-center gap-1.5">
                                  <span className="text-[13px] font-semibold text-white">{sub.name}</span>
                                  <span className="rounded-full border border-white/[0.1] bg-white/[0.05] px-1.5 py-0.2 text-[10px] text-zinc-300">
                                    {sub.planLabel}
                                  </span>
                                </div>
                                <p className="text-[11px] text-zinc-400">{sub.statusReason}</p>
                              </div>
                            </div>

                            {locked ? (
                              <button
                                type="button"
                                onClick={() => {
                                  setOpenMenu(null)
                                  onAuthenticateCli(sub)
                                }}
                                className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-lg border border-amber-400/30 bg-amber-500/15 px-2.5 py-1 text-[11.5px] font-medium text-amber-300 hover:bg-amber-500/25"
                              >
                                <Terminal size={11} /> Sign In
                              </button>
                            ) : (
                              <div className="text-right">
                                <span
                                  className={cx(
                                    'text-[11.5px] font-semibold tabular-nums',
                                    sub.limit.status === 'rejected'
                                      ? 'text-red-400'
                                      : sub.limit.status === 'warning'
                                        ? 'text-amber-400'
                                        : 'text-emerald-400'
                                  )}
                                >
                                  {pct}% used
                                </span>
                                <span className="block text-[10.5px] text-zinc-500">{sub.limit.resetInLabel}</span>
                              </div>
                            )}
                          </div>

                          {/* Live 5-Hour Window Progress Bar */}
                          {!locked && (
                            <div className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.07]">
                              <div className={cx('h-full rounded-full transition-all', barColor)} style={{ width: `${Math.max(4, pct)}%` }} />
                            </div>
                          )}

                          {/* Models List (Greyed out & disabled if subscription is not authenticated!) */}
                          <div className="space-y-0.5">
                            {sub.models.map((m) => {
                              const isSelected = sub.id === selectedCli && m.id === selectedModel
                              return (
                                <button
                                  key={m.id}
                                  type="button"
                                  disabled={locked}
                                  onClick={() => {
                                    if (locked) return
                                    onSelectCliModel(sub.id, m.id)
                                    setOpenMenu(null)
                                  }}
                                  title={
                                    locked
                                      ? `${sub.name} subscription is not authenticated. Click Sign In above to enable.`
                                      : m.description
                                  }
                                  className={cx(
                                    'flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors',
                                    locked
                                      ? 'cursor-not-allowed text-zinc-500'
                                      : isSelected
                                        ? 'cursor-pointer bg-indigo-500/20 font-medium text-white'
                                        : 'cursor-pointer text-zinc-200 hover:bg-white/[0.07]'
                                  )}
                                >
                                  <div className="flex items-center gap-2 truncate">
                                    {locked && <Lock size={11} className="shrink-0 text-zinc-500" />}
                                    <span className="truncate">{m.name}</span>
                                    <span className="text-[11.5px] text-zinc-500">{m.tier}</span>
                                  </div>
                                  {isSelected && !locked && <Check size={13} className="shrink-0 text-indigo-400" />}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Right Controls: `🛡️ Default v`, `🎤`, and Orange Send Button `->` */}
          <div className="flex items-center gap-2">
            {/* Permission Mode Dropdown (`🛡️ Default v`) */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setOpenMenu(openMenu === 'mode' ? null : 'mode')}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1 text-[13px] text-zinc-400 transition-colors hover:bg-white/[0.07] hover:text-zinc-200"
              >
                <Shield size={13} className="text-zinc-400" />
                <span>{PERMISSION_MODES.find((x) => x.id === permissionMode)?.label ?? 'Default'}</span>
                <ChevronDown size={12} className="opacity-70" />
              </button>

              {openMenu === 'mode' && (
                <div className="absolute right-0 bottom-full z-50 mb-2 w-64 rounded-xl border border-white/[0.12] bg-[#181920] p-1.5 shadow-2xl">
                  <div className="px-2.5 py-1 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">
                    CLI Execution Mode
                  </div>
                  {PERMISSION_MODES.map((pm) => (
                    <button
                      key={pm.id}
                      type="button"
                      onClick={() => {
                        onChangePermissionMode(pm.id)
                        setOpenMenu(null)
                      }}
                      className={cx(
                        'flex w-full cursor-pointer items-start justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors',
                        pm.id === permissionMode ? 'bg-white/[0.09] text-white' : 'text-zinc-300 hover:bg-white/[0.05]'
                      )}
                    >
                      <div>
                        <div className="text-[12.5px] font-medium">{pm.label}</div>
                        <div className="text-[11px] text-zinc-500">{pm.desc}</div>
                      </div>
                      {pm.id === permissionMode && <Check size={13} className="mt-0.5 shrink-0 text-indigo-400" />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Voice Dictation (`🎤`) */}
            <button
              type="button"
              onClick={toggleDictation}
              title="Voice input"
              className={cx(
                'flex size-7 cursor-pointer items-center justify-center rounded-lg transition-colors',
                listening ? 'animate-pulse bg-red-500/20 text-red-400' : 'text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-200'
              )}
            >
              <Mic size={15} />
            </button>

            {/* Orange Circular Send / Stop Button (`->`) */}
            {isRunning ? (
              <button
                type="button"
                onClick={onStop}
                title="Stop current CLI run"
                className="flex size-8 cursor-pointer items-center justify-center rounded-full bg-red-500/90 text-white shadow-md transition-transform hover:scale-105 hover:bg-red-500"
              >
                <Square size={13} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                disabled={!text.trim() || Boolean(activeSub && !activeSub.authenticated)}
                onClick={handleSend}
                title={
                  activeSub && !activeSub.authenticated
                    ? `${activeSub.name} is not authenticated`
                    : submitMode === 'task'
                      ? 'Add to task queue'
                      : 'Send to CLI'
                }
                className="flex size-8 cursor-pointer items-center justify-center rounded-full bg-[#e89a6c] text-zinc-950 shadow-md transition-all hover:bg-[#f2a77b] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ArrowRight size={16} strokeWidth={2.2} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Bottom Strip below Composer Card — matches `💻 Local Checkout v` in the screenshot */}
      <div className="mt-2 flex items-center justify-between px-1.5 text-[12px] text-zinc-500">
        <div className="relative">
          <button
            type="button"
            onClick={() => setOpenMenu(openMenu === 'checkout' ? null : 'checkout')}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-0.5 text-zinc-400 transition-colors hover:bg-white/[0.05] hover:text-zinc-200"
          >
            {checkoutMode === 'local' ? <Monitor size={13} /> : <GitBranch size={13} className="text-emerald-400" />}
            <span>{checkoutMode === 'local' ? 'Local Checkout' : 'Isolated Git Worktree'}</span>
            <ChevronDown size={12} className="opacity-70" />
          </button>

          {openMenu === 'checkout' && (
            <div className="absolute bottom-full left-0 z-50 mb-1.5 w-72 rounded-xl border border-white/[0.12] bg-[#181920] p-1.5 shadow-2xl">
              <button
                type="button"
                onClick={() => {
                  onChangeCheckoutMode('local')
                  setOpenMenu(null)
                }}
                className={cx(
                  'flex w-full cursor-pointer items-start justify-between gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
                  checkoutMode === 'local' ? 'bg-white/[0.09] text-white' : 'text-zinc-300 hover:bg-white/[0.05]'
                )}
              >
                <div>
                  <div className="flex items-center gap-1.5 text-[12.5px] font-medium">
                    <Monitor size={13} /> Local Checkout
                  </div>
                  <div className="mt-0.5 text-[11px] text-zinc-400">
                    Works directly in {currentProject?.folder || 'the project folder'}
                  </div>
                </div>
                {checkoutMode === 'local' && <Check size={13} className="mt-0.5 shrink-0 text-indigo-400" />}
              </button>

              <button
                type="button"
                onClick={() => {
                  onChangeCheckoutMode('worktree')
                  setOpenMenu(null)
                }}
                className={cx(
                  'mt-0.5 flex w-full cursor-pointer items-start justify-between gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
                  checkoutMode === 'worktree' ? 'bg-white/[0.09] text-white' : 'text-zinc-300 hover:bg-white/[0.05]'
                )}
              >
                <div>
                  <div className="flex items-center gap-1.5 text-[12.5px] font-medium">
                    <GitBranch size={13} className="text-emerald-400" /> Isolated Git Worktree
                  </div>
                  <div className="mt-0.5 text-[11px] text-zinc-400">
                    Creates a separate branch & folder so your local copy stays untouched until you merge
                  </div>
                </div>
                {checkoutMode === 'worktree' && <Check size={13} className="mt-0.5 shrink-0 text-indigo-400" />}
              </button>
            </div>
          )}
        </div>

        {/* Live Subscription Status Indicator on the right side of the bottom strip */}
        {activeSub && (
          <div className="flex items-center gap-2 text-[11.5px]">
            <span className="flex items-center gap-1.5 text-zinc-400">
              <span
                className={cx(
                  'size-1.5 rounded-full',
                  !activeSub.authenticated
                    ? 'bg-zinc-600'
                    : activeSub.limit.status === 'rejected'
                      ? 'bg-red-500'
                      : activeSub.limit.status === 'warning'
                        ? 'bg-amber-500'
                        : 'bg-emerald-400'
                )}
              />
              <span>{activeSub.name}:</span>
              {activeSub.authenticated ? (
                <span className="font-medium text-zinc-300">
                  {activeSub.limit.utilizationPct}% of 5h limit · {activeSub.limit.resetInLabel}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onAuthenticateCli(activeSub)}
                  className="cursor-pointer text-amber-400 underline hover:text-amber-300"
                >
                  Not authenticated — click to sign in
                </button>
              )}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
