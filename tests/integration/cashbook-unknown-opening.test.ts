import { afterAll, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { testDb } from '../helpers/test-db'
import { createNewBusinessWithDefaults } from '@/lib/domain/business-builder'
import { answerProfile } from '@/lib/domain/onboarding-profile'
import { cashPositionEvidence, cashbookCash, validateCashbook } from '@/lib/domain/cashbook'
import { cashbookTurn } from '@/lib/agent/cashbook'
import { executeOperation } from '@/lib/domain/executors'
import { cairoIsoDay } from '@/app/api/_lib/dates'

const db = await testDb()
const businessIds: string[] = []

async function shop(options: { openingCashEgp?: number; omitOpeningCash?: boolean } = {}) {
  const created = await createNewBusinessWithDefaults({
    name: `cash-knownness-${randomUUID()}`,
    type: 'supermarket',
    ...(options.omitOpeningCash ? {} : options.openingCashEgp !== undefined ? { openingCashEgp: options.openingCashEgp } : {}),
  })
  businessIds.push(created.id)
  const business = await db.business.findUniqueOrThrow({ where: { id: created.id } })
  const user = await db.user.findUniqueOrThrow({ where: { id: created.users[0].id } })
  const conversation = await db.conversation.create({
    data: { businessId: business.id, userId: user.id, title: 'Cash balance knownness' },
  })
  return { business, user, conversationId: conversation.id }
}

afterAll(async () => {
  if (businessIds.length) await db.business.deleteMany({ where: { id: { in: businessIds } } })
})

test('a schema-default zero is unknown; an explicitly stated zero is known', async () => {
  const blank = await shop({ omitOpeningCash: true })
  const before = await db.$transaction(tx => cashPositionEvidence(tx, blank.business.id))
  expect(blank.business.openingCash).toBe(0)
  expect(before.openingCashKnown).toBe(false)
  expect(before.currentCashKnown).toBe(false)
  expect(before.cash).toBeNull()
  expect(before.ledgerCash).toBe(0)

  const statedZero = await shop({ openingCashEgp: 0 })
  const stated = await db.$transaction(tx => cashPositionEvidence(tx, statedZero.business.id))
  expect(stated.openingCashKnown).toBe(true)
  expect(stated.currentCashKnown).toBe(true)
  expect(stated.cash).toBe(0)
  const profile = await db.businessProfile.findUniqueOrThrow({ where: { businessId: statedZero.business.id } })
  expect(profile.openingCashStatedAt).toBeTruthy()
  expect(JSON.parse(profile.answers)).toMatchObject({
    openingCash: { value: 0, source: 'owner', skipped: false },
  })

  // Onboarding's explicit skip stays unknown even though the DB still stores zero.
  const skipped = await answerProfile(blank.business.id, 'openingCash', null, { skip: true })
  expect(skipped.openingCashStatedAt).toBeNull()
  const afterSkip = await db.$transaction(tx => cashPositionEvidence(tx, blank.business.id))
  expect(afterSkip.cash).toBeNull()
  expect(afterSkip.currentCashKnown).toBe(false)
})

test('the first approved count establishes a baseline; later count deltas stay separate from receipts/payments', async () => {
  const ctx = await shop({ omitOpeningCash: true })
  const initial = await db.$transaction(tx => cashPositionEvidence(tx, ctx.business.id))
  expect(initial.cash).toBeNull()

  const first = await cashbookTurn({
    ...ctx, turnId: randomUUID(), text: 'باقي في الخزنة ٢٥٠٠', history: [],
  }, () => {})
  expect(first?.card?.type).toBe('cashbook')
  expect(first?.card?.status).toBe('AWAITING_APPROVAL')
  const firstOp = await db.operation.findUniqueOrThrow({ where: { id: first!.opId! } })
  expect(JSON.parse(firstOp.payload)).toMatchObject({
    kind: 'cash_count', amount: 250000, expectedCash: 0, expectedCashKnown: false,
  })
  expect((await db.$transaction(tx => cashPositionEvidence(tx, ctx.business.id))).cash).toBeNull()

  const firstResult = await executeOperation(firstOp.id, ctx.user.id)
  expect(firstResult.outcome.ok).toBe(true)
  const firstPosition = await db.$transaction(tx => cashPositionEvidence(tx, ctx.business.id))
  expect(firstPosition.openingCashKnown).toBe(false)
  expect(firstPosition.currentCashKnown).toBe(true)
  expect(firstPosition.cash).toBe(250000)
  expect(firstPosition.cashIn).toBe(0)
  expect(firstPosition.cashOut).toBe(0)
  expect(firstPosition.cashCountAdjustment).toBe(0)
  expect((await db.cashEntry.findFirstOrThrow({ where: { ref: firstOp.ref } })).reason).toContain('أول عدّ')

  const second = await cashbookTurn({
    ...ctx, turnId: randomUUID(), text: 'باقي في الخزنة ٢٦٠٠', history: [],
  }, () => {})
  const secondOp = await db.operation.findUniqueOrThrow({ where: { id: second!.opId! } })
  expect(JSON.parse(secondOp.payload)).toMatchObject({
    kind: 'cash_count', amount: 260000, expectedCash: 250000, expectedCashKnown: true,
  })
  const secondResult = await executeOperation(secondOp.id, ctx.user.id)
  expect(secondResult.outcome.ok).toBe(true)
  const afterSecond = await db.$transaction(tx => cashPositionEvidence(tx, ctx.business.id))
  expect(afterSecond.cash).toBe(260000)
  expect(afterSecond.cashIn).toBe(0)
  expect(afterSecond.cashOut).toBe(0)
  expect(afterSecond.cashCountAdjustment).toBe(10000)
})

test('cash outflow is not compared with a fictional zero baseline', async () => {
  const ctx = await shop({ omitOpeningCash: true })
  await expect(db.$transaction(tx => validateCashbook(tx, ctx.business.id, {
    kind: 'expense',
    amount: 100,
    occurredOn: cairoIsoDay(new Date()),
    reason: 'كهرباء',
    note: 'اختبار آمن على قاعدة اصطناعية',
  }))).rejects.toThrow('رصيد الخزنة غير معروف')
  expect(await db.cashEntry.count({ where: { businessId: ctx.business.id } })).toBe(0)
  expect((await db.$transaction(tx => cashPositionEvidence(tx, ctx.business.id))).cash).toBeNull()
})
