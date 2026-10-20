// R70 / PR-001 — الخطة النهائية v2: «المجهول ما يصيرش حقيقة».
//
// A financial fact that was never recorded must stay NULL end to end:
//   • catalog adds fabricate NOTHING (no 50 EGP price, no 75% cost,
//     no phantom 10, no made-up threshold of 5);
//   • operations that NEED an unknown field are blocked with a clear
//     owner-facing reason — never priced at 0;
//   • reports say «غير مسجل» — they never treat unknown as 0;
//   • the owner can complete the data later, field by field.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Business, Item, User } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { testDb } from '../helpers/test-db'
import { createDraft, executeOperation } from '@/lib/domain/executors'
import { upsertCatalogItemInDb } from '@/lib/domain/business-builder'
import { OperationValidationError } from '@/lib/domain/errors'

process.env.WAKIL_OFFLINE = '1'

let db: Awaited<ReturnType<typeof testDb>>
let business: Business
let owner: User
const key = () => `no-facts-${randomUUID()}`

beforeAll(async () => {
  db = await testDb()
  business = await db.business.create({ data: { name: key(), type: 'supermarket' } })
  owner = await db.user.create({ data: { businessId: business.id, name: 'owner', role: 'owner' } })
})

afterAll(async () => {
  await db.business.deleteMany({ where: { id: business.id } })
  await db.$disconnect?.()
})

describe('catalog — adding without data invents nothing', () => {
  test('an item added with NO financial data stores all-null facts', async () => {
    const res = await upsertCatalogItemInDb({ businessId: business.id, userId: owner.id, name: key() })
    expect(res.created).toBe(true)
    const it = res.item
    expect(it.sellPrice).toBeNull() // not the old «5000»
    expect(it.costPrice).toBeNull() // not the old 75%-of-sell
    expect(it.stockQty).toBeNull() // not the old «10»
    expect(it.lowStockThreshold).toBeNull() // not the old «5»
    // display labels still default (classification, not financial facts)
    expect(it.unit).toBe('piece')
    expect(it.category).toBe('عام')
  })

  test('the owner can complete the data later, field by field', async () => {
    const first = await upsertCatalogItemInDb({ businessId: business.id, userId: owner.id, name: key() })
    const id = first.item.id
    await upsertCatalogItemInDb({ businessId: business.id, userId: owner.id, name: first.item.name, sellPriceEgp: 12 })
    let it = await db.item.findUniqueOrThrow({ where: { id } })
    expect(it.sellPrice).toBe(1200)
    expect(it.costPrice).toBeNull() // still unknown — never derived from sell
    expect(it.stockQty).toBeNull()
    await upsertCatalogItemInDb({
      businessId: business.id, userId: owner.id, name: first.item.name,
      buyPriceEgp: 9, stockQty: 40, minQty: 8,
    })
    it = await db.item.findUniqueOrThrow({ where: { id } })
    expect(it.costPrice).toBe(900)
    expect(it.stockQty).toBe(40)
    expect(it.lowStockThreshold).toBe(8)
    expect(it.sellPrice).toBe(1200) // untouched by the second update
  })
})

