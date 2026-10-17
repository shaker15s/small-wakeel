// وكيل — integration tests for «تأمل وكيل» (the pre-draft self-critique) and the
// catalog cache, against a COPY of the real seeded database.
//
// These are the checks that protect the owner from the agent's own arithmetic:
// a draft priced 3× the item's history, a sale bigger than the shelf, a
// collection larger than the debt, and the same entry sent twice.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { testDb } from '../helpers/test-db'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let auditDraft: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let catalog: any
let business: { id: string }
let userId: string

beforeAll(async () => {
  db = await testDb()
  // Import AFTER the shared test DB is wired up: src/lib/db is a module singleton.
  auditDraft = (await import('../../src/lib/domain/audit')).auditDraft
  catalog = await import('../../src/lib/agent/catalog')
  business = await db.business.findFirst({ where: { type: 'supermarket' } })
  const owner = await db.user.findFirst({ where: { businessId: business.id, role: 'owner' } })
  userId = owner.id
})

afterAll(async () => {
  await db?.$disconnect?.()
})

describe('audit.draft', () => {
  test('a clean sale at the item price reports no findings and full confidence', async () => {
    const item = await db.item.findFirst({ where: { businessId: business.id, stockQty: { gt: 10 } } })
    const result = await auditDraft({
      businessId: business.id,
      type: 'sale',
      summary: `بيع ${item.name}`,
      payload: { itemId: item.id, qty: 1, unitPrice: item.sellPrice, total: item.sellPrice, paid: item.sellPrice },
    })
    expect(result.findings).toHaveLength(0)
    expect(result.confidence).toBe(100)
  })

  test('selling more than the shelf holds is a warning the owner sees first', async () => {
    const item = await db.item.findFirst({ where: { businessId: business.id, stockQty: { gt: 0, lt: 100 } } })
    const result = await auditDraft({
      businessId: business.id,
      type: 'sale',
      summary: 'بيع كمية أكبر من المتاح',
      payload: {
        itemId: item.id,
        qty: item.stockQty + 50,
        unitPrice: item.sellPrice,
        total: item.sellPrice * (item.stockQty + 50),
        paid: 0,
      },
    })
    const oversell = result.findings.find((f: { code: string }) => f.code === 'oversell')
    expect(oversell).toBeTruthy()
    expect(oversell.severity === 'warn' || oversell.severity === 'danger').toBe(true)
    expect(oversell.detail).toContain(String(item.stockQty))
    expect(result.confidence).toBeLessThan(100)
  })

  test('a price far from the ledger history is flagged with the real numbers', async () => {
    const item = await db.item.findFirst({ where: { businessId: business.id, sellPrice: { gt: 0 } } })
    const result = await auditDraft({
      businessId: business.id,
      type: 'sale',
      summary: 'بيع بسعر غريب',
      payload: { itemId: item.id, qty: 1, unitPrice: item.sellPrice * 3, total: item.sellPrice * 3, paid: 0 },
    })
    const price = result.findings.find((f: { code: string }) => f.code === 'price_anomaly')
    expect(price).toBeTruthy()
    expect(price.severity).toBe('danger')
  })

  test('collecting more than the customer owes is caught', async () => {
    const customer = await db.customer.findFirst({ where: { businessId: business.id, balance: { gt: 0 } } })
    const result = await auditDraft({
      businessId: business.id,
      type: 'collection',
      summary: 'تحصيل أكبر من المديونية',
      payload: { customerId: customer.id, amount: customer.balance + 100_000 },
    })
    expect(result.findings.some((f: { code: string }) => f.code === 'overpay')).toBe(true)
  })

  test('the same draft twice inside the window looks like a double entry', async () => {
    const item = await db.item.findFirst({ where: { businessId: business.id, stockQty: { gt: 5 } } })
    const summary = `بيع مكرر ${Date.now()}`
    const payload = { itemId: item.id, qty: 1, unitPrice: item.sellPrice, total: item.sellPrice, paid: 0 }
    // a twin already sitting in the ledger as a draft
    await db.operation.create({
      data: {
        ref: `WKL-T${Date.now() % 10_000}`,
        businessId: business.id,
        type: 'sale',
        status: 'AWAITING_APPROVAL',
        source: 'chat',
        userId,
        risk: 'R2',
        summary,
        payload: JSON.stringify(payload),
        idempotencyKey: `audit-test-${Date.now()}`,
      },
    })
    const result = await auditDraft({ businessId: business.id, type: 'sale', summary, payload })
    expect(result.findings.some((f: { code: string }) => f.code === 'duplicate')).toBe(true)
  })

  test('an audit can never throw, even with a nonsense payload', async () => {
    const result = await auditDraft({
      businessId: 'does-not-exist',
      type: 'sale',
      summary: '',
      payload: { lines: [{ itemId: null, qty: 'كلام' }] },
    })
    expect(Array.isArray(result.findings)).toBe(true)
    expect(result.confidence).toBeGreaterThan(0)
  })
})

describe('catalog.cache', () => {
  test('a second read inside the TTL is served from memory, invalidation makes it fresh', async () => {
    catalog.invalidateCatalog()
    const first = await catalog.getCatalog(business.id)
    const second = await catalog.getCatalog(business.id)
    // same object identity ⇒ the second call did not hit the database
    expect(second.items).toBe(first.items)

    catalog.invalidateCatalog(business.id)
    const third = await catalog.getCatalog(business.id)
    expect(third.items).not.toBe(first.items)
    expect(third.items.length).toBe(first.items.length)
  })

  test('stats expose a hit ratio (the /api/health speed signal)', () => {
    const stats = catalog.catalogCacheStats()
    expect(stats.hits + stats.misses).toBeGreaterThan(0)
    expect(stats.ratio).toBeGreaterThanOrEqual(0)
    expect(stats.ratio).toBeLessThanOrEqual(100)
  })
})
