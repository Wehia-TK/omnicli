import { useState } from 'react'
import { ArrowDown, ArrowUp, LogIn, Plus, RotateCcw, Trash2 } from 'lucide-react'
import type { CliAccount, CliId } from '@shared/types'
import { act, api, useData } from '../lib/api'
import { confirmAction, cx, Modal } from './ui'
import { EmbeddedTerminal } from './EmbeddedTerminal'

const PROVIDERS: { cli: CliId; name: string }[] = [
  { cli: 'claude', name: 'Claude Code' },
  { cli: 'codex', name: 'OpenAI Codex' }
]

/** Extra logins per provider. When one hits its limit, the next is tried before switching to another provider. */
export function AccountsSection(): React.JSX.Element {
  const { data: accounts, reload } = useData(() => api.accounts.list())
  const [cli, setCli] = useState<CliId>('claude')
  const [label, setLabel] = useState('')
  const [signingIn, setSigningIn] = useState<CliAccount | null>(null)

  const add = async (): Promise<void> => {
    const created = await act(api.accounts.add(cli, label), 'Account added — sign in to activate it')
    if (!created) return
    setLabel('')
    reload()
    setSigningIn(created)
  }

  return (
    <div className="space-y-2.5 rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
      <div>
        <div className="text-[13px] font-semibold text-zinc-100">Extra accounts (same provider fallback)</div>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-zinc-400">
          Your normal CLI login is always tried first. When it hits its limit, saved accounts are tried in the order below before handing over to a
          different provider. Each account signs in once through the CLI&apos;s own login and keeps its own isolated config folder — Omni CLI stores no
          passwords.
        </p>
      </div>

      {PROVIDERS.map((p) => {
        const list = (accounts ?? []).filter((a) => a.cli === p.cli)
        if (!list.length) return null
        return (
          <div key={p.cli} className="space-y-1.5">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{p.name}</div>
            {list.map((a, i) => (
              <div key={a.id} className="flex items-center gap-2 rounded-md border border-white/[0.06] bg-black/20 px-2.5 py-1.5">
                <span className="w-4 text-center font-mono text-[11px] text-zinc-500">{i + 2}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] text-zinc-100">{a.label}</div>
                  <div className={cx('truncate text-[11px]', a.limited ? 'text-amber-400' : a.authenticated ? 'text-emerald-400' : 'text-zinc-500')}>
                    {a.limited ? 'Rate limited' : a.authenticated ? a.accountLabel : 'Not signed in'}
                  </div>
                </div>
                <button type="button" className="btn h-7 px-2 text-[11px]" onClick={() => setSigningIn(a)}>
                  <LogIn size={11} /> {a.authenticated ? 'Re-sign in' : 'Sign in'}
                </button>
                {a.limited && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon h-7 w-7"
                    title="Clear rate-limit lock"
                    onClick={() => act(api.accounts.clearLimit(a.id)).then(reload)}
                  >
                    <RotateCcw size={12} />
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-ghost btn-icon h-7 w-7"
                  disabled={i === 0}
                  title="Try earlier"
                  onClick={() => act(api.accounts.move(a.id, -1)).then(reload)}
                >
                  <ArrowUp size={12} />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon h-7 w-7"
                  disabled={i === list.length - 1}
                  title="Try later"
                  onClick={() => act(api.accounts.move(a.id, 1)).then(reload)}
                >
                  <ArrowDown size={12} />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon h-7 w-7 text-red-400"
                  title="Remove account"
                  onClick={() => confirmAction(`Remove "${a.label}" and its saved login?`) && act(api.accounts.remove(a.id), 'Account removed').then(reload)}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )
      })}

      <div className="flex gap-2">
        <select className="input h-9 w-36 text-[12.5px]" value={cli} onChange={(e) => setCli(e.target.value as CliId)}>
          {PROVIDERS.map((p) => (
            <option key={p.cli} value={p.cli}>
              {p.name}
            </option>
          ))}
        </select>
        <input
          className="input flex-1 text-[12.5px]"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && label.trim() && void add()}
          placeholder="Account name, e.g. Work Max"
        />
        <button type="button" className="btn btn-primary h-9" disabled={!label.trim()} onClick={() => void add()}>
          <Plus size={13} /> Add &amp; sign in
        </button>
      </div>

      {signingIn && (
        <Modal
          title={`Sign in — ${signingIn.label}`}
          width="max-w-3xl"
          onClose={() => {
            setSigningIn(null)
            void api.clis.statusAll(true)
            reload()
          }}
        >
          <p className="mb-2 text-[11.5px] text-zinc-400">
            Complete the browser sign-in for the account you want to use here, then close this window. It runs the CLI&apos;s own login in this
            account&apos;s separate config folder.
          </p>
          <div className="h-80">
            <EmbeddedTerminal sessionId={`account-login-${signingIn.id}`} cwd="" clis={[]} loginAccountId={signingIn.id} />
          </div>
        </Modal>
      )}
    </div>
  )
}
