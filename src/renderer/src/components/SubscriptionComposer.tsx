import { useEffect, useRef, useState } from 'react'
import {
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  FileText,
  Folder,
  Gauge,
  GitBranch,
  Lock,
  Mic,
  Monitor,
  Plus,
  RefreshCw,
  Shield,
  Square,
  Columns2,
  Crosshair,
  ImageIcon,
  Terminal,
  Wand2,
  X
} from 'lucide-react'
import type {
  CheckoutMode,
  CliId,
  CliSubscriptionStatus,
  EffortLevel,
  KnowledgeEntry,
  MentionItem,
  PermissionMode,
  Project,
  SkillInfo
} from '@shared/types'
import { api, toast } from '../lib/api'
import { CliAvatar } from './CliAvatars'
import { cx } from './ui'

/** Anything in the app (e.g. the browser preview's element picker) can attach to the visible composer. */
export const attachToComposer = (m: MentionItem): void => {
  window.dispatchEvent(new CustomEvent('aihub-attach', { detail: m }))
}

const fmtTok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n))

interface SubscriptionComposerProps {
  projects: Project[]
  currentProject: Project | undefined
  onSelectProject: (id: number) => void
  onNewProject: () => void
  clis: CliSubscriptionStatus[]
  selectedCli: CliId
  selectedModel: string
  selectedEffort: EffortLevel
  onSelectCliModel: (cli: CliId, model: string) => void
  onChangeEffort: (effort: EffortLevel) => void
  permissionMode: PermissionMode
  onChangePermissionMode: (m: PermissionMode) => void
  checkoutMode: CheckoutMode
  onChangeCheckoutMode: (c: CheckoutMode) => void
  projectFiles: string[]
  knowledgeEntries: KnowledgeEntry[]
  skills?: SkillInfo[]
  onOpenKnowledgeBase: () => void
  onAuthenticateCli: (cli: CliSubscriptionStatus) => void
  onRefreshClis: () => void
  isRunning?: boolean
  onStop?: () => void
  placeholder?: string
  submitMode?: 'thread' | 'task'
  onChangeSubmitMode?: (m: 'thread' | 'task') => void
  onSubmit: (prompt: string, mentions: MentionItem[], mode: 'thread' | 'task') => Promise<void>
  /** Live token estimate for what Send will transmit */
  estimateTaskId?: number | null
  /** Optional second AI to run the same prompt against (compare mode) */
  compareWith?: { cli: CliId; model: string } | null
  onChangeCompareWith?: (v: { cli: CliId; model: string } | null) => void
}

const PERMISSION_MODES: { id: PermissionMode; label: string; desc: string }[] = [
  { id: 'default', label: 'Default', desc: 'Standard safe tool execution & file edits' },
  { id: 'accept-edits', label: 'Accept Edits', desc: 'Automatically apply file edits without prompting' },
  { id: 'bypass', label: 'Full Auto', desc: 'Bypass permission prompts for unattended runs' },
  { id: 'plan', label: 'Plan Only', desc: 'Read & design a plan without modifying files' }
]

export const EFFORT_META: Record<EffortLevel, { label: string; short: string; desc: string }> = {
  low: { label: 'Low', short: 'Low', desc: 'Fastest responses · minimal thinking tokens & lowest quota usage' },
  medium: { label: 'Medium', short: 'Medium', desc: 'Balanced reasoning depth and speed (Recommended for everyday work)' },
  high: { label: 'High', short: 'High', desc: 'Deep multi-step reasoning for complex architecture & debugging' },
  xhigh: { label: 'Extra High', short: 'Extra', desc: 'Extended thinking budget for hard engineering problems' },
  max: { label: 'Max', short: 'Max', desc: 'Maximum reasoning effort · consumes significantly more 5h quota' }
}

interface FixedMenuPos {
  left: number
  top?: number
  bottom?: number
  maxHeight: number
}

function calcFixedMenuPos(el: HTMLElement | null, menuWidth: number, preferredHeight = 360, alignRight = false): FixedMenuPos {
  if (!el) return { left: 24, top: 100, maxHeight: 340 }
  const r = el.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight
  const spaceBelow = vh - r.bottom - 16
  const spaceAbove = r.top - 48

  let left = alignRight ? r.right - menuWidth : r.left
  if (left + menuWidth > vw - 16) left = vw - menuWidth - 16
  if (left < 16) left = 16

  if (spaceBelow >= Math.min(preferredHeight, 280) || spaceBelow >= spaceAbove) {
    return {
      left,
      top: r.bottom + 8,
      maxHeight: Math.max(200, Math.min(preferredHeight, spaceBelow))
    }
  }
  return {
    left,
    bottom: vh - r.top + 8,
    maxHeight: Math.max(200, Math.min(preferredHeight, spaceAbove))
  }
}

