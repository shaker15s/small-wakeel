// وكيل — money & date formatting (Egyptian Arabic, piastres-first)

export const PIASTRES = 100

export function egp(piastres: number): string {
  const pounds = piastres / PIASTRES
  const formatted = new Intl.NumberFormat('ar-EG', {
    minimumFractionDigits: pounds % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(pounds))
  const sign = piastres < 0 ? '−' : ''
  return `${sign}${formatted} ج.م`
}

export function egpPlain(piastres: number): string {
  return new Intl.NumberFormat('ar-EG', { maximumFractionDigits: 2 }).format(piastres / PIASTRES)
}

export function qty(n: number, unit?: string): string {
  const formatted = new Intl.NumberFormat('ar-EG', { maximumFractionDigits: 2 }).format(n)
  return unit ? `${formatted} ${unit}` : formatted
}

export function toPiastres(pounds: number): number {
  return Math.round(pounds * PIASTRES)
}

export function arDateTime(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  return new Intl.DateTimeFormat('ar-EG', {
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d)
}

export function arTime(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  return new Intl.DateTimeFormat('ar-EG', { hour: 'numeric', minute: '2-digit' }).format(d)
}

export function arDate(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  return new Intl.DateTimeFormat('ar-EG', { day: 'numeric', month: 'long', year: 'numeric' }).format(d)
}

/** «النهاردة» / «امبارح» / «من ٣ أيام» — how fresh is this, in the owner's words. */
export function arAgo(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  if (Number.isNaN(d.getTime())) return ''
  const a = startOfCairoDay(d).getTime()
  const b = startOfCairoDay(new Date()).getTime()
  const days = Math.round((b - a) / 86400000)
  if (days <= 0) return `النهاردة ${arTime(d)}`
  if (days === 1) return `امبارح ${arTime(d)}`
  if (days === 2) return 'أول امبارح'
  if (days < 11) return `من ${arNumPlain(days)} أيام`
  return arDate(d)
}

/** Is this timestamp inside the Cairo day that contains `now`? */
export function isTodayCairo(iso: string | Date, now: Date = new Date()): boolean {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  if (Number.isNaN(d.getTime())) return false
  return startOfCairoDay(d).getTime() === startOfCairoDay(now).getTime()
}

/** 3 → «٣» without the EGP suffix (days, counts). */
export function arNumPlain(n: number): string {
  return new Intl.NumberFormat('ar-EG', { maximumFractionDigits: 0 }).format(n)
}

/** Cairo-local start of day (the app's whole «today» is Africa/Cairo). */
export function startOfCairoDay(d: Date): Date {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const [y, m, day] = fmt.format(d).split('-').map(Number)
  // noon Cairo is 10:00Z (winter) / 09:00Z (summer); we only need the calendar day
  return new Date(Date.UTC(y, m - 1, day, 12))
}

export function arWeekday(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  return new Intl.DateTimeFormat('ar-EG', { weekday: 'long' }).format(d)
}

export function startOfDay(d = new Date()): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

export function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86400000)
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  )
}
