import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { createNewBusinessWithDefaults } from '@/lib/domain/business-builder'
import { logAgentEvent, startTrace } from '@/lib/domain/agent-events'
import { testDb } from '../helpers/test-db'

let db: PrismaClient
let businessId: string | undefined
const createdBusinessIds: string[] = []

beforeAll(async () => {
  db = await testDb()
})

afterAll(async () => {
  if (createdBusinessIds.length) {
    await db.business.deleteMany({ where: { id: { in: createdBusinessIds } } })
  }
  await db?.$disconnect?.()
})

describe('local SQLite write concurrency and integrity', () => {
  test('parallel conversation writes and trace events finish with an intact database', async () => {
    const created = await createNewBusinessWithDefaults({
      name: `sqlite-integrity-${randomUUID()}`,
      type: 'supermarket',
    })
    businessId = created.id
    createdBusinessIds.push(created.id)
    const business = await db.business.findUniqueOrThrow({ where: { id: created.id } })
    const user = await db.user.findUniqueOrThrow({ where: { id: created.users[0].id } })
    const conversation = await db.conversation.create({
      data: { businessId: business.id, userId: user.id, title: 'SQLite integrity stress' },
    })
    const traceId = await startTrace({ businessId: business.id, conversationId: conversation.id })

    const before = await db.$queryRawUnsafe<Array<{ integrity_check: string }>>('PRAGMA integrity_check')
    expect(before[0]?.integrity_check).toBe('ok')

    // Match the overlapping writes made by a real agent turn: chat messages,
    // append-only trace rows and their shared WAL-backed database.
    await Promise.all([
      ...Array.from({ length: 80 }, (_, index) =>
        db.message.create({
          data: {
            id: `sqlite-stress-${randomUUID()}`,
            conversationId: conversation.id,
            role: index % 2 === 0 ? 'user' : 'assistant',
            text: `synthetic integrity probe ${index}`,
          },
        }),
      ),
      ...Array.from({ length: 80 }, (_, index) =>
        logAgentEvent({
          businessId: business.id,
          traceId,
          conversationId: conversation.id,
          type: 'tool.executed',
          actor: 'tool',
          payload: { probe: index, source: 'synthetic-only' },
        }),
      ),
    ])

    const after = await db.$queryRawUnsafe<Array<{ integrity_check: string }>>('PRAGMA integrity_check')
    expect(after[0]?.integrity_check).toBe('ok')
    expect(await db.message.count({ where: { conversationId: conversation.id } })).toBe(80)
    const trace = await db.$queryRawUnsafe<Array<{ count: number }>>(
      'SELECT COUNT(*) AS count FROM "AgentEvent" WHERE "businessId" = ? AND "traceId" = ?',
      business.id,
      traceId,
    )
    expect(Number(trace[0]?.count)).toBe(81)
  }, 30_000)
})
