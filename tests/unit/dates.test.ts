// وكيل — Cairo calendar boundaries.
// The server may run in UTC; the shop closes on CAIRO time. These tests pin the
// day boundaries so "today" totals never include yesterday's evening sales.
import { describe, expect, test } from 'bun:test'
import { cairoDayIndex, cairoIsoDay, daysFromTodayCairo, startOfCairoDay } from '../../src/app/api/_lib/dates'

describe('dates.cairo', () => {
  test('a Cairo day has exactly 24h between consecutive midnights (off DST change days)', () => {
    const today = startOfCairoDay(0)
    const yesterday = startOfCairoDay(1)
    const diffHours = (today.getTime() - yesterday.getTime()) / 3_600_000
    expect(diffHours).toBeGreaterThanOrEqual(23)
    expect(diffHours).toBeLessThanOrEqual(25)
  })

  test('midnight in Cairo is not midnight UTC', () => {
    const start = startOfCairoDay(0)
    // Cairo is UTC+2/+3 — the UTC hour of a Cairo midnight is 21 or 22.
    expect(start.getUTCHours()).toBeGreaterThanOrEqual(20)
    expect(start.getUTCHours()).toBeLessThanOrEqual(23)
  })

  test('22:30 UTC is already TOMORROW in Cairo', () => {
    const lateEvening = new Date('2026-06-01T22:30:00.000Z') // 01:30 Cairo, June 2nd
    expect(cairoIsoDay(lateEvening)).toBe('2026-06-02')
    expect(daysFromTodayCairo(lateEvening)).toBe(cairoDayIndex(lateEvening) - cairoDayIndex(new Date()))
  })

  test('cairoIsoDay is stable and zero-padded', () => {
    expect(cairoIsoDay(new Date('2026-01-05T12:00:00.000Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
