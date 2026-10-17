// The six weekly ledger questions, answered without a model.
//
// «بيعرف يعمل كل حاجة من غير ما نروح للموديل» — every tool here is pure SQL +
// arithmetic, so the test pins it to the database instead of to a snapshot:
// if the ledger changes, the expected numbers change with it.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { testDb } from '../helpers/test-db'

process.env.WAKIL_OFFLINE = '1'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let runReadTool: any
let business: { id: string; type: string }

beforeAll(async () => {
  db = await testDb()
  business = await db.business.findFirst({ where: { type: 'supermarket' } })
  runReadTool = (await import('../../src/lib/agent/tools')).runReadTool
})

afterAll(async () => {
  await db?.$disconnect?.()
})

/** «١٬٢٣٤ ج.م» / «-٥٠ ج.م» → 1234 / -50 (piastres are EGP on screen). */
function money(text: string): number {
  const western = String(text)
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[^\d.-]/g, '')
  return Number(western || 0)
}

type KV = { kind: string; rows: { label: string; value: string }[] }
type Table = { kind: string; rows: Record<string, string>[]; footer?: { label: string; value: string }[] }

describe('ledger tools — أرقام من السجل نفسه', () => {
  test('get_stock_value = Σ stock × price, in EGP', async () => {
    const items = await db.item.findMany({ where: { businessId: business.id } })
    const cost = items.reduce((s: number, it: { stockQty: number; costPrice: number }) => s + it.stockQty * it.costPrice, 0)
    const [card] = (await runReadTool('get_stock_value', business.id, {})) as KV[]
    const row = card.rows.find((r) => r.label === 'بسعر التكلفة')
    expect(row).toBeDefined()
    expect(money(row!.value)).toBe(Math.round(cost / 100))
  })

  test('get_top_items ranks by real sale lines', async () => {
    const since = new Date(Date.now() - 30 * 86400000)
    const ops = await db.operation.findMany({
      where: { businessId: business.id, status: 'SUCCEEDED', type: 'sale', createdAt: { gte: since } },
    })
    // the tool reads BOTH shapes: a multi-line sale and a one-line sale that
    // stores only itemId/itemName — the expectation must read both too.
    const items = await db.item.findMany({ where: { businessId: business.id }, select: { id: true, name: true } })
    const byId = new Map<string, string>(items.map((i: { id: string; name: string }) => [i.id, i.name] as [string, string]))
    const book = new Map<string, number>()
    for (const o of ops) {
      const p = JSON.parse(o.payload) as { lines?: { name: string; qty: number; unitPrice: number }[]; itemId?: string; itemName?: string; qty?: number; total?: number }
      if (p.lines?.length) {
        for (const l of p.lines) book.set(l.name, (book.get(l.name) ?? 0) + l.qty * l.unitPrice)
      } else {
        const name = p.itemName ?? (p.itemId ? byId.get(p.itemId) : undefined)
        if (name) book.set(name, (book.get(name) ?? 0) + Number(p.total ?? 0))
      }
    }
    const [card] = (await runReadTool('get_top_items', business.id, { days: 30 })) as Table[]
    if (book.size === 0) {
      expect(card.kind).toBe('kv')
      return
    }
    const best = [...book.entries()].sort((a, b) => b[1] - a[1])[0]
    expect(card.rows[0].name).toBe(best[0])
    expect(money(card.rows[0].money)).toBe(Math.round(best[1] / 100))
  })

  test('get_dead_stock lists only what did not sell', async () => {
    const since = new Date(Date.now() - 30 * 86400000)
    const [items, ops] = await Promise.all([
      db.item.findMany({ where: { businessId: business.id, stockQty: { gt: 0 } } }),
      db.operation.findMany({ where: { businessId: business.id, status: 'SUCCEEDED', type: 'sale', createdAt: { gte: since } } }),
    ])
    const sold = new Set<string>()
    const soldIds = new Set<string>()
    for (const o of ops) {
      const p = JSON.parse(o.payload) as { lines?: { name: string }[]; itemId?: string }
      for (const l of p.lines ?? []) sold.add(l.name)
      if (p.itemId) soldIds.add(p.itemId)
    }
    const expected = items.filter((it: { id: string; name: string }) => !sold.has(it.name) && !soldIds.has(it.id)).length
    const [card] = (await runReadTool('get_dead_stock', business.id, { days: 30 })) as Table[]
    if (expected === 0) {
      expect(card.kind).toBe('kv')
      return
    }
    const footer = card.footer?.find((f) => f.label === 'عدد الأصناف')
    expect(footer).toBeDefined()
    expect(Number(String(footer!.value).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))))).toBe(expected)
  })

  test('get_price_check never invents a healthy margin', async () => {
    const items = await db.item.findMany({ where: { businessId: business.id, stockQty: { gt: 0 }, costPrice: { gt: 0 } } })
    const bad = items.filter((it: { costPrice: number; sellPrice: number }) => (it.sellPrice - it.costPrice) / it.costPrice < 0.15)
    const [card] = (await runReadTool('get_price_check', business.id, {})) as Table[]
    if (bad.length === 0) {
      expect(card.kind).toBe('kv')
      return
    }
    expect(card.kind).toBe('table')
    expect(card.rows.length).toBeGreaterThan(0)
    expect(card.rows.length).toBeLessThanOrEqual(12)
  })

  test('get_reorder_list asks for a real quantity at real cost', async () => {
    const items = await db.item.findMany({ where: { businessId: business.id } })
    const low = items.filter((it: { stockQty: number; lowStockThreshold: number }) => it.lowStockThreshold > 0 && it.stockQty <= it.lowStockThreshold)
    const [card] = (await runReadTool('get_reorder_list', business.id, {})) as Table[]
    if (low.length === 0) {
      expect(card.kind).toBe('kv')
      return
    }
    expect(card.kind).toBe('table')
    expect(card.rows.length).toBeGreaterThan(0)
    // every row proposes a positive quantity
    for (const row of card.rows) {
      const n = Number(String(row.qty).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[^\d]/g, ''))
      expect(n).toBeGreaterThan(0)
    }
  })

  test('get_profit_by_item never reports profit above revenue', async () => {
    const [card] = (await runReadTool('get_profit_by_item', business.id, { days: 30 })) as Table[]
    if (card.kind !== 'table') return
    for (const row of card.rows) {
      const revenue = money(row.revenue)
      const profit = money(row.profit)
      expect(profit).toBeLessThanOrEqual(revenue + 1)
    }
  })

  test('ranking tool only returns rows backed by operations', async () => {
    const [card] = (await runReadTool('get_customer_ranking', business.id, {})) as Table[]
    if (card.kind === 'table') {
      // every name shown must exist in the operations' payloads
      const ops = await db.operation.findMany({ where: { businessId: business.id, status: 'SUCCEEDED' }, select: { payload: true } })
      const haystack = ops.map((o: { payload: string }) => o.payload).join(' ')
      for (const row of card.rows) expect(haystack).toContain(row.name)
    }
  })
})
