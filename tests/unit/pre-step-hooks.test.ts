// R45 — pre-step waterfall (DeepSeek-Harness `agent/pre-step`): the pure
// decision that keeps a typo-sized fortune out of the ledger.
import { expect, test } from 'bun:test'
import { absurdAmountCheck } from '@/lib/agent/harness'

test('absurd amount relative to the business baseline → flagged with multiplier', () => {
  // baseline 400 EGP → threshold max(50×400, 20000) = 20000
  const hit = absurdAmountCheck('بعت ٣٠٠٠٠ علبة سكر', 400)
  expect(hit).not.toBeNull()
  expect(hit!.amountEgp).toBe(30000)
  expect(hit!.multiplier).toBe(75)
})

test('normal amount → no flag', () => {
  expect(absurdAmountCheck('بعت ١٠٠ علبة سكر', 400)).toBeNull()
  expect(absurdAmountCheck('بعت ١٩٩٩٩ علبة سكر', 400)).toBeNull() // just under threshold
})

test('no write verb → never flagged (questions are safe)', () => {
  expect(absurdAmountCheck('عايز أبيع ٥٠٠٠٠ حاجة', 400)).toBeNull()
  expect(absurdAmountCheck('سعر السكر كام؟', 400)).toBeNull()
})

test('tiny amounts are never flagged (1000 EGP floor)', () => {
  expect(absurdAmountCheck('بعت ٨٠٠ سكر', 400)).toBeNull()
})

test('explicit confirmation bypasses the guard (owner said «متأكد»)', () => {
  expect(absurdAmountCheck('متأكد — بعت ٣٠٠٠٠ علبة سكر', 400, { confirmed: true })).toBeNull()
})

test('new business (no baseline) uses the 20,000 EGP floor', () => {
  expect(absurdAmountCheck('بعت ٢٥٠٠٠ سكر', 0)).not.toBeNull()
  expect(absurdAmountCheck('بعت ١٥٠٠٠ سكر', 0)).toBeNull()
})
