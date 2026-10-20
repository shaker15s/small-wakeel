// وكيل — integration tests against a REAL SQLite database.
//
// The seeded demo database is copied to a temp file first, so these tests
// exercise the true production path (engine-free Prisma client + libsql driver
// adapter + the deterministic executors) without touching demo data:
//   • draft → approve → verification read-back
//   • idempotency keys (the same draft is never created twice)
//   • the atomic approve claim (concurrent approvals execute exactly once)
//   • tenant isolation (a user from another business can never act on ours)
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { testDb } from '../helpers/test-db'

 
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let executors: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let auth: any

beforeAll(async () => {
  db = await testDb()
  // Import AFTER the shared test DB is wired up: src/lib/db is a module singleton.
  executors = await import('../../src/lib/domain/executors')
  auth = await import('../../src/lib/security/auth')
})

afterAll(async () => {
  await db?.$disconnect?.()
})

describe('integration.executors', () => {
  test('a sale draft + approval moves stock, cash and the customer balance', async () => {
    const business = await db.business.findFirst({ where: { type: 'supermarket' } })
    const item = await db.item.findFirst({ where: { businessId: business.id, stockQty: { gt: 5 } } })
    const customer = await db.customer.findFirst({ where: { businessId: business.id } })
    const user = await db.user.findFirst({ where: { businessId: business.id, role: 'owner' } })

    const before = { stock: item.stockQty, balance: customer.balance }
    const idempotencyKey = `test-sale-${Date.now()}`
    const salePayload = {
      itemId: item.id,
      qty: 2,
      unit: item.unit,
      unitPrice: item.sellPrice,
      total: item.sellPrice * 2,
      paid: item.sellPrice, // 1 unit paid, 1 unit on credit
      customerId: customer.id,
    }

    const draft = await executors.createDraft({
      businessId: business.id,
      userId: user.id,
      type: 'sale',
      summary: 'عملية اختبار',
      risk: 'R2',
      idempotencyKey,
      payload: salePayload,
    })
    expect(draft.ref).toMatch(/^WKL-\d+$/)
    expect(draft.status).toBe('AWAITING_APPROVAL')

    // Idempotency: the same key + SAME payload must return the SAME operation,
    // not a new one. (R71/PR-003 §20.5: a key reused with a DIFFERENT payload
    // is a collision and is refused — see tests/integration/approval-binding.)
    const again = await executors.createDraft({
      businessId: business.id,
      userId: user.id,
      type: 'sale',
      summary: 'عملية اختبار',
      risk: 'R2',
      idempotencyKey,
      payload: salePayload,
    })
    expect(again.id).toBe(draft.id)

    const { op, outcome } = await executors.executeOperation(draft.id, user.id)
    expect(op.status).toBe('SUCCEEDED')
    expect(outcome.ok).toBe(true)
    expect(outcome.checks.every((c: { pass: boolean }) => c.pass)).toBe(true)

    const afterItem = await db.item.findUnique({ where: { id: item.id } })
    const afterCustomer = await db.customer.findUnique({ where: { id: customer.id } })
    expect(afterItem.stockQty).toBe(before.stock - 2)
    expect(afterCustomer.balance).toBe(before.balance + item.sellPrice)
  })

  test('approving twice is rejected — no double execution', async () => {
    const business = await db.business.findFirst({ where: { type: 'supermarket' } })
    const item = await db.item.findFirst({ where: { businessId: business.id, stockQty: { gt: 5 } } })
    const user = await db.user.findFirst({ where: { businessId: business.id, role: 'owner' } })

    const draft = await executors.createDraft({
      businessId: business.id,
      userId: user.id,
      type: 'expense',
      summary: 'مصروف اختبار',
      risk: 'R2',
      idempotencyKey: `test-expense-${Date.now()}`,
      payload: { total: 1500, label: 'اختبار' },
    })

    await executors.executeOperation(draft.id, user.id)
    await expect(executors.executeOperation(draft.id, user.id)).rejects.toThrow()
    // The stock/cash effects happened exactly once — verified by the ledger.
    const entries = await db.cashEntry.count({ where: { ref: draft.ref } })
    expect(entries).toBe(1)
    void item
  })

  test('concurrent approvals: exactly one wins the atomic claim', async () => {
    const business = await db.business.findFirst({ where: { type: 'supermarket' } })
    const user = await db.user.findFirst({ where: { businessId: business.id, role: 'owner' } })
    const item = await db.item.findFirst({ where: { businessId: business.id, stockQty: { gt: 10 } } })

    const draft = await executors.createDraft({
      businessId: business.id,
      userId: user.id,
      type: 'sale',
      summary: 'بيع متزامن',
      risk: 'R2',
      idempotencyKey: `test-race-${Date.now()}`,
      payload: { itemId: item.id, qty: 1, total: item.sellPrice, paid: item.sellPrice },
    })

    const results = await Promise.allSettled([
      executors.executeOperation(draft.id, user.id),
      executors.executeOperation(draft.id, user.id),
      executors.executeOperation(draft.id, user.id),
    ])
    const ok = results.filter((r: { status: string }) => r.status === 'fulfilled')
    expect(ok.length).toBe(1)

    const cashRows = await db.cashEntry.count({ where: { ref: draft.ref } })
    expect(cashRows).toBe(1)
  })
})

describe('integration.tenantIsolation', () => {
  test('a user from another business is refused', async () => {
    const [a, b] = await Promise.all([
      db.business.findFirst({ where: { type: 'pharmacy' } }),
      db.business.findFirst({ where: { type: 'gym' } }),
    ])
    const foreignUser = await db.user.findFirst({ where: { businessId: b.id } })

    const denied = await auth.resolveActor(a.id, foreignUser.id)
    expect(denied.failure?.kind).toBe('forbidden')
    expect(denied.actor).toBeUndefined()

    const own = await db.user.findFirst({ where: { businessId: a.id } })
    const allowed = await auth.resolveActor(a.id, own.id)
    expect(allowed.failure).toBeUndefined()
    expect(allowed.actor.user.id).toBe(own.id)
  })

  test('unknown ids are reported, never silently accepted', async () => {
    const missing = await auth.resolveActor('does-not-exist', 'nobody')
    expect(missing.failure?.kind).toBe('not-found')
    const partial = await auth.resolveActor(null, null)
    expect(partial.failure?.kind).toBe('missing-ids')
  })
})