describe('operations — an unknown field blocks the move, loudly', () => {
  test('a basket line with an unrecorded sell price is refused at draft time', async () => {
    const it = await db.item.create({ data: { businessId: business.id, name: key(), unit: 'piece', sellPrice: null, costPrice: null, stockQty: 5, lowStockThreshold: null } })
    const other = await db.item.create({ data: { businessId: business.id, name: key(), unit: 'piece', sellPrice: 500, costPrice: 300, stockQty: 5, lowStockThreshold: null } })
    await expect(
      createDraft({
        businessId: business.id, userId: owner.id, type: 'sale', summary: key(),
        payload: { lines: [{ itemId: other.id, qty: 1, unitPrice: 500, total: 500 }, { itemId: it.id, qty: 2, total: 800 }] },
        idempotencyKey: key(),
      }),
    ).rejects.toBeInstanceOf(OperationValidationError)
    expect(await db.operation.count({ where: { businessId: business.id } })).toBe(0)
  })

  test('a basket line with an unrecorded cost is refused at draft time', async () => {
    const it = await db.item.create({ data: { businessId: business.id, name: key(), unit: 'piece', sellPrice: null, costPrice: null, stockQty: 5, lowStockThreshold: null } })
    await expect(
      createDraft({
        businessId: business.id, userId: owner.id, type: 'purchase', summary: key(),
        payload: { lines: [{ itemId: it.id, qty: 2, total: 800 }] },
        idempotencyKey: key(),
      }),
    ).rejects.toBeInstanceOf(OperationValidationError)
  })

  test('selling against an UNCOUNTED stock is refused and writes nothing', async () => {
    const it = await db.item.create({ data: { businessId: business.id, name: key(), unit: 'piece', sellPrice: 1000, costPrice: 500, stockQty: null, lowStockThreshold: null } })
    const op = await createDraft({
      businessId: business.id, userId: owner.id, type: 'sale', summary: key(),
      payload: { itemId: it.id, qty: 2, total: 2000 }, idempotencyKey: key(),
    })
    const { outcome } = await executeOperation(op.id, owner.id)
    expect(outcome.ok).toBe(false)
    expect(String(outcome.failReason ?? '')).toContain('غير مسجل')
    expect(await db.cashEntry.count({ where: { businessId: business.id, ref: op.ref } })).toBe(0)
    const after = await db.item.findUniqueOrThrow({ where: { id: it.id } })
    expect(after.stockQty).toBeNull() // still unknown — nothing was subtracted from nothing
  })

  test('a new-item purchase records the PAID cost and never invents a sell price', async () => {
    const itemName = key()
    const op = await createDraft({
      businessId: business.id, userId: owner.id, type: 'purchase', summary: key(),
      payload: { newItem: true, itemName, unitPrice: 4000, qty: 5, total: 20000, paid: 20000 },
      idempotencyKey: key(),
    })
    const { outcome } = await executeOperation(op.id, owner.id)
    expect(outcome.ok).toBe(true)
    const created = await db.item.findFirst({ where: { businessId: business.id, name: itemName } })
    expect(created).not.toBeNull()
    expect(created!.costPrice).toBe(4000) // the price actually paid (piastres)
    expect(created!.sellPrice).toBeNull() // NOT copied from cost
    expect(created!.stockQty).toBe(5) // 0 at birth + the purchased 5 — a real count
    expect(created!.lowStockThreshold).toBeNull() // no made-up 5
  })

  test('buying with an explicit price RESOLVES an unknown cost; unknown stock stays unknown', async () => {
    const it = await db.item.create({ data: { businessId: business.id, name: key(), unit: 'piece', sellPrice: null, costPrice: null, stockQty: null, lowStockThreshold: null } })
    const op = await createDraft({
      businessId: business.id, userId: owner.id, type: 'purchase', summary: key(),
      payload: { itemId: it.id, qty: 4, unitPrice: 2500, total: 10000, paid: 10000 },
      idempotencyKey: key(),
    })
    const { outcome } = await executeOperation(op.id, owner.id)
    expect(outcome.ok).toBe(true)
    const after = await db.item.findUniqueOrThrow({ where: { id: it.id } })
    expect(after.costPrice).toBe(2500) // the approved purchase is a trusted source
    expect(after.stockQty).toBeNull() // unknown + 4 ≠ a known total
  })

  test('a stocktake (absolute) is how an uncounted shelf becomes recorded', async () => {
    const it = await db.item.create({ data: { businessId: business.id, name: key(), unit: 'piece', sellPrice: 1000, costPrice: 500, stockQty: null, lowStockThreshold: null } })
    const op = await createDraft({
      businessId: business.id, userId: owner.id, type: 'stock_adjustment', summary: key(),
      payload: { itemId: it.id, delta: 30, absolute: true, reason: 'جرد — تسجيل الكمية' },
      idempotencyKey: key(),
    })
    const { outcome } = await executeOperation(op.id, owner.id)
    expect(outcome.ok).toBe(true)
    const after = await db.item.findUniqueOrThrow({ where: { id: it.id } })
    expect(after.stockQty).toBe(30)
  })
})

describe('reports — «غير مسجل» instead of a fake 0', () => {
  test('stock value sums the KNOWN items and says so for the unknown', async () => {
    // known: 10 × 1000 = 10,000 piastres. unknown: 5 × (never priced).
    await db.item.create({ data: { businessId: business.id, name: key(), unit: 'piece', sellPrice: 2000, costPrice: 1000, stockQty: 10, lowStockThreshold: null } })
    await db.item.create({ data: { businessId: business.id, name: key(), unit: 'piece', sellPrice: 2000, costPrice: null, stockQty: 5, lowStockThreshold: null } })
    const { runReadTool } = await import('@/lib/agent/tools')
    // only this test's items exist in a business with these exact two rows?
    // the report covers the whole business — compute the expected over all rows.
    const items = await db.item.findMany({ where: { businessId: business.id } })
    const knownCost = items.reduce((s, i) => s + (i.stockQty != null && i.costPrice != null && i.stockQty !== 0 ? i.stockQty * i.costPrice : 0), 0)
    const unknownCount = items.filter((i) => i.stockQty != 0 && (i.stockQty == null || i.costPrice == null)).length
    const [card] = (await runReadTool('get_stock_value', business.id, {})) as { rows: { label: string; value: string }[] }[]
    const row = card.rows.find((r) => r.label === 'بسعر التكلفة')!
    expect(unknownCount).toBeGreaterThan(0)
    expect(row.value).toContain('ج.م')
    expect(row.value).toContain('غير مسجل')
    // the known part is exact (EGP on screen, Arabic-Indic digits)
    const ar = (n: number) => String(n).replace(/[0-9]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'[Number(d)]))
    expect(row.value).toContain(ar(Math.round(knownCost / 100)))
  })

  test('a shortage needs a COUNTED stock AND a recorded threshold', async () => {
    const realLow = await db.item.create({ data: { businessId: business.id, name: key(), unit: 'piece', sellPrice: 100, costPrice: 50, stockQty: 2, lowStockThreshold: 5 } })
    await db.item.create({ data: { businessId: business.id, name: key(), unit: 'piece', sellPrice: 100, costPrice: 50, stockQty: null, lowStockThreshold: 5 } }) // unknown ≠ out
    await db.item.create({ data: { businessId: business.id, name: key(), unit: 'piece', sellPrice: 100, costPrice: 50, stockQty: 2, lowStockThreshold: null } }) // no threshold → no alert
    const { runReadTool } = await import('@/lib/agent/tools')
    const [card] = (await runReadTool('list_low_stock', business.id, {})) as { rows: Record<string, string>[] }[]
    const names = card.rows.map((r) => r.name)
    expect(names).toContain(realLow.name)
    const footer = (card as { footer?: { label: string; value: string }[] }).footer?.find((f) => f.label.includes('الناقص'))
    expect(footer?.value).toBeDefined()
  })
})
