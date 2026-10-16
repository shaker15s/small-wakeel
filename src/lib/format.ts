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
