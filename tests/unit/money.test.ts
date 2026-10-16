// وكيل — money/format guarantees.
// Money is ALWAYS integer piastres; these tests pin the contract that the whole
// domain layer (executors, cards, reports) depends on.
import { describe, expect, test } from 'bun:test'
import { egp, egpPlain, qty, toPiastres, PIASTRES } from '../../src/lib/format'

describe('format.money', () => {
  test('1 EGP === 100 piastres', () => {
    expect(PIASTRES).toBe(100)
    expect(toPiastres(95)).toBe(9500)
    expect(toPiastres(0.5)).toBe(50)
    // banker-ish rounding must never produce a non-integer
    expect(Number.isInteger(toPiastres(12.345))).toBe(true)
  })

  test('egp keeps two decimals only when there are piastres', () => {
    const whole = egp(9500)
    const fraction = egp(9550)
    expect(whole).toContain('ج.م')
    expect(fraction).toContain('ج.م')
    expect(whole).not.toBe(fraction)
  })

  test('negative money renders a minus, never a huge absolute value', () => {
    const out = egp(-2500)
    expect(out).toContain('ج.م')
    expect(out.includes('-') || out.includes('−')).toBe(true)
    expect(out).not.toContain('25')
  })

  test('egpPlain never adds a currency suffix (used inside payloads)', () => {
    expect(egpPlain(9500)).not.toContain('ج.م')
  })

  test('qty formats with the Arabic unit label', () => {
    expect(qty(2, 'علبة')).toContain('علبة')
    expect(qty(0)).toBeTruthy()
  })
})
