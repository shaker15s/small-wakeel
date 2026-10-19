// R41 «موظف حقيقي» — the NEW-ITEM purchase lifecycle at the domain layer.
//
// The harness holds the open request (pending-request.ts, unit-tested) and
// drafts with itemId/supplierId = null. This file proves the MONEY side:
// the item and its supplier are BORN at approval, the open balance lands on
// the supplier, cash moves by the paid amount only, the debt lot is recorded
// exactly once, the resolved IDs are written back onto the operation, a
// retried approval never duplicates a party, and the reversal restores
// everything.
import { beforeAll, afterAll, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { testDb } from '../helpers/test-db'
import { createNewBusinessWithDefaults } from '@/lib/domain/business-builder'
import { createDraft, executeOperation } from '@/lib/domain/executors'
import { cairoIsoDay } from '@/app/api/_lib/dates'
import type { Business, User } from '@prisma/client'

const db = await testDb()
let business: Business, owner: User
const key = () => randomUUID()

const cashNet = async () =>
  (await db.business.findUniqueOrThrow({ where: { id: business.id } })).openingCash +
  (await db.cashEntry.findMany({ where: { businessId: business.id } })).reduce(
    (s, e) => s + (e.direction === 'in' ? e.amount : -e.amount),
    0,
  )

const newPurchase = (itemName: string, supplierName: string, total: number, paid: number) =>
  createDraft({
    businessId: business.id,
    userId: owner.id,
    type: 'purchase',
    payload: {
      itemId: null,
      itemName,
      qty: 24,
      unit: 'piece',
      unitPrice: Math.round(total / 24),
      total,
      paid,
      supplierId: null,
      supplierName,
      newItem: true,
      newSupplier: true,
    },
    summary: `شرا 24 ${itemName} (صنف جديد) — من ${supplierName}`,
    idempotencyKey: key(),
  })

beforeAll(async () => {
  const b = await createNewBusinessWithDefaults({ name: key(), type: 'supermarket' })
  business = await db.business.findUniqueOrThrow({ where: { id: b.id } })
  owner = await db.user.findUniqueOrThrow({ where: { id: b.users[0].id } })
  // fund the till (the default fixture business starts empty)
  const count = await createDraft({
    businessId: business.id,
    userId: owner.id,
    type: 'cashbook',
    payload: { kind: 'cash_count', amount: 500000, occurredOn: cairoIsoDay(new Date()), expectedCash: 0, note: 'تجربة' },
    summary: 'جرد الخزنة',
    idempotencyKey: key(),
  })
  const countRes = await executeOperation(count.id, owner.id, 'تجربة')
  expect(countRes.outcome.ok).toBe(true)
})
afterAll(async () => {
  await db.business.delete({ where: { id: business.id } })
})

test('approval births item + supplier, books the open balance, and writes the IDs back', async () => {
  const draft = await newPurchase('زيت زيتون فاخر', 'مورد الزيوت', 36000, 20000)
  const cashBefore = await cashNet()
  const res = await executeOperation(draft.id, owner.id)
  expect(res.outcome.ok).toBe(true)

  const item = await db.item.findFirst({ where: { businessId: business.id, name: 'زيت زيتون فاخر' } })
  expect(item).not.toBeNull()
  expect(item!.stockQty).toBe(24)
  expect(item!.costPrice).toBe(1500)

  const sup = await db.supplier.findFirst({ where: { businessId: business.id, name: 'مورد الزيوت' } })
  expect(sup).not.toBeNull()
  expect(sup!.balance).toBe(16000) // total - paid, آجل للمورد

  expect(await cashNet()).toBe(cashBefore - 20000) // cash moved by PAID only

  const lot = await db.cashbookEntry.findFirst({ where: { businessId: business.id, operationRef: draft.ref } })
  expect(lot).not.toBeNull()
  expect(lot!.kind).toBe('credit_purchase')
  expect(lot!.openAmount).toBe(16000)
  expect(lot!.supplierId).toBe(sup!.id)

  const op = await db.operation.findUniqueOrThrow({ where: { id: draft.id } })
  const p = JSON.parse(op.payload) as Record<string, unknown>
  expect(p.itemId).toBe(item!.id) // resolved ID written back for reversal/audit
  expect(p.supplierId).toBe(sup!.id)
})

test('a second delivery of the same name reuses the item and supplier', async () => {
  const draft = await newPurchase('زيت زيتون فاخر', 'مورد الزيوت', 36000, 36000) // full cash this time
  const res = await executeOperation(draft.id, owner.id)
  expect(res.outcome.ok).toBe(true)

  expect(await db.item.count({ where: { businessId: business.id, name: 'زيت زيتون فاخر' } })).toBe(1)
  expect(await db.supplier.count({ where: { businessId: business.id, name: 'مورد الزيوت' } })).toBe(1)
  const item = await db.item.findFirst({ where: { businessId: business.id, name: 'زيت زيتون فاخر' } })
  expect(item!.stockQty).toBe(48)
  // full cash → no NEW debt lot for this ref
  const lots = await db.cashbookEntry.findMany({ where: { businessId: business.id, operationRef: draft.ref } })
  expect(lots.length).toBe(0)
})

test('reversal restores stock, supplier balance, cash and closes the debt lot', async () => {
  const draft = await newPurchase('جبنة قديمة', 'مورد الألبان', 30000, 10000)
  const res = await executeOperation(draft.id, owner.id)
  expect(res.outcome.ok).toBe(true)

  const cashBefore = await cashNet()
  const item = await db.item.findFirst({ where: { businessId: business.id, name: 'جبنة قديمة' } })
  const sup = await db.supplier.findFirst({ where: { businessId: business.id, name: 'مورد الألبان' } })
  const lot = await db.cashbookEntry.findUniqueOrThrow({ where: { operationRef: draft.ref } })
  expect(item!.stockQty).toBe(24)
  expect(sup!.balance).toBe(20000)

  const rev = await createDraft({
    businessId: business.id,
    userId: owner.id,
    type: 'reversal',
    payload: { originalRef: draft.ref },
    summary: `عكس العملية ${draft.ref}`,
    idempotencyKey: key(),
  })
  const revRes = await executeOperation(rev.id, owner.id, 'عكس تجريبي')
  expect(revRes.outcome.ok).toBe(true)

  expect((await db.item.findUniqueOrThrow({ where: { id: item!.id } })).stockQty).toBe(0)
  expect((await db.supplier.findUniqueOrThrow({ where: { id: sup!.id } })).balance).toBe(0)
  expect(await cashNet()).toBe(cashBefore + 10000) // paid refunded
  expect((await db.cashbookEntry.findUniqueOrThrow({ where: { operationRef: draft.ref } })).openAmount).toBe(0)
  const original = await db.operation.findUniqueOrThrow({ where: { id: draft.id } })
  expect(original.reversedByRef).toBe(rev.ref)
})
