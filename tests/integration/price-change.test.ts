// R39 — «غيّر سعر الزيت لـ٧٠» is a WRITE, not a catalog lookup.
//
// Three things are pinned here:
//   1. the deterministic ladder understands the price command (absolute vs
//      delta) and never mistakes a price QUESTION for a change;
//   2. the executor really moves the catalog price — and only after approval;
//   3. «بكام الزيت؟» finds «زيت عافية 800 مل» (the article + brand-name gap
//      that made the search return 0 rows in the live R38 probe).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { testDb } from '../helpers/test-db'

process.env.WAKIL_OFFLINE = '1'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ruleBasedIntentForTest: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let runReadTool: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createDraft: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let executeOperation: any
let business: { id: string; type: string }
let user: { id: string }

beforeAll(async () => {
  db = await testDb()
  business = await db.business.findFirst({ where: { type: 'supermarket' } })
  user = await db.user.findFirst({ where: { businessId: business.id } })
  ruleBasedIntentForTest = (await import('../../src/lib/agent/harness')).ruleBasedIntentForTest
  runReadTool = (await import('../../src/lib/agent/tools')).runReadTool
  createDraft = (await import('../../src/lib/domain/executors')).createDraft
  executeOperation = (await import('../../src/lib/domain/executors')).executeOperation
})

afterAll(async () => {
  await db?.$disconnect?.()
})

type Intent = {
  intent: string
  opType?: string
  tool?: string
  fields?: { itemName?: string; newPrice?: number; priceMode?: string; priceSign?: number; query?: string }
}

describe('price change — الأمر مش استعلام', () => {
  test('«غيّر سعر X لـ٤٠» = write مطلق بـ٤٠', () => {
    const r = ruleBasedIntentForTest('غيّر سعر الزيت لـ٤٠', business.type) as Intent
    expect(r.intent).toBe('write')
    expect(r.opType).toBe('price_change')
    expect(r.fields?.newPrice).toBe(40)
    expect(r.fields?.priceMode).toBe('absolute')
  })

  test('«سعر X يبقى ٤٠» بيتقري كسعر جديد', () => {
    const r = ruleBasedIntentForTest('سعر الزيت يبقى ٤٠', business.type) as Intent
    expect(r.intent).toBe('write')
    expect(r.opType).toBe('price_change')
    expect(r.fields?.newPrice).toBe(40)
  })

  test('«زود سعر X ٢» = فرق +٢، «نزل سعر X ٥» = فرق −٥', () => {
    const up = ruleBasedIntentForTest('زود سعر السكر ٢', business.type) as Intent
    expect(up.opType).toBe('price_change')
    expect(up.fields?.priceMode).toBe('delta')
    expect(up.fields?.priceSign).toBe(1)
    const down = ruleBasedIntentForTest('نزل سعر السكر ٥', business.type) as Intent
    expect(down.fields?.priceMode).toBe('delta')
    expect(down.fields?.priceSign).toBe(-1)
  })

  test('سؤال السعر والكلام عن الماضي مش كتابة', () => {
    for (const q of ['بكام الزيت؟', 'سعر اللبن كام؟', 'غيرت سعر الزيت امبارح', 'غيّر سعر الزيت ليه؟']) {
      const r = ruleBasedIntentForTest(q, business.type) as Intent
      expect({ q, intent: r.intent, opType: r.opType ?? null }).toEqual({ q, intent: 'read', opType: null })
    }
  })
})

describe('price change — التنفيذ على الداتابيز', () => {
  test('المسودة مش بتغيّر السعر — الاعتماد هو اللي بيغيّره', async () => {
    const item = await db.item.findFirst({ where: { businessId: business.id }, orderBy: { name: 'asc' } })
    const original: number = item.sellPrice
    const target = original + 500

    const op = await createDraft({
      businessId: business.id,
      userId: user.id,
      type: 'price_change',
      summary: `سعر ${item.name}: ${original} ← ${target}`,
      payload: { itemId: item.id, itemName: item.name, newPrice: target, field: 'sellPrice' },
      idempotencyKey: `test-price-${item.id}-${Date.now()}`,
    })
    const before = await db.item.findUnique({ where: { id: item.id } })
    expect(before.sellPrice).toBe(original)

    const { op: done, outcome } = await executeOperation(op.id, user.id)
    expect(outcome.ok).toBe(true)
    const after = await db.item.findUnique({ where: { id: item.id } })
    expect(after.sellPrice).toBe(target)
    expect(done.status).toBe('SUCCEEDED')

    // leave the demo DB exactly as it was
    await db.item.update({ where: { id: item.id }, data: { sellPrice: original } })
  })

  test('get_price_check بيلتقط السعر تحت التكلفة بعد التغيير', async () => {
    // «البيع بخسارة» لازم تشوف الصنف بعد ما السعر ينزل — الأداة بتقارن
    // الـsellPrice بالـcostPrice من نفس الصف.
    const item = await db.item.findFirst({
      where: { businessId: business.id, costPrice: { gt: 0 } },
      orderBy: { name: 'asc' },
    })
    const original: number = item.sellPrice
    await db.item.update({ where: { id: item.id }, data: { sellPrice: Math.max(1, item.costPrice - 100) } })
    const [card] = (await runReadTool('get_price_check', business.id, {})) as { kind: string; rows: Record<string, string>[] }[]
    await db.item.update({ where: { id: item.id }, data: { sellPrice: original } })
    expect(card.kind).toBe('table')
    expect(card.rows.some((r) => r['الصنف'] === item.name || JSON.stringify(r).includes(item.name))).toBe(true)
  })
})

describe('search_catalog — «بكام الزيت؟» بيلاقي «زيت عافية»', () => {
  test('المادة بأل التعريف بتوصل لاسم الصنف الكامل', async () => {
    const [card] = (await runReadTool('search_catalog', business.id, { query: 'الزيت' })) as {
      kind: string
      rows: { name: string }[]
    }[]
    expect(card.kind).toBe('table')
    expect(card.rows.length).toBeGreaterThan(0)
    expect(card.rows.some((r) => r.name.includes('زيت'))).toBe(true)
  })

  test('الاستعلام الفاضي بيرجع أول أصناف الكتالوج', async () => {
    const [card] = (await runReadTool('search_catalog', business.id, {})) as { rows: { name: string }[] }[]
    expect(card.rows.length).toBeGreaterThan(0)
    expect(card.rows.length).toBeLessThanOrEqual(8)
  })
})
