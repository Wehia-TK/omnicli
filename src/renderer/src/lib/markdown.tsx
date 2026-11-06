import type { ReactNode } from 'react'
import { api } from './api'

type Opts = {
  onToggle?: (line: number, done: boolean) => void
  onLink?: (href: string) => void
}

function inline(text: string, key: string, o: Opts): ReactNode[] {
  const out: ReactNode[] = []
  const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|(https?:\/\/[^\s<]+)/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const k = `${key}-${i++}`
    if (m[2] || m[6]) {
      const href = m[2] ?? m[6]
      out.push(
        <a
          key={k}
          href={href}
          className="text-indigo-400 underline hover:text-indigo-300"
          onClick={(e) => {
            e.preventDefault()
            if (o.onLink) o.onLink(href)
            else void api.app.openExternal(href).catch(() => undefined)
          }}
        >
          {m[1] ?? href}
        </a>
      )
    } else if (m[3]) {
      out.push(
        <code key={k} className="rounded border border-white/[0.08] bg-white/[0.06] px-1.5 py-0.5 font-mono text-[0.9em] text-amber-200/90">
          {m[3]}
        </code>
      )
    } else if (m[4]) out.push(<strong key={k} className="font-semibold text-white">{m[4]}</strong>)
    else if (m[5]) out.push(<em key={k}>{m[5]}</em>)
    last = re.lastIndex
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function Markdown({ text, ...o }: { text: string } & Opts): React.JSX.Element {
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const k = `b${i}`
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim()
      const code: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++])
      i++
      blocks.push(
        <div key={k} className="my-2.5 overflow-hidden rounded-lg border border-white/[0.08] bg-black/45">
          {lang && <div className="border-b border-white/[0.06] bg-white/[0.03] px-3 py-1 font-mono text-[11px] text-zinc-400">{lang}</div>}
          <pre className="overflow-x-auto px-3 py-2.5 font-mono text-[12px] text-zinc-200">{code.join('\n')}</pre>
        </div>
      )
      continue
    }
    const h = line.match(/^(#{1,3}) (.*)$/)
    if (h) {
      const size = ['text-[18px] mt-3', 'text-[15.5px] mt-2.5', 'text-[14px] mt-2'][h[1].length - 1]
      blocks.push(
        <p key={k} className={`${size} mb-1 font-semibold tracking-tight text-white`}>
          {inline(h[2], k, o)}
        </p>
      )
    } else if (/^- \[( |x|X)\] /.test(line)) {
      const done = line[3] !== ' '
      const at = i
      blocks.push(
        <label key={k} className="flex cursor-pointer items-start gap-2 py-0.5">
          <input type="checkbox" className="mt-1 accent-indigo-500" checked={done} onChange={() => o.onToggle?.(at, !done)} />
          <span className={done ? 'text-zinc-500 line-through' : ''}>{inline(line.slice(6), k, o)}</span>
        </label>
      )
    } else if (/^[-*] /.test(line)) {
      blocks.push(
        <p key={k} className="flex gap-2 py-0.5 pl-1">
          <span className="mt-[8px] size-1.5 shrink-0 rounded-full bg-zinc-500" />
          <span>{inline(line.slice(2), k, o)}</span>
        </p>
      )
    } else if (/^\d+[.)] /.test(line)) {
      const n = line.match(/^(\d+)/)![1]
      blocks.push(
        <p key={k} className="flex gap-2 py-0.5">
          <span className="w-5 shrink-0 text-right text-zinc-500 tabular-nums">{n}.</span>
          <span>{inline(line.replace(/^\d+[.)] /, ''), k, o)}</span>
        </p>
      )
    } else if (line.startsWith('> ')) {
      blocks.push(
        <p key={k} className="my-1 border-l-2 border-indigo-500/50 pl-3 text-zinc-300">
          {inline(line.slice(2), k, o)}
        </p>
      )
    } else if (/^-{3,}$/.test(line.trim())) {
      blocks.push(<hr key={k} className="my-3 border-white/[0.08]" />)
    } else if (!line.trim()) {
      blocks.push(<div key={k} className="h-2" />)
    } else {
      blocks.push(
        <p key={k} className="py-0.5">
          {inline(line, k, o)}
        </p>
      )
    }
    i++
  }
  return <div className="selectable text-[13.5px] leading-relaxed text-zinc-200">{blocks}</div>
}
