import { useEffect, useId, useState } from 'react'
import type { CliId } from '@shared/types'

function ClaudeAvatar({ size }: { size: number }): React.JSX.Element {
  return (
    <svg className="claude-avatar shrink-0" role="img" aria-label="Claude Code" width={size} height={(size * 3) / 4} viewBox="0 -1 16 12" shapeRendering="crispEdges">
      <g fill="#b85c3e">
        <rect className="claude-leg-a" x="3" y="7" width="1" height="4" />
        <rect className="claude-leg-b" x="5" y="7" width="1" height="4" />
        <rect className="claude-leg-b" x="10" y="7" width="1" height="4" />
        <rect className="claude-leg-a" x="12" y="7" width="1" height="4" />
      </g>
      <g className="claude-body">
        <rect x="2" y="1" width="12" height="7" fill="#d97757" />
        <rect x="0" y="3" width="2" height="2" fill="#d97757" />
        <rect x="14" y="3" width="2" height="2" fill="#d97757" />
        <g className="claude-eyes" fill="#2b1a14">
          <rect x="4" y="3" width="1" height="2" />
          <rect x="11" y="3" width="1" height="2" />
        </g>
      </g>
    </svg>
  )
}

function AgyAvatar({ size }: { size: number }): React.JSX.Element {
  const id = useId()
  return (
    <svg className="agy-avatar shrink-0" role="img" aria-label="Antigravity" width={size} height={size} viewBox="0 0 24 24">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#38bdf8" />
          <stop offset="1" stopColor="#8b5cf6" />
        </linearGradient>
      </defs>
      <g className="agy-float">
        <circle cx="12" cy="11" r="6" fill={`url(#${id})`} />
        <g fill="#fff">
          <circle cx="9.8" cy="10.5" r="1" />
          <circle cx="14.2" cy="10.5" r="1" />
        </g>
        <g transform="translate(12 11) rotate(-20) scale(1 .35)">
          <circle r="10" fill="none" stroke="#38bdf8" strokeOpacity=".55" strokeWidth="1.5" />
          <g className="agy-orbit">
            <circle cx="10" cy="0" r="2.2" fill="#38bdf8" />
          </g>
        </g>
      </g>
    </svg>
  )
}

function CodexAvatar({ size }: { size: number }): React.JSX.Element {
  return (
    <svg className="shrink-0" width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="3" y="3" width="18" height="18" rx="5" fill="#10b981" fillOpacity="0.18" stroke="#10b981" strokeWidth="1.6" />
      <path d="M8 9l3 3-3 3M13 15h3" stroke="#10b981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function GeminiAvatar({ size }: { size: number }): React.JSX.Element {
  const id = useId()
  return (
    <svg className="shrink-0" width={size} height={size} viewBox="0 0 24 24" fill="none">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#60a5fa" />
          <stop offset="1" stopColor="#c084fc" />
        </linearGradient>
      </defs>
      <path d="M12 2C12 7.5 16.5 12 22 12C16.5 12 12 16.5 12 22C12 16.5 7.5 12 2 12C7.5 12 12 7.5 12 2Z" fill={`url(#${id})`} />
    </svg>
  )
}

function CopilotAvatar({ size }: { size: number }): React.JSX.Element {
  return (
    <svg className="shrink-0" width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="3" y="5" width="18" height="14" rx="7" fill="#6366f1" fillOpacity="0.2" stroke="#818cf8" strokeWidth="1.6" />
      <circle cx="9.5" cy="12" r="1.5" fill="#818cf8" />
      <circle cx="14.5" cy="12" r="1.5" fill="#818cf8" />
    </svg>
  )
}

export function CliAvatar({ cli, size = 18 }: { cli: CliId; size?: number }): React.JSX.Element {
  if (cli === 'agy') return <AgyAvatar size={size} />
  if (cli === 'claude') return <ClaudeAvatar size={size} />
  if (cli === 'codex') return <CodexAvatar size={size} />
  if (cli === 'gemini') return <GeminiAvatar size={size} />
  return <CopilotAvatar size={size} />
}

const GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']

export function CliSpinner(): React.JSX.Element {
  const [i, setI] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % GLYPHS.length), 120)
    return () => clearInterval(t)
  }, [])
  return <span className="inline-block w-4 text-center text-[#e89a6c]">{GLYPHS[i]}</span>
}
