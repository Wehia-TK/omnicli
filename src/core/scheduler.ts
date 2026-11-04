import type { Schedule } from '@shared/types'
import { all, get, nowLocal, run } from './db'
import { getSettings } from './settings'

type Starter = (s: Schedule) => void

let timer: ReturnType<typeof setInterval> | null = null
let starter: Starter = () => undefined

/** Next fire time (epoch ms) after `from` for a schedule. */
export function nextRun(s: Pick<Schedule, 'kind' | 'time_of_day' | 'every_hours' | 'weekday'>, from = Date.now()): number {
  if (s.kind === 'hourly') return from + Math.max(1, s.every_hours) * 3600_000
  const [hh, mm] = (s.time_of_day || '09:00').split(':').map((n) => Number(n) || 0)
  const d = new Date(from)
  d.setSeconds(0, 0)
  d.setHours(hh, mm)
  if (s.kind === 'weekly') {
    const diff = (s.weekday - d.getDay() + 7) % 7
    d.setDate(d.getDate() + diff)
    if (d.getTime() <= from) d.setDate(d.getDate() + 7)
  } else if (d.getTime() <= from) {
    d.setDate(d.getDate() + 1)
  }
  return d.getTime()
}

export function initScheduler(onDue: Starter): void {
  starter = onDue
  if (timer) clearInterval(timer)
  timer = setInterval(tick, 30_000)
  setTimeout(tick, 5000)
}

function tick(): void {
  const now = Date.now()
  for (const s of all<Schedule>('SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?', now)) {
    run('UPDATE schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?', now, nextRun(s, now), s.id)
    try {
      starter(s)
    } catch (e) {
      phoneNotify(`Schedule "${s.title}" could not start`, (e as Error).message)
    }
  }
}

/**
 * Where to publish: accepts a bare topic ("my_topic"), "ntfy.sh/my_topic", or a full URL to any ntfy server
 * ("https://ntfy.example.com/my_topic"). Returns null for anything that isn't a valid topic.
 */
export function ntfyTarget(raw: string): { server: string; topic: string } | null {
  const m = raw.trim().match(/^(?:(https?):\/\/)?(?:([^/\s]+)\/)?([A-Za-z0-9_-]{1,64})\/?$/i)
  if (!m) return null
  const server = m[2] ? `${m[1] || 'https'}://${m[2]}` : 'https://ntfy.sh'
  return { server, topic: m[3] }
}

/** Publish via ntfy's JSON API (UTF-8 safe titles, unlike HTTP headers). */
async function publishNtfy(title: string, body: string): Promise<void> {
  const raw = getSettings().ntfyTopic.trim()
  if (!raw) return
  const target = ntfyTarget(raw)
  if (!target) throw new Error(`"${raw}" is not a valid ntfy topic (use letters, numbers, _ or -)`)
  const res = await fetch(target.server, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: target.topic, title: title.slice(0, 200), message: body.slice(0, 1000) || title, tags: ['robot'] }),
    signal: AbortSignal.timeout(10_000)
  })
  if (!res.ok) throw new Error(`ntfy rejected the message (${res.status} ${res.statusText})`)
}

/** Push a notification to your phone through ntfy (only when a topic is set in Settings). Fire-and-forget. */
export function phoneNotify(title: string, body: string): void {
  publishNtfy(title, body).catch((e) => console.warn('[ntfy]', (e as Error).message))
}
export const schedules = {
  list: (projectId: number): Schedule[] => all<Schedule>('SELECT * FROM schedules WHERE project_id = ? ORDER BY id', projectId),

  save: (s: Partial<Schedule> & { project_id: number; title: string; prompt: string }): Schedule => {
    if (!s.title.trim() || !s.prompt.trim()) throw new Error('Give the schedule a title and a prompt')
    const kind = s.kind ?? 'daily'
    const cfg = { kind, time_of_day: s.time_of_day ?? '09:00', every_hours: s.every_hours ?? 24, weekday: s.weekday ?? 1 }
    const next = nextRun(cfg)
    const id = s.id
      ? (run(
          `UPDATE schedules SET title = ?, prompt = ?, cli = ?, model = ?, effort = ?, permission_mode = ?, kind = ?, time_of_day = ?, every_hours = ?, weekday = ?, enabled = ?, next_run_at = ? WHERE id = ?`,
          s.title.trim(),
          s.prompt.trim(),
          s.cli ?? 'claude',
          s.model ?? '',
          s.effort ?? 'medium',
          s.permission_mode ?? 'accept-edits',
          kind,
          cfg.time_of_day,
          cfg.every_hours,
          cfg.weekday,
          s.enabled ?? 1,
          next,
          s.id
        ),
        s.id)
      : run(
          `INSERT INTO schedules (project_id, title, prompt, cli, model, effort, permission_mode, kind, time_of_day, every_hours, weekday, enabled, next_run_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          s.project_id,
          s.title.trim(),
          s.prompt.trim(),
          s.cli ?? 'claude',
          s.model ?? '',
          s.effort ?? 'medium',
          s.permission_mode ?? 'accept-edits',
          kind,
          cfg.time_of_day,
          cfg.every_hours,
          cfg.weekday,
          next,
          nowLocal()
        )
    return get<Schedule>('SELECT * FROM schedules WHERE id = ?', id)!
  },

  toggle: (id: number): Schedule => {
    const s = get<Schedule>('SELECT * FROM schedules WHERE id = ?', id)
    if (!s) throw new Error('Schedule not found')
    run('UPDATE schedules SET enabled = ?, next_run_at = ? WHERE id = ?', s.enabled ? 0 : 1, s.enabled ? null : nextRun(s), id)
    return get<Schedule>('SELECT * FROM schedules WHERE id = ?', id)!
  },

  delete: (id: number): true => {
    run('DELETE FROM schedules WHERE id = ?', id)
    return true
  },

  runNow: (id: number): true => {
    const s = get<Schedule>('SELECT * FROM schedules WHERE id = ?', id)
    if (!s) throw new Error('Schedule not found')
    run('UPDATE schedules SET last_run_at = ? WHERE id = ?', Date.now(), id)
    starter(s)
    return true
  },

  testPhone: async (): Promise<true> => {
    if (!getSettings().ntfyTopic.trim()) throw new Error('Set an ntfy topic in Settings first')
    await publishNtfy('Omni CLI', 'Phone notifications are working.')
    return true
  }
}
