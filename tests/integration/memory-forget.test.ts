// R76 / PR-008 — forget end to end through the REAL turn path:
// «انسى …» deactivates the memory row AND removes it from the vector index,
// and the reply honestly says what was (or wasn't) forgotten.
process.env.WAKIL_OFFLINE = '1'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { testDb } from '../helpers/test-db'
import { localVectorDB } from '@/lib/agent/vector-memory'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let harness: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let business: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let user: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let conv: any
let memoryId: string

beforeAll(async () => {
  db = await testDb()
  harness = await import('../../src/lib/agent/harness')
  business = await db.business.create({ data: { name: randomUUID(), type: 'supermarket' } })
  user = await db.user.create({ data: { businessId: business.id, name: 'owner', role: 'owner' } })
  conv = await db.conversation.create({ data: { businessId: business.id, userId: user.id } })
  const m = await db.agentMemory.create({
    data: { businessId: business.id, userId: user.id, kind: 'preference', category: 'habits', text: 'أم حسن بتسدد كل خميس', confidence: 85 },
  })
  memoryId = m.id
  // make sure the vector index KNOWS it (the forget must remove it from there)
  localVectorDB.upsertDocument({
    id: m.id, businessId: business.id, userId: user.id, kind: 'preference', category: 'habits',
    text: m.text, importance: 0.8, usageCount: 0, updatedAtMs: Date.now(),
  })
})

afterAll(async () => {
  await db.business.deleteMany({ where: { id: business.id } })
  await db.$disconnect?.()
})

describe('forget e2e (deterministic turn path)', () => {
  test('«انسى اللي عن خميس» deactivates the row, cleans the index, and says so', async () => {
    const out = await harness.runAgentTurn(
      { business, user, conversationId: conv.id, modelKey: null, text: 'انسى اللي عن خميس', history: [], turnId: randomUUID() },
      () => {},
    )
    expect(out.replyText).toContain('اتمسحت')

    const row = await db.agentMemory.findUnique({ where: { id: memoryId } })
    expect(row.active).toBe(false) // the row is deactivated

    // the index must not serve it anymore — force a fresh scope sync from
    // the ACTIVE rows and search: the forgotten memory is gone.
    const active = await db.agentMemory.findMany({ where: { businessId: business.id, userId: user.id, active: true } })
    const hits = await localVectorDB.searchSemantic({ businessId: business.id, userId: user.id, query: 'أم حسن خميس سداد', memories: active, topK: 5 })
    expect(hits.some((h: any) => h.doc.id === memoryId)).toBe(false)
  })

  test('forgetting something that was never saved is said honestly (no fake success)', async () => {
    const out = await harness.runAgentTurn(
      { business, user, conversationId: conv.id, modelKey: null, text: 'انسى اللي عن طائر نادر', history: [], turnId: randomUUID() },
      () => {},
    )
    expect(out.replyText).toContain('ملقيتش')
  })
})
