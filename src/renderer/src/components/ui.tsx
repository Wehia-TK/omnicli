import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'

export function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(' ')
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 'max-w-lg'
}: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: string
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/65 p-6 pt-[8vh] backdrop-blur-md" onMouseDown={onClose}>
      <div className={cx('card w-full border border-white/[0.12] bg-[#15161c]', width)} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/[0.08] px-5 py-3.5">
          <h2 className="text-[15px] font-semibold text-white">{title}</h2>
          <button className="btn btn-ghost btn-icon -mr-2" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex items-center gap-2 rounded-b-xl border-t border-white/[0.08] bg-white/[0.02] px-5 py-3">{footer}</div>}
      </div>
    </div>
  )
}

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }): React.JSX.Element {
  return (
    <label className={cx('block', className)}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="muted mt-1 block text-[11.5px]">{hint}</span>}
    </label>
  )
}

export function Empty({ icon, title, hint, action }: { icon: ReactNode; title: string; hint?: string; action?: ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <div className="mb-1 text-zinc-600">{icon}</div>
      <p className="font-medium text-zinc-200">{title}</p>
      {hint && <p className="muted max-w-sm text-[13px]">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function confirmAction(message: string): boolean {
  return window.confirm(message)
}
