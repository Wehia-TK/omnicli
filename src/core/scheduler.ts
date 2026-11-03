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

/** Push a notification to your phone through ntfy.sh (only when a topic is set in Settings). */
export function phoneNotify(title: string, body: string): void {
  const topic = getSettings().ntfyTopic.trim()
  if (!topic) return
  const url = /^https?:\/\//.test(topic) ? topic : `https://ntfy.sh/${encodeURIComponent(topic)}`
  fetch(url, { method: 'POST', body: body.slice(0, 1000), headers: { Title: title.slice(0, 200).replace(/[^\x20-\x7e]/g, ''), Tags: 'robot' } }).catch(() => undefined)
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

  testPhone: (): true => {
    if (!getSettings().ntfyTopic.trim()) throw new Error('Set an ntfy topic in Settings first')
    phoneNotify('AI Hub', 'Phone notifications are working.')
    return true
  }
}
