import { describe, expect, test } from 'bun:test'
import { payloadTotalPiastres } from '../../src/app/api/_lib/serialize'

// ---------------------------------------------------------------------------
// R30 — «الأرقام في الشاشة لازم تكون أرقامك» (reporting payload shapes)
// ---------------------------------------------------------------------------
// The screens audit found the reports/stats screens reading zero for gym,
// pharmacy and attar. Two real causes, both pinned here:
//   1. payloads are not uniform — chat drafts write `total`, seeded rows write
//      `amount`, baskets may only carry `lines` with unit prices;
//   2. a gym's revenue is `membership`, not `sale`.

describe('payloadTotalPiastres — كل شكل payload بيتقرا', () => {
  test('chat draft: total (piastres)', () => {
    expect(payloadTotalPiastres(JSON.stringify({ total: 471600 }))).toBe(471600)
  })
  test('seeded collection/payment/expense: amount', () => {
    expect(payloadTotalPiastres(JSON.stringify({ customer: 'مستشفى الرحمة', amount: 120000 }))).toBe(120000)
    expect(payloadTotalPiastres(JSON.stringify({ supplier: 'شركة الدواء', amount: 80000 }))).toBe(80000)
    expect(payloadTotalPiastres(JSON.stringify({ category: 'أدوات', amount: 18000 }))).toBe(18000)
  })
  test('basket with only line totals', () => {
    const p = { lines: [{ name: 'أوجمنتين', qty: 2, unitPrice: 11000 }, { name: 'أوميز', qty: 1, unitPrice: 3300 }] }
    expect(payloadTotalPiastres(JSON.stringify(p))).toBe(25300)
  })
  test('basket with per-line totals wins over unit prices', () => {
    const p = { lines: [{ name: 'أ', qty: 3, unitPrice: 100, total: 999 }] }
    expect(payloadTotalPiastres(JSON.stringify(p))).toBe(999)
  })
  test('garbage never becomes money', () => {
    expect(payloadTotalPiastres(null)).toBe(0)
    expect(payloadTotalPiastres('not json')).toBe(0)
    expect(payloadTotalPiastres(JSON.stringify({ total: 'كثير' }))).toBe(0)
    expect(payloadTotalPiastres(JSON.stringify({}))).toBe(0)
  })
})
