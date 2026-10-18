import { cairoIsoDay } from '@/app/api/_lib/dates'
import { normalizeAr, toWesternDigits } from '@/lib/agent/arabic'
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
function wallParts(date: Date): number[] {
  const parts = formatter.formatToParts(date)
  return ['year', 'month', 'day', 'hour', 'minute', 'second'].map((type) => Number(parts.find((p) => p.type === type)?.value))
}
/** Explicit Cairo wall-clock -> UTC. Reject invalid/nonexistent DST wall times. */
export function cairoWallTime(day: string, hour: number, minute: number, second = 0): Date | null {
  const [year, month, date] = day.split('-').map(Number)
  if (!year || !month || !date || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  const desired = Date.UTC(year, month - 1, date, hour, minute, second)
  let instant = desired
  for (let i = 0; i < 4; i++) {
    const [y, mo, d, h, mi, s] = wallParts(new Date(instant))
    instant += desired - Date.UTC(y, mo - 1, d, h, mi, s)
  }
  const result = new Date(instant)
  const actual = wallParts(result)
  return actual.join(',') === [year, month, date, hour, minute, second].join(',') ? result : null
}
/** No guessed date or hour. Supported: YYYY-MM-DD HH:mm, بكرة HH:mm, weekdays HH:mm. */
export function resolveCairoSchedule(label: string, now = new Date()): Date | null {
  const text = normalizeAr(toWesternDigits(label))
  const clock = text.match(/(?:^|\s)([01]?\d|2[0-3]):([0-5]\d)(?=\s|$)/)
  if (!clock) return null
  const time = new Date(cairoIsoDay(now) + 'T12:00:00Z')
  let day = text.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0]
  if (!day) {
    if (/بعد بكره/.test(text)) time.setUTCDate(time.getUTCDate() + 2)
    else if (/بكره/.test(text)) time.setUTCDate(time.getUTCDate() + 1)
    else if (!/النهارده|اليوم/.test(text)) {
      const weekdays: Record<string, number> = { السبت: 6, الاحد: 0, الاتنين: 1, التلات: 2, الاربع: 3, الخميس: 4, الجمعه: 5 }
      const match = Object.keys(weekdays).find((name) => text.includes(name))
      if (!match) return null
      time.setUTCDate(time.getUTCDate() + ((weekdays[match] - time.getUTCDay() + 7) % 7 || 7))
    }
    day = time.toISOString().slice(0, 10)
  }
  const result = cairoWallTime(day, Number(clock[1]), Number(clock[2]))
  return result && result > now ? result : null
}
export function nextCairoRun(from: Date, recurrence: string): Date {
  if (!['daily', 'weekly', 'monthly'].includes(recurrence)) return new Date(from)
  const [year, month, day, hour, minute, second] = wallParts(from)
  const next = new Date(Date.UTC(year, month - 1, day, 12))
  if (recurrence === 'monthly') {
    next.setUTCDate(1); next.setUTCMonth(next.getUTCMonth() + 1)
    const last = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate()
    next.setUTCDate(Math.min(day, last))
  } else next.setUTCDate(next.getUTCDate() + (recurrence === 'daily' ? 1 : 7))
  // For the skipped DST hour, defer 1h rather than lose/duplicate a task.
  return cairoWallTime(next.toISOString().slice(0, 10), hour, minute, second) ?? cairoWallTime(next.toISOString().slice(0, 10), Math.min(23, hour + 1), minute, second) ?? new Date(next)
}
