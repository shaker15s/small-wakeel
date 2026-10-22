import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { Business, User } from '@prisma/client'
import { runAgentTurn } from '@/lib/agent/harness'
import { createNewBusinessWithDefaults } from '@/lib/domain/business-builder'
import { cashbookCash } from '@/lib/domain/cashbook'
import { cairoIsoDay } from '@/app/api/_lib/dates'
import { createDraft, executeOperation } from '@/lib/domain/executors'
import { testDb } from '../helpers/test-db'

let db: Awaited<ReturnType<typeof testDb>>
let business: Business
let owner: User
let businessId = ''
let conversationId = ''
let openingCountRef = ''
let previousOffline: string | undefined

beforeAll(async () => {
  previousOffline = process.env.WAKIL_OFFLINE
  process.env.WAKIL_OFFLINE = '1'
  db = await testDb()

  const created = await createNewBusinessWithDefaults({
    name: `offline-expense-${randomUUID()}`,
    type: 'supermarket',
    skipDefaultSeeds: true,
  })
  businessId = created.id
  business = await db.business.findUniqueOrThrow({ where: { id: businessId } })
  owner = await db.user.findFirstOrThrow({ where: { businessId, role: 'owner' } })
  const conversation = await db.conversation.create({
    data: { businessId, userId: owner.id, title: 'Offline cashbook expense regression' },
  })
  conversationId = conversation.id

  // Cash-out drafts cannot claim an unknown cash balance. Establish a synthetic,
  // owner-reviewed opening count so the test exercises the actual approval path.
  const count = await createDraft({
    businessId,
    userId: owner.id,
    type: 'cashbook',
    summary: 'Synthetic opening cash count for test',
    idempotencyKey: `opening-count-${randomUUID()}`,
    payload: {
      kind: 'cash_count',
      amount: 500_000,
      expectedCash: 0,
      expectedCashKnown: false,
      occurredOn: cairoIsoDay(new Date()),
      note: 'Synthetic test baseline only',
    },
  })
  openingCountRef = count.ref
  const applied = await executeOperation(count.id, owner.id, 'Synthetic test baseline')
  expect(applied.outcome.ok).toBe(true)
})

afterAll(async () => {
  if (businessId) await db.business.deleteMany({ where: { id: businessId } })
  if (previousOffline === undefined) delete process.env.WAKIL_OFFLINE
  else process.env.WAKIL_OFFLINE = previousOffline
  await db.$disconnect?.()
})

describe('offline Arabic cashbook expense draft contract', () => {
  test('«ضيف مصروف ٣٣ جنيه بند صيانة» creates one pending cashbook expense of 3300 piastres', async () => {
    const cashBefore = await db.$transaction(tx => cashbookCash(tx, businessId))
    const cashEntriesBefore = await db.cashEntry.count({ where: { businessId } })
    const cashbookEntriesBefore = await db.cashbookEntry.count({ where: { businessId } })
    const emitted: { event?: string; card?: { type?: string; opId?: string } }[] = []

    await runAgentTurn(
      {
        business,
        user: owner,
        conversationId,
        modelKey: null,
        text: 'ضيف مصروف ٣٣ جنيه بند صيانة',
        history: [],
      },
      (event) => emitted.push(event),
    )

    const operations = await db.operation.findMany({
      where: { businessId, userId: owner.id, conversationId },
      orderBy: { createdAt: 'asc' },
    })
    expect(operations).toHaveLength(1)
    const op = operations[0]
    const payload = JSON.parse(op.payload) as Record<string, unknown>
    expect(op.type).toBe('cashbook')
    expect(op.status).toBe('AWAITING_APPROVAL')
    expect(payload).toMatchObject({
      kind: 'expense',
      amount: 3300,
      reason: 'صيانة',
      dateSource: 'assumed_today',
    })
    expect(emitted.some((event) => event.event === 'card' && event.card?.type === 'cashbook' && event.card?.opId === op.id)).toBe(true)

    // A draft is not a write to either the money ledger or the cashbook ledger.
    expect(await db.cashEntry.count({ where: { businessId } })).toBe(cashEntriesBefore)
    expect(await db.cashbookEntry.count({ where: { businessId } })).toBe(cashbookEntriesBefore)
    expect(await db.$transaction(tx => cashbookCash(tx, businessId))).toBe(cashBefore)
    expect(await db.cashbookEntry.count({ where: { operationRef: op.ref } })).toBe(0)

    const applied = await executeOperation(op.id, owner.id, 'Approve synthetic cashbook expense')
    expect(applied.op.status).toBe('SUCCEEDED')
    expect(applied.outcome.ok).toBe(true)
    const entry = await db.cashbookEntry.findUniqueOrThrow({ where: { operationRef: op.ref } })
    expect(entry).toMatchObject({ kind: 'expense', amount: 3300, cashDelta: -3300, dateSource: 'assumed_today' })
    expect(await db.cashEntry.count({ where: { businessId, ref: op.ref } })).toBe(1)
    expect(await db.cashbookEntry.count({ where: { operationRef: op.ref } })).toBe(1)
    expect(await db.$transaction(tx => cashbookCash(tx, businessId))).toBe(cashBefore - 3300)
  })
})
