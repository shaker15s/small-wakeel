// وكيل — Cairo-timezone day helpers for read API routes.
// The businesses operate in Africa/Cairo; "today" buckets must follow the
// Cairo calendar even though the server clock may run in another timezone.

const CAIRO_TZ = 'Africa/Cairo'
const DAY_MS = 86_400_000

type CairoDateParts = { year: number; month: number; day: number }

/** Y/M/D of the Cairo calendar day that contains instant `d`. */
function cairoDateParts(d: Date): CairoDateParts {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: CAIRO_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const [y, m, day] = fmt.format(d).split('-').map(Number)
  return { year: y, month: m, day }
}

/** Offset (ms) of Africa/Cairo vs UTC at the given instant. */
function cairoOffsetMs(d: Date): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: CAIRO_TZ,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts = fmt.formatToParts(d)
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type)
    return p ? Number(p.value) : 0
  }
  const asUTC = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  )
  return asUTC - d.getTime()
}

/** Instant of Cairo midnight for the Cairo day `daysBack` before today (0 = today). */
export function startOfCairoDay(daysBack = 0): Date {
  const { year, month, day } = cairoDateParts(new Date())
  const naiveMidnight = Date.UTC(year, month - 1, day) - daysBack * DAY_MS
  // Solve: instant t with cairo wall-clock(t) == naiveMidnight (two iterations absorb DST).
  let t = naiveMidnight - cairoOffsetMs(new Date(naiveMidnight))
  t = naiveMidnight - cairoOffsetMs(new Date(t))
  return new Date(t)
}

/** Cairo calendar-day index (days since Unix epoch, counted in Cairo dates). */
export function cairoDayIndex(d: Date): number {
  const { year, month, day } = cairoDateParts(d)
  return Date.UTC(year, month - 1, day) / DAY_MS
}

/** Whole calendar days from today (Cairo) to `target`. Negative = in the past. */
export function daysFromTodayCairo(target: Date): number {
  return cairoDayIndex(target) - cairoDayIndex(new Date())
}

/** ISO 'YYYY-MM-DD' of the Cairo calendar day containing instant `d`. */
export function cairoIsoDay(d: Date): string {
  const { year, month, day } = cairoDateParts(d)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${year}-${pad(month)}-${pad(day)}`
}

/** ISO 'YYYY-MM-DD' of the Cairo day `daysBack` before today (0 = today). */
export function cairoIsoDayOffset(daysBack: number): string {
  const { year, month, day } = cairoDateParts(new Date())
  return cairoIsoDay(new Date(Date.UTC(year, month - 1, day) - daysBack * DAY_MS))
}
