import { Activity, CheckCircle2, Lock, RefreshCw, RotateCcw, Terminal } from 'lucide-react'
import type { CliSubscriptionStatus, Settings } from '@shared/types'
import { act, api, useData } from '../lib/api'
import { relative } from '../lib/dates'
import { CliAvatar } from './CliAvatars'
import { cx, Field, Modal } from './ui'

const fmtTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

/** Compact top-bar strip showing live status & 5h limit gauges for all subscriptions. */
export function SubscriptionStatusStrip({
  clis,
  selectedCli,
  onSelectCli,
  onOpenLimitsModal
}: {
  clis: CliSubscriptionStatus[]
  selectedCli: string
  onSelectCli: (c: CliSubscriptionStatus) => void
  onOpenLimitsModal: () => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      {clis.map((sub) => {
        const locked = !sub.authenticated
        const pct = sub.limit.utilizationPct
        return (
          <button
            key={sub.id}
            type="button"
            onClick={() => (locked ? onOpenLimitsModal() : onSelectCli(sub))}
            title={
              locked
                ? `${sub.name}: ${sub.statusReason} (Click to sign in)`
                : `${sub.name} (${sub.planLabel}) — ${pct}% of 5h window used · ${sub.limit.resetInLabel}`
            }
            className={cx(
              'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] transition-all',
              locked
                ? 'border-white/[0.05] bg-white/[0.02] text-zinc-500 opacity-50 hover:opacity-80'
                : sub.id === selectedCli
                  ? 'border-indigo-400/35 bg-indigo-500/15 font-medium text-white'
                  : 'border-white/[0.08] bg-white/[0.04] text-zinc-300 hover:bg-white/[0.08]'
            )}
          >
            <CliAvatar cli={sub.id} size={13} />
            <span>{sub.shortName}</span>
            {locked ? (
              <Lock size={10} className="text-zinc-500" />
            ) : (
              <span
                className={cx(
                  'rounded-full px-1.5 py-0.2 font-mono text-[10px]',
                  sub.limit.status === 'rejected'
                    ? 'bg-red-500/20 text-red-300'
                    : sub.limit.status === 'warning'
                      ? 'bg-amber-500/20 text-amber-300'
                      : 'bg-emerald-500/15 text-emerald-300'
                )}
              >
                {pct}%
              </span>
            )}
          </button>
        )
      })}

      <button
        type="button"
        onClick={onOpenLimitsModal}
        title="Open Live Subscription Limits & Authentication Manager"
        className="btn btn-ghost h-7 px-2 text-[11.5px] text-zinc-400 hover:text-white"
      >
        <Activity size={13} className="text-indigo-400" /> Limits
      </button>
    </div>
  )
}

