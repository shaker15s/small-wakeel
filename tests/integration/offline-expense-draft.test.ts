import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Business, User } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { runAgentTurn } from '@/lib/agent/harness'
import { createNewBusinessWithDefaults } from '@/lib/domain/business-builder'
import { testDb } from '../helpers/test-db'

let db: Awaited<ReturnType<typeof testDb>>
let business: Business
let owner: User
let businessId = ''
let conversationId = ''
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
    data: { businessId, userId: owner.id, title: 'Offline expense regression' },
  })
  conversationId = conversation.id
})

afterAll(async () => {
  if (businessId) await db.business.deleteMany({ where: { id: businessId } })
  if (previousOffline === undefined) delete process.env.WAKIL_OFFLINE
  else process.env.WAKIL_OFFLINE = previousOffline
  await db.$disconnect?.()
})

describe('offline Arabic expense draft contract', () => {
  test('«ضيف مصروف ٣٣ جنيه بند صيانة» creates one pending expense with 3300 piastres', async () => {
    const emitted: unknown[] = []
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
    expect(operations[0].type).toBe('expense')
    expect(operations[0].status).toBe('AWAITING_APPROVAL')
    expect(JSON.parse(operations[0].payload)).toMatchObject({ total: 3300 })
    expect(await db.cashEntry.count({ where: { businessId } })).toBe(0)
    expect(emitted.some((event) => (event as { event?: string }).event === 'card')).toBe(true)
  })
})
