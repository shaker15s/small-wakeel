import { cairoIsoDay } from '@/app/api/_lib/dates'
import { normalizeAr, toWesternDigits } from './arabic'
export function dayOffset(n: number, now: Date) {
  const date = new Date(cairoIsoDay(now) + 'T12:00:00Z'); date.setUTCDate(date.getUTCDate() + n)
  return date.toISOString().slice(0, 10)
}
function valid(day: string): string | null { return !Number.isNaN(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day ? day : null }
export function cashbookDay(text: string, now = new Date(), defaultToday = true): string | null {
  const t = normalizeAr(toWesternDigits(text))
  const mentions = t.match(/\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}|بعد بكره|بكره|اول امبارح|امبارح|امس|النهارده|اليوم|(?:السبت|الاحد|الاتنين|الاثنين|التلات|الثلاثاء|الاربع|الاربعاء|الخميس|الجمعه)\s+(?:الجاي|القادم|اللي فات)/g)
  if (mentions && mentions.length > 1) return null
  const explicit = t.match(/\d{4}-\d{2}-\d{2}/)?.[0]
  if (explicit) return valid(explicit)
  const egyptDate = t.match(/(?:^|\s)(\d{1,2})\/(\d{1,2})\/(\d{4})(?=\s|$)/)
  if (egyptDate) return valid(`${egyptDate[3]}-${egyptDate[2].padStart(2, '0')}-${egyptDate[1].padStart(2, '0')}`)
  if (/بعد بكره/.test(t)) return dayOffset(2, now)
  if (/بكره/.test(t)) return dayOffset(1, now)
  if (/اول امبارح/.test(t)) return dayOffset(-2, now)
  if (/امبارح|امس/.test(t)) return dayOffset(-1, now)
  if (/النهارده|اليوم/.test(t)) return cairoIsoDay(now)
  const weekdays: Record<string, number> = { السبت: 6, الاحد: 0, الاتنين: 1, الاثنين: 1, التلات: 2, الثلاثاء: 2, الاربع: 3, الاربعاء: 3, الخميس: 4, الجمعه: 5 }
  const name = Object.keys(weekdays).find(day => new RegExp(`(?:^|\\s)${day}\\s+(?:الجاي|القادم|اللي فات)(?:\\s|$)`).test(t))
  if (name) {
    const today = new Date(cairoIsoDay(now) + 'T12:00:00Z').getUTCDay()
    const offset = /اللي فات/.test(t) ? -((today - weekdays[name] + 7) % 7 || 7) : ((weekdays[name] - today + 7) % 7 || 7)
    return dayOffset(offset, now)
  }
  if (/يوم|الجمعه|السبت|الاحد|الاتنين|الاثنين|التلات|الثلاثاء|الاربع|الخميس|الشهر|اسبوع/.test(t)) return null
  return defaultToday ? cairoIsoDay(now) : null
}

/** A slot answer is a date clause, not a new financial action containing a date. */
export function cashbookAnswerDay(text: string, now = new Date()): string | null {
  const t = normalizeAr(toWesternDigits(text)).trim().replace(/[.!]+$/, '')
  if (!/^(?:(?:يوم|بتاريخ|ميعاده|السداد|هيسدد)\s+)?(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}|النهارده|اليوم|امبارح|اول امبارح|امس|بكره|بعد بكره|(?:السبت|الاحد|الاتنين|الاثنين|التلات|الثلاثاء|الاربع|الاربعاء|الخميس|الجمعه)\s+(?:الجاي|القادم|اللي فات))$/.test(t)) return null
  return cashbookDay(t, now, false)
}