export function SubscriptionComposer({
  projects,
  currentProject,
  onSelectProject,
  onNewProject,
  clis,
  selectedCli,
  selectedModel,
  selectedEffort,
  onSelectCliModel,
  onChangeEffort,
  permissionMode,
  onChangePermissionMode,
  checkoutMode,
  onChangeCheckoutMode,
  projectFiles,
  knowledgeEntries,
  skills = [],
  onOpenKnowledgeBase,
  onAuthenticateCli,
  onRefreshClis,
  isRunning,
  onStop,
  placeholder = 'Ask anything, build a feature, or queue a task across your subscriptions…',
  submitMode = 'thread',
  onChangeSubmitMode,
  onSubmit,
  estimateTaskId,
  compareWith,
  onChangeCompareWith
}: SubscriptionComposerProps): React.JSX.Element {
  const [text, setText] = useState('')
  const [mentions, setMentions] = useState<MentionItem[]>([])
  const [openMenu, setOpenMenu] = useState<'project' | 'model' | 'effort' | 'mode' | 'checkout' | 'attach' | 'skill' | null>(null)
  const [skillQuery, setSkillQuery] = useState('')
  const [menuPos, setMenuPos] = useState<FixedMenuPos>({ left: 0, top: 0, maxHeight: 340 })
  const [previewCliId, setPreviewCliId] = useState<CliId>(selectedCli)
  const [fileFilter, setFileFilter] = useState('')
  const [listening, setListening] = useState(false)
  const [estimate, setEstimate] = useState<{ tokens: number; contextTokens: number; continuing: boolean } | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const containerRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const projectBtnRef = useRef<HTMLButtonElement>(null)
  const attachBtnRef = useRef<HTMLButtonElement>(null)
  const modelBtnRef = useRef<HTMLButtonElement>(null)
  const effortBtnRef = useRef<HTMLButtonElement>(null)
  const modeBtnRef = useRef<HTMLButtonElement>(null)
  const checkoutBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    setPreviewCliId(selectedCli)
  }, [selectedCli])

  useEffect(() => {
    const onAttach = (e: Event): void => {
      const m = (e as CustomEvent<MentionItem>).detail
      if (m) setMentions((prev) => (prev.some((x) => x.type === m.type && x.value === m.value) ? prev : [...prev, m]))
    }
    window.addEventListener('aihub-attach', onAttach)
    return () => window.removeEventListener('aihub-attach', onAttach)
  }, [])

  // Debounced estimate of the tokens Send will cost (context + mentions + text)
  useEffect(() => {
    if (!currentProject || (!text.trim() && !mentions.length)) {
      setEstimate(null)
      return
    }
    const timer = setTimeout(() => {
      api.projects
        .estimate({ projectId: currentProject.id, taskId: estimateTaskId ?? null, cli: selectedCli, prompt: text || ' ', mentions })
        .then(setEstimate)
        .catch(() => setEstimate(null))
    }, 450)
    return () => clearTimeout(timer)
  }, [text, mentions, selectedCli, currentProject, estimateTaskId])

  const attachFiles = async (files: File[]): Promise<void> => {
    for (const f of files) {
      const path = window.aihub?.pathForFile(f) ?? ''
      if (f.type.startsWith('image/')) {
        let saved = path
        if (!saved) {
          const dataUrl = await new Promise<string>((res) => {
            const r = new FileReader()
            r.onload = () => res(String(r.result))
            r.readAsDataURL(f)
          })
          saved = (await api.attachments.saveImage(dataUrl, f.name || 'pasted').catch((e: Error) => (toast(e.message, true), ''))) || ''
        }
        if (saved) addMention({ type: 'image', label: f.name || 'image', value: saved })
      } else if (path) {
        addMention({ type: 'file', label: f.name, value: path })
      }
    }
  }

  useEffect(() => {
    const onClickOutside = (e: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpenMenu(null)
      }
    }
    const onResize = (): void => setOpenMenu(null)
    window.addEventListener('mousedown', onClickOutside)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('mousedown', onClickOutside)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  const toggleMenu = (
    which: 'project' | 'model' | 'effort' | 'mode' | 'checkout' | 'attach' | 'skill',
    btn: HTMLElement | null,
    width: number,
    height = 360,
    alignRight = false
  ): void => {
    if (openMenu === which) {
      setOpenMenu(null)
      return
    }
    setMenuPos(calcFixedMenuPos(btn, width, height, alignRight))
    if (which === 'model') setPreviewCliId(selectedCli)
    setOpenMenu(which)
  }

  const activeSub = clis.find((c) => c.id === selectedCli) ?? clis[0]
  const previewSub = clis.find((c) => c.id === previewCliId) ?? activeSub
  const activeModelObj =
    activeSub?.models.find((m) => m.id === selectedModel) ??
    activeSub?.models[0] ?? {
      id: selectedModel || 'gemini-4-argon',
      name: 'Gemini 4 Argon',
      tier: 'Flagship',
      cli: selectedCli,
      description: '',
      efforts: ['low', 'medium', 'high'] as EffortLevel[],
      defaultEffort: 'high' as EffortLevel
    }

  const availableEfforts: EffortLevel[] = activeModelObj.efforts?.length
    ? activeModelObj.efforts
    : ['low', 'medium', 'high']

  const effectiveEffort: EffortLevel = availableEfforts.includes(selectedEffort)
    ? selectedEffort
    : activeModelObj.defaultEffort || availableEfforts[availableEfforts.length - 1] || 'high'

  const pinnedKbCount = knowledgeEntries.filter((k) => k.pinned).length
  // Model-specific quota (Antigravity families, Claude Opus/Sonnet weekly) for the selected model
  // The tightest limit this model draws from (a model can sit in several: group 5h, group weekly, its own weekly)
  const activeBucket = (activeSub?.limit.modelBuckets ?? [])
    .filter(
      (b) =>
        b.modelIds.includes(activeModelObj.id) ||
        (!b.modelIds.length && b.window === '7d' && new RegExp(b.label.split(' ')[0], 'i').test(activeModelObj.id))
    )
    .sort((a, b) => b.utilizationPct - a.utilizationPct)[0]

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

  const filteredSkills = skills
    .filter((k) => !skillQuery || k.name.toLowerCase().includes(skillQuery.toLowerCase()))
    .slice(0, 30)

  const pickSkill = (k: SkillInfo): void => {
    if (/^\/[\w:.-]*$/.test(text)) setText('')
    addMention({ type: 'skill', label: k.name, value: k.path })
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
        <div className="flex items-center gap-2">
          <button
            ref={projectBtnRef}
            type="button"
            onClick={() => toggleMenu('project', projectBtnRef.current, 260, 300)}
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
        </div>

        {onChangeCompareWith && submitMode === 'thread' && (
          <label
            className={cx('chip ml-auto mr-2 h-6 gap-1 px-2 text-[11px]', compareWith && 'chip-active')}
            title="Run the same prompt on a second AI at the same time (each on its own branch) and compare"
          >
            <Columns2 size={11} />
            <select
              className="cursor-pointer bg-transparent text-[11px] outline-none"
              value={compareWith ? `${compareWith.cli}|${compareWith.model}` : ''}
              onChange={(e) => {
                const [c, m] = e.target.value.split('|')
                onChangeCompareWith(c ? { cli: c as CliId, model: m } : null)
              }}
            >
              <option value="">Compare with…</option>
              {clis
                .filter((c) => c.authenticated)
                .flatMap((c) =>
                  c.models.map((m) => (
                    <option key={`${c.id}|${m.id}`} value={`${c.id}|${m.id}`}>
                      {c.shortName} · {m.name}
                    </option>
                  ))
                )}
            </select>
          </label>
        )}

        {/* Switch between interactive thread & task queue */}
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
      <div
        className={cx('composer-box relative rounded-2xl px-4 pt-3.5 pb-2.5 transition-all', dragOver && 'ring-2 ring-indigo-400/60')}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault()
            setDragOver(true)
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          attachFiles([...e.dataTransfer.files])
        }}
      >
        {/* Mention Chips Row */}
        {mentions.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            {mentions.map((m, idx) => (
              <span
                key={`${m.type}-${m.value}`}
                className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.1] bg-white/[0.07] px-2 py-0.5 text-[12.5px] font-semibold text-zinc-100"
              >
                {m.type === 'kb' ? (
                  <BookOpen size={12} className="text-indigo-400" />
                ) : m.type === 'skill' ? (
                  <Wand2 size={12} className="text-amber-300" />
                ) : m.type === 'image' ? (
                  <ImageIcon size={12} className="text-sky-300" />
                ) : m.type === 'element' ? (
                  <Crosshair size={12} className="text-indigo-300" />
                ) : (
                  <FileText size={12} className="text-zinc-400" />
                )}
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
          onChange={(e) => {
            const v = e.target.value
            setText(v)
            // `/name` at the start of the prompt opens the skill picker
            const m = v.match(/^\/([\w:.-]*)$/)
            if (m && skills.length) {
              setSkillQuery(m[1])
              if (openMenu !== 'skill') {
                setMenuPos(calcFixedMenuPos(textareaRef.current, 360, 320))
                setOpenMenu('skill')
              }
            } else if (openMenu === 'skill') setOpenMenu(null)
          }}
          onKeyDown={(e) => {
            if (openMenu === 'skill' && (e.key === 'Enter' || e.key === 'Tab')) {
              const first = filteredSkills[0]
              if (first) {
                e.preventDefault()
                pickSkill(first)
                return
              }
            }
            if (e.key === 'Escape' && openMenu) {
              setOpenMenu(null)
              return
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSend()
            }
          }}
          onPaste={(e) => {
            const imgs = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
            if (imgs.length) {
              e.preventDefault()
              attachFiles(imgs)
            }
          }}
          placeholder={placeholder}
          className="w-full resize-none bg-transparent text-[14.5px] leading-relaxed text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
        />

        {/* Bottom Toolbar inside Composer Box */}
        <div className="mt-2 flex items-center justify-between gap-2 pt-1">
          {/* Left Controls: `+`, Model Selector (`Gemini 4 Argon v`), and Separate Effort Selector (`High v`) */}
          <div className="flex flex-wrap items-center gap-1">
            <button
              ref={attachBtnRef}
              type="button"
              onClick={() => toggleMenu('attach', attachBtnRef.current, 320, 340)}
              title="Reference a file, project, or Knowledge Base entry"
              className="flex size-7 cursor-pointer items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-white/[0.08] hover:text-zinc-200"
            >
              <Plus size={16} />
            </button>

            {/* 1. Subscription & Base Model Selector Button */}
            <button
              ref={modelBtnRef}
              type="button"
              onClick={() => toggleMenu('model', modelBtnRef.current, 520, 380)}
              title="Select AI Subscription & Model"
              className={cx(
                'inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[13.5px] transition-colors',
                openMenu === 'model'
                  ? 'border-amber-400/50 bg-white/[0.08]'
                  : 'border-transparent hover:bg-white/[0.07]'
              )}
            >
              <CliAvatar cli={selectedCli} size={15} />
              <span className="font-medium text-zinc-100">{activeModelObj.name}</span>
              <ChevronDown size={13} className="text-zinc-500" />
            </button>

            {/* 2. Separate Effort Level Selector Button */}
            <button
              ref={effortBtnRef}
              type="button"
              onClick={() => toggleMenu('effort', effortBtnRef.current, 270, 290)}
              title="Select Reasoning Effort Level (independent of model)"
              className={cx(
                'inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[13px] transition-colors',
                openMenu === 'effort'
                  ? 'border-indigo-400/50 bg-indigo-500/15 text-white'
                  : 'border-white/[0.07] bg-white/[0.03] text-zinc-300 hover:bg-white/[0.08] hover:text-white'
              )}
            >
              <Gauge size={13} className="text-indigo-400" />
              <span className="font-medium">{EFFORT_META[effectiveEffort]?.short ?? 'High'}</span>
              <ChevronDown size={12} className="text-zinc-500" />
            </button>
          </div>

          {/* Right Controls: `🛡️ Default v`, `🎤`, and Orange Send Button `->` */}
          <div className="flex items-center gap-2">
            <button
              ref={modeBtnRef}
              type="button"
              onClick={() => toggleMenu('mode', modeBtnRef.current, 260, 280, true)}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1 text-[13px] text-zinc-400 transition-colors hover:bg-white/[0.07] hover:text-zinc-200"
            >
              <Shield size={13} className="text-zinc-400" />
              <span>{PERMISSION_MODES.find((x) => x.id === permissionMode)?.label ?? 'Default'}</span>
              <ChevronDown size={12} className="opacity-70" />
            </button>

            {estimate && (
              <span
                className="font-mono text-[11px] text-zinc-500"
                title={
                  estimate.continuing
                    ? 'Continuing the same CLI session: only your message is sent (the CLI keeps earlier context).'
                    : `Includes ~${fmtTok(estimate.contextTokens)} tokens of project context (compact knowledge base). Each AI also adds its own system prompt.`
                }
              >
                ~{fmtTok(estimate.tokens * (compareWith ? 2 : 1))} tok
              </span>
            )}

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
                className="flex size-8 cursor-pointer items-center justify-center rounded-full bg-accent text-white shadow-[0_4px_14px_-2px_rgba(99,102,241,0.6)] transition-all hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ArrowRight size={16} strokeWidth={2.2} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Bottom Strip below Composer Card — matches `💻 Local Checkout v` in the screenshot */}
      <div className="mt-2 flex items-center justify-between px-1.5 text-[12px] text-zinc-500">
        <button
          ref={checkoutBtnRef}
          type="button"
          onClick={() => toggleMenu('checkout', checkoutBtnRef.current, 290, 220)}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-0.5 text-zinc-400 transition-colors hover:bg-white/[0.05] hover:text-zinc-200"
        >
          {checkoutMode === 'local' ? <Monitor size={13} /> : <GitBranch size={13} className="text-emerald-400" />}
          <span>{checkoutMode === 'local' ? 'Local Checkout' : 'Isolated Git Worktree'}</span>
          <ChevronDown size={12} className="opacity-70" />
        </button>

        {/* Live Subscription Status Indicator on the right side of the bottom strip */}
        {activeSub && (
          <div className="flex items-center gap-2 text-[11.5px]">
            <span className="flex items-center gap-1.5 text-zinc-400">
              <span
                className={cx(
                  'size-1.5 rounded-full',
                  !activeSub.authenticated
                    ? 'bg-zinc-600'
                    : (activeBucket?.status ?? activeSub.limit.status) === 'rejected'
                      ? 'bg-red-500'
                      : (activeBucket?.status ?? activeSub.limit.status) === 'warning'
                        ? 'bg-amber-500'
                        : 'bg-emerald-400'
                )}
              />
              <span>{activeSub.name}:</span>
              {activeSub.authenticated ? (
                <span className="font-medium text-zinc-300">
                  {activeBucket
                    ? `${activeBucket.label}: ${100 - activeBucket.utilizationPct}% left${activeBucket.source === 'estimated' ? ' (est.)' : ''}`
                    : `${activeSub.limit.utilizationPct}% (5h)${activeSub.limit.weeklyUtilizationPct != null ? ` · ${activeSub.limit.weeklyUtilizationPct}% (7d)` : ''}`}{' '}
                  · {activeBucket?.resetInLabel ?? activeSub.limit.resetInLabel}
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

      {/* =====================================================================
          FIXED VIEWPORT POPOVERS (Never clipped by parent overflow containers!)
         ===================================================================== */}

      {/* 1. 2-Pane Split Subscription & Base Model Selector Popover */}
      {openMenu === 'model' && previewSub && (
        <div
          style={{
            position: 'fixed',
            left: menuPos.left,
            top: menuPos.top,
            bottom: menuPos.bottom,
            maxHeight: menuPos.maxHeight,
            width: 520
          }}
          className="glass-float pop-in z-[100] flex overflow-hidden rounded-2xl"
        >
          {/* Left Pane: AI Subscriptions List */}
          <div className="flex w-[205px] shrink-0 flex-col justify-between border-r border-white/[0.08] bg-black/20 p-2">
            <div className="space-y-1">
              <div className="flex items-center justify-between px-2 py-1">
                <span className="text-[10.5px] font-semibold tracking-wider text-zinc-500 uppercase">Subscriptions</span>
                <button
                  type="button"
                  onClick={() => onRefreshClis()}
                  title="Refresh live usage & auth status"
                  className="cursor-pointer rounded p-1 text-zinc-400 hover:bg-white/[0.08] hover:text-white"
                >
                  <RefreshCw size={11} />
                </button>
              </div>

              {clis.map((sub) => {
                const isPreview = sub.id === previewSub.id
                const locked = !sub.authenticated
                const pct = sub.limit.utilizationPct
                return (
                  <button
                    key={sub.id}
                    type="button"
                    onMouseEnter={() => setPreviewCliId(sub.id)}
                    onClick={() => setPreviewCliId(sub.id)}
                    className={cx(
                      'flex w-full cursor-pointer flex-col gap-1 rounded-xl px-2.5 py-2 text-left transition-all',
                      isPreview ? 'bg-white/[0.09] text-white' : 'text-zinc-300 hover:bg-white/[0.04]',
                      locked && 'opacity-55'
                    )}
                  >
                    <div className="flex items-center justify-between gap-1.5">
                      <span className="flex items-center gap-2 truncate text-[12.5px] font-medium">
                        <CliAvatar cli={sub.id} size={15} />
                        <span className="truncate">{sub.shortName}</span>
                      </span>
                      {locked ? (
                        <Lock size={11} className="shrink-0 text-zinc-500" />
                      ) : (
                        <span
                          className={cx(
                            'font-mono text-[11px] font-semibold',
                            sub.limit.status === 'rejected'
                              ? 'text-red-400'
                              : sub.limit.status === 'warning'
                                ? 'text-amber-400'
                                : 'text-emerald-400'
                          )}
                        >
                          {pct}%
                        </span>
                      )}
                    </div>

                    {!locked ? (
                      <div className="h-1 w-full overflow-hidden rounded-full bg-white/[0.08]">
                        <div
                          className={cx(
                            'h-full rounded-full',
                            sub.limit.status === 'rejected'
                              ? 'bg-red-500'
                              : sub.limit.status === 'warning'
                                ? 'bg-amber-500'
                                : 'bg-emerald-500'
                          )}
                          style={{ width: `${Math.max(4, pct)}%` }}
                        />
                      </div>
                    ) : (
                      <span className="text-[10px] text-zinc-500">Not signed in</span>
                    )}
                  </button>
                )
              })}
            </div>

            <div className="border-t border-white/[0.07] px-2 pt-2 text-[10.5px] text-zinc-500">
              Unauthenticated subscriptions are greyed out until signed in.
            </div>
          </div>

          {/* Right Pane: Base Models & Live Quota for Selected Subscription */}
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {/* Subscription Live Quota Header */}
            <div className="border-b border-white/[0.08] bg-white/[0.02] px-3.5 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[13px] font-semibold text-white">{previewSub.name}</span>
                    <span className="rounded-full border border-white/[0.1] bg-white/[0.05] px-1.5 py-0.2 text-[10px] text-zinc-300">
                      {previewSub.planLabel}
                    </span>
                  </div>
                  <p className="truncate text-[11px] text-zinc-400">
                    {previewSub.authenticated ? previewSub.accountLabel : previewSub.statusReason}
                  </p>
                </div>

                {!previewSub.authenticated ? (
                  <button
                    type="button"
                    onClick={() => {
                      setOpenMenu(null)
                      onAuthenticateCli(previewSub)
                    }}
                    className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-lg border border-amber-400/35 bg-amber-500/15 px-2.5 py-1 text-[11.5px] font-medium text-amber-300 hover:bg-amber-500/25"
                  >
                    <Terminal size={11} /> Sign In
                  </button>
                ) : (
                  <div className="shrink-0 text-right">
                    <span className="text-[11.5px] font-semibold text-emerald-400">
                      {previewSub.limit.utilizationPct}% of 5h
                    </span>
                    {previewSub.limit.weeklyUtilizationPct != null && (
                      <span className="ml-1.5 text-[11px] text-zinc-400">
                        · {previewSub.limit.weeklyUtilizationPct}% of 7d
                      </span>
                    )}
                    <span className="block text-[10.5px] text-zinc-500">{previewSub.limit.resetInLabel}</span>
                  </div>
                )}
              </div>

              {previewSub.authenticated && (
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.08]">
                  <div
                    className={cx(
                      'h-full rounded-full transition-all',
                      previewSub.limit.status === 'rejected'
                        ? 'bg-red-500'
                        : previewSub.limit.status === 'warning'
                          ? 'bg-amber-500'
                          : 'bg-emerald-500'
                    )}
                    style={{ width: `${Math.max(4, previewSub.limit.utilizationPct)}%` }}
                  />
                </div>
              )}
            </div>

            {/* Scrollable Deduplicated Base Models List */}
            <div className="flex-1 space-y-0.5 overflow-y-auto p-2">
              {previewSub.models.map((m) => {
                const locked = !previewSub.authenticated
                const isSelected = previewSub.id === selectedCli && m.id === selectedModel
                return (
                  <button
                    key={m.id}
                    type="button"
                    disabled={locked}
                    onClick={() => {
                      if (locked) return
                      onSelectCliModel(previewSub.id, m.id)
                      if (m.efforts?.length && !m.efforts.includes(selectedEffort)) {
                        onChangeEffort(m.defaultEffort || m.efforts[m.efforts.length - 1])
                      }
                      setOpenMenu(null)
                    }}
                    className={cx(
                      'flex w-full items-center justify-between gap-2 rounded-xl px-2.5 py-2 text-left transition-colors',
                      locked
                        ? 'cursor-not-allowed opacity-40'
                        : isSelected
                          ? 'cursor-pointer bg-indigo-500/20 text-white'
                          : 'cursor-pointer text-zinc-200 hover:bg-white/[0.07]'
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        {locked && <Lock size={11} className="shrink-0 text-zinc-500" />}
                        <span className="truncate text-[13px] font-medium">{m.name}</span>
                        {m.tier && (
                          <span className="rounded bg-white/[0.07] px-1.5 py-0.2 text-[10px] text-zinc-400">
                            {m.tier}
                          </span>
                        )}
                      </div>
                      {m.description && (
                        <p className="mt-0.5 truncate text-[11px] text-zinc-500">{m.description}</p>
                      )}
                    </div>
                    {(() => {
                      const tight = (previewSub.limit.modelBuckets ?? [])
                        .filter((b) => b.modelIds.includes(m.id))
                        .sort((a, b) => b.utilizationPct - a.utilizationPct)[0]
                      if (!tight || locked) return null
                      const left = 100 - tight.utilizationPct
                      return (
                        <span
                          title={`${tight.label} · ${tight.resetInLabel}`}
                          className={cx(
                            'shrink-0 rounded-full px-1.5 py-0.2 font-mono text-[10px]',
                            left <= 0 ? 'bg-red-500/20 text-red-300' : left <= 20 ? 'bg-amber-500/20 text-amber-300' : 'bg-white/[0.07] text-zinc-400'
                          )}
                        >
                          {left}% left
                        </span>
                      )
                    })()}
                    {isSelected && !locked && <Check size={14} className="shrink-0 text-indigo-400" />}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* 2. Separate Effort Level Selector Popover */}
      {openMenu === 'effort' && (
        <div
          style={{
            position: 'fixed',
            left: menuPos.left,
            top: menuPos.top,
            bottom: menuPos.bottom,
            maxHeight: menuPos.maxHeight,
            width: 280
          }}
          className="glass-float pop-in z-[100] overflow-y-auto rounded-xl p-2"
        >
          <div className="mb-1 flex items-center justify-between px-2 py-0.5">
            <span className="text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">
              Reasoning Effort Level
            </span>
            <span className="text-[10.5px] text-zinc-500">{activeModelObj.name}</span>
          </div>
          <div className="space-y-0.5">
            {availableEfforts.map((ef) => {
              const info = EFFORT_META[ef]
              const isSelected = ef === effectiveEffort
              const isDefault = ef === activeModelObj.defaultEffort
              return (
                <button
                  key={ef}
                  type="button"
                  onClick={() => {
                    onChangeEffort(ef)
                    setOpenMenu(null)
                  }}
                  className={cx(
                    'flex w-full cursor-pointer items-start justify-between gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
                    isSelected ? 'bg-indigo-500/20 text-white' : 'text-zinc-300 hover:bg-white/[0.06]'
                  )}
                >
                  <div>
                    <div className="flex items-center gap-1.5 text-[13px] font-medium">
                      <span>{info.label}</span>
                      {isDefault && (
                        <span className="rounded bg-white/[0.08] px-1.5 py-0.2 text-[10px] font-normal text-zinc-400">
                           Default
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-[11px] leading-snug text-zinc-500">{info.desc}</div>
                  </div>
                  {isSelected && <Check size={14} className="mt-0.5 shrink-0 text-indigo-400" />}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* 3. Project Selector Popover */}
      {openMenu === 'project' && (
        <div
          style={{
            position: 'fixed',
            left: menuPos.left,
            top: menuPos.top,
            bottom: menuPos.bottom,
            maxHeight: menuPos.maxHeight,
            width: 260
          }}
          className="glass-float pop-in z-[100] overflow-y-auto rounded-xl p-1.5"
        >
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

      {/* 4. Attach / Reference Popover */}
      {openMenu === 'attach' && (
        <div
          style={{
            position: 'fixed',
            left: menuPos.left,
            top: menuPos.top,
            bottom: menuPos.bottom,
            maxHeight: menuPos.maxHeight,
            width: 320
          }}
          className="glass-float pop-in z-[100] overflow-y-auto rounded-xl p-2"
        >
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

          {skills.length > 0 && (
            <>
              <div className="my-1.5 border-t border-white/[0.08]" />
              <div className="eyebrow mb-1 flex items-center justify-between px-2">
                <span>Skills</span>
                <span className="font-normal tracking-normal text-zinc-500 normal-case">
                  or type <span className="kbd">/</span>
                </span>
              </div>
              <div className="max-h-32 space-y-0.5 overflow-y-auto">
                {skills.slice(0, 40).map((k) => (
                  <button
                    key={`skill-${k.path}`}
                    type="button"
                    onClick={() => pickSkill(k)}
                    title={k.description}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-left text-[12.5px] text-zinc-200 hover:bg-white/[0.07]"
                  >
                    <Wand2 size={12} className="shrink-0 text-amber-300" />
                    <span className="truncate font-medium">{k.name}</span>
                    {k.native.includes(selectedCli) && (
                      <span className="ml-auto shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.2 text-[10px] text-emerald-300">native</span>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}

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

      {/* Slash-command skill picker */}
      {openMenu === 'skill' && (
        <div
          style={{ position: 'fixed', left: menuPos.left, top: menuPos.top, bottom: menuPos.bottom, maxHeight: menuPos.maxHeight, width: 360 }}
          className="glass-float pop-in z-[100] overflow-y-auto rounded-xl p-1.5"
        >
          <div className="eyebrow flex items-center justify-between px-2.5 py-1">
            <span>Skills</span>
            <span className="font-normal tracking-normal text-zinc-500 normal-case">
              <span className="kbd">Enter</span> to add
            </span>
          </div>
          {filteredSkills.length === 0 ? (
            <p className="muted px-2.5 py-2 text-[12px]">No skill matches "{skillQuery}".</p>
          ) : (
            filteredSkills.map((k, i) => (
              <button
                key={k.path}
                type="button"
                onClick={() => pickSkill(k)}
                className={cx(
                  'flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-white/[0.07]',
                  i === 0 && 'bg-white/[0.06]'
                )}
              >
                <span className="flex w-full items-center gap-2 text-[13px] font-medium text-zinc-100">
                  <Wand2 size={12} className="shrink-0 text-amber-300" />/{k.name}
                  <span className="ml-auto text-[10px] font-normal text-zinc-500">
                    {k.scope === 'project' ? 'project' : k.native.includes(selectedCli) ? 'native' : 'via SKILL.md'}
                  </span>
                </span>
                {k.description && <span className="line-clamp-1 text-[11px] text-zinc-500">{k.description}</span>}
              </button>
            ))
          )}
        </div>
      )}

      {/* 5. Permission Mode Popover */}
      {openMenu === 'mode' && (
        <div
          style={{
            position: 'fixed',
            left: menuPos.left,
            top: menuPos.top,
            bottom: menuPos.bottom,
            maxHeight: menuPos.maxHeight,
            width: 260
          }}
          className="glass-float pop-in z-[100] overflow-y-auto rounded-xl p-1.5"
        >
          <div className="px-2.5 py-1 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">Permission Mode</div>
          {PERMISSION_MODES.map((pm) => (
            <button
              key={pm.id}
              type="button"
              onClick={() => {
                onChangePermissionMode(pm.id)
                setOpenMenu(null)
              }}
              className={cx(
                'flex w-full cursor-pointer items-start justify-between gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
                pm.id === permissionMode ? 'bg-white/[0.09] text-white' : 'text-zinc-300 hover:bg-white/[0.05]'
              )}
            >
              <div>
                <div className="text-[13px] font-medium">{pm.label}</div>
                <div className="muted text-[11px]">{pm.desc}</div>
              </div>
              {pm.id === permissionMode && <Check size={14} className="mt-0.5 shrink-0 text-indigo-400" />}
            </button>
          ))}
        </div>
      )}

      {/* 6. Checkout / Worktree Selector Popover */}
      {openMenu === 'checkout' && (
        <div
          style={{
            position: 'fixed',
            left: menuPos.left,
            top: menuPos.top,
            bottom: menuPos.bottom,
            maxHeight: menuPos.maxHeight,
            width: 290
          }}
          className="glass-float pop-in z-[100] overflow-y-auto rounded-xl p-1.5"
        >
          <div className="px-2.5 py-1 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">Workspace Target</div>
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
              <div className="flex items-center gap-1.5 text-[13px] font-medium">
                <Monitor size={13} /> Local Checkout
              </div>
              <div className="muted mt-0.5 text-[11px]">Run directly in the project folder for instant live edits</div>
            </div>
            {checkoutMode === 'local' && <Check size={14} className="mt-0.5 shrink-0 text-indigo-400" />}
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
              <div className="flex items-center gap-1.5 text-[13px] font-medium">
                <GitBranch size={13} className="text-emerald-400" /> Isolated Git Worktree
              </div>
              <div className="muted mt-0.5 text-[11px]">
                Creates a dedicated branch &amp; worktree so your main checkout stays untouched until you merge
              </div>
            </div>
            {checkoutMode === 'worktree' && <Check size={14} className="mt-0.5 shrink-0 text-indigo-400" />}
          </button>
        </div>
      )}
    </div>
  )
}