export function LiveLimitsModal({
  clis,
  settings,
  onAuthenticateCli,
  onRefresh,
  onClose
}: {
  clis: CliSubscriptionStatus[]
  settings: Settings | undefined
  onAuthenticateCli: (sub: CliSubscriptionStatus) => void
  onRefresh: () => void
  onClose: () => void
}): React.JSX.Element {
  const { data: recent } = useData(() => api.clis.recentUsage())

  const updateSetting = (patch: Partial<Settings>): void => {
    act(api.settings.update(patch), 'Saved')
  }

  return (
    <Modal
      title={
        <span className="flex items-center gap-2">
          <Activity size={16} className="text-indigo-400" /> Live Subscription Quotas & CLI Authentication
        </span>
      }
      width="max-w-4xl"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onRefresh} className="btn">
            <RefreshCw size={13} /> Re-check CLI Authentication
          </button>
          <span className="flex-1" />
          <button type="button" onClick={onClose} className="btn btn-primary">
            Done
          </button>
        </>
      }
    >
      <div className="max-h-[72vh] space-y-5 overflow-y-auto pr-1">
        <p className="muted text-[12.5px]">
          Use your existing flat-rate AI subscriptions instead of paying per-token API credits. Unauthenticated subscriptions are automatically greyed out in the composer until you sign in.
        </p>

        {/* Subscription Cards Grid */}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {clis.map((sub) => {
            const locked = !sub.authenticated
            const pct = sub.limit.utilizationPct
            const barClass =
              sub.limit.status === 'rejected'
                ? 'bg-red-500'
                : sub.limit.status === 'warning'
                  ? 'bg-amber-500'
                  : 'bg-emerald-500'

            return (
              <div
                key={sub.id}
                className={cx(
                  'rounded-xl border p-4 transition-all',
                  locked ? 'border-white/[0.06] bg-black/20 opacity-70' : 'border-white/[0.1] bg-white/[0.04]'
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <CliAvatar cli={sub.id} size={24} />
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-[14.5px] font-semibold text-white">{sub.name}</h3>
                        {sub.authenticated ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10.5px] font-medium text-emerald-300">
                            <CheckCircle2 size={10} /> Connected
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full bg-zinc-500/20 px-2 py-0.5 text-[10.5px] font-medium text-zinc-400">
                            <Lock size={10} /> Greyed Out
                          </span>
                        )}
                      </div>
                      <p className="text-[11.5px] text-zinc-400">
                        {sub.accountLabel} · {sub.planLabel}
                      </p>
                    </div>
                  </div>

                  {locked ? (
                    <button
                      type="button"
                      onClick={() => {
                        onClose()
                        onAuthenticateCli(sub)
                      }}
                      className="btn h-7 border-amber-400/35 bg-amber-500/15 px-2.5 text-[11.5px] text-amber-200 hover:bg-amber-500/25"
                    >
                      <Terminal size={12} /> Authenticate
                    </button>
                  ) : (
                    sub.limit.status === 'rejected' && (
                      <button
                        type="button"
                        onClick={() => act(api.clis.clearRateLimit(sub.id), 'Cleared limit lock')}
                        className="btn btn-ghost h-7 px-2 text-[11px]"
                        title="Reset rate limit warning"
                      >
                        <RotateCcw size={11} /> Unlock
                      </button>
                    )
                  )}
                </div>

                <p className="mt-2 text-[12px] text-zinc-400">{sub.statusReason}</p>
                {sub.exePath && (
                  <p className="mt-0.5 truncate font-mono text-[11px] text-zinc-500" title={sub.exePath}>
                    Binary: {sub.exePath}
                  </p>
                )}

                {sub.authenticated ? (
                  <div className="mt-3 space-y-2 rounded-lg border border-white/[0.06] bg-black/30 p-2.5">
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-[12px]">
                        <span className="flex items-center gap-1.5 font-medium text-zinc-200">
                          5-Hour Session Window: {pct}%
                          <span
                            className={cx(
                              'rounded-full px-1.5 py-0.2 text-[9.5px] font-semibold tracking-wide uppercase',
                              sub.limit.source === 'live' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-white/[0.07] text-zinc-400'
                            )}
                            title={sub.limit.source === 'live' ? 'Read from the provider' : 'Estimated from token usage against your plan tier'}
                          >
                            {sub.limit.source === 'live' ? 'live' : 'estimated'}
                          </span>
                        </span>
                        <span className="text-zinc-400">{sub.limit.resetInLabel}</span>
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded-full bg-white/[0.08]">
                        <div className={cx('h-full rounded-full transition-all', barClass)} style={{ width: `${Math.max(3, pct)}%` }} />
                      </div>
                    </div>

                    {sub.limit.weeklyUtilizationPct !== undefined && (
                      <div className="space-y-1 pt-0.5">
                        <div className="flex items-center justify-between text-[11.5px]">
                          <span className="font-medium text-zinc-300">
                            7-Day Weekly Window: {sub.limit.weeklyUtilizationPct}%
                          </span>
                          <span className="text-zinc-500">{sub.limit.weeklyResetInLabel}</span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
                          <div
                            className="h-full rounded-full bg-indigo-500 transition-all"
                            style={{ width: `${Math.max(2, sub.limit.weeklyUtilizationPct)}%` }}
                          />
                        </div>
                      </div>
                    )}

                    {!!sub.limit.modelBuckets?.length && (
                      <div className="space-y-1.5 border-t border-white/[0.06] pt-2">
                        <div className="eyebrow">Per-model limits</div>
                        {sub.limit.modelBuckets.map((b) => (
                          <div key={b.key} className="space-y-0.5">
                            <div className="flex items-center justify-between text-[11.5px]">
                              <span className="text-zinc-300">
                                {b.label}
                                <span className="ml-1.5 text-zinc-500">
                                  {b.resetInLabel}
                                  {b.source === 'estimated' ? ` · ${fmtTokens(b.usedTokens)} tok · est.` : ''}
                                </span>
                              </span>
                              <span
                                className={cx('font-mono', b.status === 'rejected' ? 'text-red-300' : b.status === 'warning' ? 'text-amber-300' : 'text-zinc-300')}
                                title={b.resetInLabel}
                              >
                                {100 - b.utilizationPct}% left
                              </span>
                            </div>
                            <div className="meter h-1">
                              <span
                                className={b.status === 'rejected' ? 'bg-red-500' : b.status === 'warning' ? 'bg-amber-500' : 'bg-sky-500'}
                                style={{ width: `${Math.max(2, b.utilizationPct)}%` }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-[11px] text-zinc-400">
                      <span>
                        5h: {fmtTokens(sub.limit.usedTokens)} tokens · {sub.limit.usedRequests} turns
                      </span>
                      <span>
                        24h: {fmtTokens(sub.limit.todayTokens)} · 7d: {fmtTokens(sub.limit.weekTokens)}
                      </span>
                    </div>
                    {sub.limit.liveNote && <p className="text-[10.5px] text-zinc-500">{sub.limit.liveNote}</p>}
                  </div>
                ) : (
                  <div className="mt-3 rounded-lg border border-dashed border-white/[0.08] bg-black/20 p-2.5 font-mono text-[11px] text-zinc-400">
                    <div>Install: {sub.installCommand}</div>
                    <div>Sign in: {sub.loginCommand}</div>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Subscription Tiers & Automatic Limit Handover Config */}
        {settings && (
          <div className="card space-y-3 p-4">
            <h4 className="text-[13.5px] font-semibold text-white">Subscription Tiers & Automatic Rate-Limit Handover</h4>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <Field label="Claude Subscription Tier">
                <select
                  className="input h-8 text-[12.5px]"
                  value={settings.claudeTier}
                  onChange={(e) => updateSetting({ claudeTier: e.target.value as Settings['claudeTier'] })}
                >
                  <option value="pro">Claude Pro (auto-detected when signed in)</option>
                  <option value="max5x">Claude Max (5x 5h window)</option>
                  <option value="max20x">Claude Max (20x 5h window)</option>
                </select>
              </Field>
              <Field label="Antigravity Tier">
                <select
                  className="input h-8 text-[12.5px]"
                  value={settings.agyTier}
                  onChange={(e) => updateSetting({ agyTier: e.target.value as Settings['agyTier'] })}
                >
                  <option value="standard">Antigravity Standard</option>
                  <option value="pro">Antigravity Pro</option>
                </select>
              </Field>
              <Field label="OpenAI Codex Tier">
                <select
                  className="input h-8 text-[12.5px]"
                  value={settings.codexTier}
                  onChange={(e) => updateSetting({ codexTier: e.target.value as Settings['codexTier'] })}
                >
                  <option value="plus">ChatGPT Plus</option>
                  <option value="pro">ChatGPT Pro</option>
                </select>
              </Field>
            </div>

            <label className="flex cursor-pointer items-center gap-2 pt-1 text-[13px] text-zinc-200">
              <input
                type="checkbox"
                checked={settings.cliHandover}
                onChange={(e) => updateSetting({ cliHandover: e.target.checked })}
                className="accent-indigo-500"
              />
              Automatically hand over to the next signed-in subscription when one reaches its limit
            </label>
          </div>
        )}

        {/* Recent Usage Log */}
        {!!recent?.length && (
          <div className="space-y-2">
            <h4 className="text-[12px] font-semibold tracking-wider text-zinc-400 uppercase">Recent CLI Runs</h4>
            <div className="card divide-y divide-white/[0.06] overflow-hidden">
              {recent.slice(0, 8).map((r) => (
                <div key={r.id} className="flex items-center justify-between px-3.5 py-2 text-[12px]">
                  <span className="flex items-center gap-2">
                    <CliAvatar cli={r.cli} size={14} />
                    <span className="font-medium text-zinc-200">{r.cli.toUpperCase()}</span>
                    <span className="font-mono text-zinc-400">{r.model}</span>
                  </span>
                  <span className="text-zinc-400">
                    {fmtTokens(r.tokens)} tokens · {Math.max(1, Math.round(r.duration_ms / 1000))}s · {relative(r.created_at)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
