import { afterAll, beforeAll, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { Business, User } from '@prisma/client'
import { testDb } from '../helpers/test-db'
import { createNewBusinessWithDefaults } from '@/lib/domain/business-builder'
import { cashbookTurn } from '@/lib/agent/cashbook'
import { cashbookCash } from '@/lib/domain/cashbook'
import { executeOperation } from '@/lib/domain/executors'

const db = await testDb()
let business: Business | undefined
let owner: User | undefined

beforeAll(async () => {
  const created = await createNewBusinessWithDefaults({
    name: `general-mode-cashbook-${randomUUID()}`,
    type: 'supermarket',
  })
  // Reproduce a newly onboarded workspace in the default inventory workflow:
  // cashbook has not been explicitly activated, but clear cash commands still work.
  await db.business.update({ where: { id: created.id }, data: { workflowMode: 'inventory' } })
  business = await db.business.findUniqueOrThrow({ where: { id: created.id } })
  owner = await db.user.findUniqueOrThrow({ where: { id: created.users[0].id } })
})

afterAll(async () => {
  if (business) await db.business.delete({ where: { id: business.id } })
})

test('a clear drawer count drafts from general mode and mutates the ledger only after approval', async () => {
  const shop = business!
  const user = owner!
  expect(shop.workflowMode).toBe('inventory')
  const conversation = await db.conversation.create({
    data: { businessId: shop.id, userId: user.id, title: 'General mode cash count' },
  })
  const initialCash = await db.$transaction((tx) => cashbookCash(tx, shop.id))

  const result = await cashbookTurn({
    business: shop,
    user,
    conversationId: conversation.id,
    turnId: randomUUID(),
    text: 'باقي في الخزنة ٢٥٠٠',
    history: [],
  }, () => {})

  expect(result?.card?.type).toBe('cashbook')
  expect(result?.card?.title).toBe('عدّ الخزنة الفعلي')
  expect(result?.card?.status).toBe('AWAITING_APPROVAL')
  expect(result?.opId).toBeTruthy()
  expect(await db.$transaction((tx) => cashbookCash(tx, shop.id))).toBe(initialCash)
  expect(await db.cashbookEntry.count({ where: { businessId: shop.id, kind: 'cash_count' } })).toBe(0)
  expect(await db.operation.count({ where: { businessId: shop.id, type: 'sale' } })).toBe(0)

  const operation = await db.operation.findUniqueOrThrow({ where: { id: result!.opId! } })
  expect(operation.status).toBe('AWAITING_APPROVAL')
  expect(JSON.parse(operation.payload)).toMatchObject({
    kind: 'cash_count',
    amount: 250000,
    expectedCash: initialCash,
  })

  const executed = await executeOperation(operation.id, user.id)
  expect(executed.outcome.ok).toBe(true)
  expect((await db.cashbookEntry.findUniqueOrThrow({ where: { operationRef: operation.ref } })).kind).toBe('cash_count')
  expect(await db.operation.count({ where: { businessId: shop.id, type: 'sale' } })).toBe(0)
})
