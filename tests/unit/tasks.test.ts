// وكيل — recurring-task arithmetic.
//
// «فكرني كل يوم…» is a promise the product makes; these tests pin the arithmetic
// that keeps it, including the two cases that used to be silently broken
// (reminders ignoring recurrence, and month-end rollover).
import { describe, expect, test } from 'bun:test'
import { nextRun } from '../../src/lib/tasks/runner'

describe('tasks.nextRun', () => {
  test('daily → same clock time tomorrow', () => {
    const from = new Date('2026-10-16T21:00:00.000Z')
    expect(nextRun(from, 'daily')!.toISOString()).toBe('2026-10-17T21:00:00.000Z')
  })

  test('weekly → +7 days', () => {
    expect(nextRun(new Date('2026-10-16T09:30:00.000Z'), 'weekly')!.toISOString()).toBe('2026-10-23T09:30:00.000Z')
  })

  test('monthly keeps the day where possible', () => {
    expect(nextRun(new Date('2026-01-15T08:00:00.000Z'), 'monthly')!.toISOString()).toBe('2026-02-15T08:00:00.000Z')
  })

  test('unknown recurrence returns null (the runner treats it as one-shot, not «same time again»)', () => {
    // R40 regression: legacy tasks stored recurrence='none'. The old contract
    // «unknown → same instant» made nextCairoRun return the past time verbatim,
    // so the task re-fired every 60s and flooded the owner's conversation with
    // the same reminder forever. Now: unknown → null → the task is marked done.
    const from = new Date('2026-10-16T21:00:00.000Z')
    expect(nextRun(from, 'fortnightly')).toBeNull()
    expect(nextRun(from, 'none')).toBeNull()
    expect(nextRun(from, '')).toBeNull()
  })

  test('the result is always strictly in the future', () => {
    const from = new Date()
    for (const r of ['daily', 'weekly', 'monthly']) {
      const next = nextRun(from, r)
      expect(next).not.toBeNull()
      expect(next!.getTime()).toBeGreaterThan(from.getTime())
    }
  })
})
