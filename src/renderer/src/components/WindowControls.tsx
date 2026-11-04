import { useEffect, useState } from 'react'
import { Minus, Square, X } from 'lucide-react'
import { api, isDesktop } from '../lib/api'

function RestoreIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M3.5 2.5V1.5H10.5V8.5H9.5" />
      <rect x="1.5" y="3.5" width="7" height="7" rx="0.5" />
    </svg>
  )
}

export function WindowControls(): React.JSX.Element | null {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!isDesktop) return
    api.window.isMaximized().then(setMaximized).catch(() => {})
    const unsub = window.aihub?.onWindowMaximizedChange?.((max) => {
      setMaximized(max)
    })
    return () => unsub?.()
  }, [])

  if (!isDesktop) return null

  // On macOS, native traffic light controls are located on the left
  if (window.aihub?.platform === 'darwin') return null

  return (
    <div
      className="flex h-full items-center select-none"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <button
        type="button"
        onClick={() => api.window.minimize()}
        className="flex h-full w-11 items-center justify-center text-zinc-400 transition-colors hover:bg-white/[0.08] hover:text-zinc-100 active:bg-white/[0.14]"
        title="Minimize"
        aria-label="Minimize"
      >
        <Minus size={13} strokeWidth={2} />
      </button>
      <button
        type="button"
        onClick={() => api.window.maximize().then(setMaximized).catch(() => {})}
        className="flex h-full w-11 items-center justify-center text-zinc-400 transition-colors hover:bg-white/[0.08] hover:text-zinc-100 active:bg-white/[0.14]"
        title={maximized ? 'Restore' : 'Maximize'}
        aria-label={maximized ? 'Restore' : 'Maximize'}
      >
        {maximized ? (
          <RestoreIcon className="size-3" />
        ) : (
          <Square size={11} strokeWidth={1.75} />
        )}
      </button>
      <button
        type="button"
        onClick={() => api.window.close()}
        className="flex h-full w-11 items-center justify-center text-zinc-400 transition-colors hover:bg-red-500 hover:text-white active:bg-red-600"
        title="Close"
        aria-label="Close"
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  )
}
