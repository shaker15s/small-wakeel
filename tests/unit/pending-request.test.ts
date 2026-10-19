import { expect, test } from 'bun:test'
import {
  extractNewItemCandidate,
  fillPendingSlots,
  looksLikeNewTopic,
  parseSlots,
  pendingFollowUpText,
  pendingQuestionText,
  slotsJson,
  type NewItemSlots,
} from '@/lib/agent/pending-request'
import { normalizeAr } from '@/lib/agent/arabic'

const base = (over: Partial<NewItemSlots> = {}): NewItemSlots => ({
  itemId: null,
  itemName: 'سمنه',
  qty: 100,
  unit: 'piece',
  unitLabel: 'صفيحه',
  paid: 1000,
  supplierName: null,
  suggestedSupplier: null,
  total: null,
  unitPrice: null,
  ...over,
})

// ---- extractNewItemCandidate — the owner's first fragment -----------------
test('extracts qty + owner unit + name + stated partial payment from a delivery sentence', () => {
  const c = extractNewItemCandidate('جبت 100 صفيحه سمنه ودفعتله 1000 بس النهارده', normalizeAr('جبت 100 صفيحه سمنه ودفعتله 1000 بس النهارده'))
  expect(c).not.toBeNull()
  expect(c!.itemName).toBe('سمنه')
  expect(c!.qty).toBe(100)
  expect(c!.unitLabel).toBe('صفيحه')
  expect(c!.paid).toBe(1000)
  expect(c!.supplierName).toBeNull()
  expect(c!.total).toBeNull()
})

test('handles Arabic-Indic digits and a two-word item name', () => {
  const t = 'جبت ٢٥ علبه عسل سدر ودفعت 300 بس'
  const c = extractNewItemCandidate(t, normalizeAr(t))
  expect(c).not.toBeNull()
  expect(c!.qty).toBe(25)
  expect(c!.itemName).toBe('عسل سدر')
  expect(c!.paid).toBe(300)
})

test('returns null when there is no quantity at all', () => {
  expect(extractNewItemCandidate('جبت سمنه ودفعت 100', normalizeAr('جبت سمنه ودفعت 100'))).toBeNull()
})

// ---- fillPendingSlots — the owner's follow-up fragments --------------------
test('fills supplier (new name) and total from the follow-up', () => {
  const out = fillPendingSlots(normalizeAr('المورد شركة السمانه المصريه والسعر كله 2000'), base(), [])
  expect(out.supplierName).toBe('شركه السمانه المصريه')
  expect(out.total).toBe(2000)
  expect(out.unitPrice).toBe(20)
  expect(out.changed).toBe(true)
})

test('prefers the CANONICAL known-supplier name over a raw capture', () => {
  const out = fillPendingSlots(normalizeAr('المورد شركة الألبان الوطنية'), base(), ['شركة الألبان الوطنية', 'محمد تاجر الجملة'])
  expect(out.supplierName).toBe('شركة الألبان الوطنية')
})

test('does not treat the paid or the quantity as the total', () => {
  const out = fillPendingSlots(normalizeAr('الحساب 500'), base(), [])
  expect(out.total).toBe(500)
  const out2 = fillPendingSlots(normalizeAr('2000 تاني'), base({ total: 2000 }), [])
  expect(out2.total).toBe(2000) // re-stating the same number is not a change of slots
})

test('derives unit price from total×qty and vice versa', () => {
  const out = fillPendingSlots(normalizeAr('الوحده بـ 20'), base(), [])
  expect(out.unitPrice).toBe(20)
  expect(out.total).toBe(2000) // 20 × 100
  const out2 = fillPendingSlots(normalizeAr('والحساب كله 1500'), base(), [])
  expect(out2.total).toBe(1500)
  expect(out2.unitPrice).toBe(15)
})

// ---- the employee's voice ---------------------------------------------------
test('new-item question asks supplier AND total in one breath', () => {
  const q = pendingQuestionText(base(), 'purchase_new_item')
  expect(q).toContain('سمنه')
  expect(q).toContain('١٠')
  expect(q).toContain('١٬٠٠٠')
  expect(q).toContain('مين بتاع')
  expect(q).toContain('كام الحساب كله')
})

test('a proposed supplier turns the question into a yes/no', () => {
  const q = pendingQuestionText(base({ suggestedSupplier: 'شركه السمانه المصريه' }), 'purchase_new_item')
  expect(q).toContain('شركه السمانه المصريه')
  expect(q).toContain('نفس المورد')
})

test('known-item question asks ONLY the supplier (catalog prices it)', () => {
  const q = pendingQuestionText(base({ itemId: 'item-1', unitLabel: null, unit: 'piece' }), 'purchase_known_item')
  expect(q).toContain('مين بتاع سمنه')
  expect(q).not.toContain('كام الحساب كله')
})

test('follow-up never re-asks a known item for its total', () => {
  const q = pendingFollowUpText(base({ itemId: 'item-1', supplierName: 'X' }), 'purchase_known_item')
  expect(q).toBe('تمام — جهزتلك المسودة')
  const qNew = pendingFollowUpText(base({ supplierName: 'X' }), 'purchase_new_item')
  expect(qNew).toContain('كام الحساب كله')
})

// ---- topic release + persistence round-trip ---------------------------------
test('a message with pending vocabulary never releases the request', () => {
  expect(looksLikeNewTopic(normalizeAr('المورد شركة فلان'))).toBe(false)
  expect(looksLikeNewTopic(normalizeAr('الحساب كله 2000'))).toBe(false)
})
test('a plain numberless chat sentence releases it', () => {
  expect(looksLikeNewTopic(normalizeAr('تمام شكرا'))).toBe(true)
})
test('slots survive a JSON round-trip', () => {
  const s = base({ supplierName: 'X', total: 2000, itemId: 'item-9' })
  const back = parseSlots(slotsJson(s))
  expect(back.supplierName).toBe('X')
  expect(back.total).toBe(2000)
  expect(back.itemId).toBe('item-9')
  expect(parseSlots('{}').itemName).toBe('')
})
