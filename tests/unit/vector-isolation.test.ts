import { expect, test } from 'bun:test'
import type { AgentMemory } from '@prisma/client'
import { LocalVectorDB } from '@/lib/agent/vector-memory'
const memory = (id: string, userId: string, businessId = 'biz'): AgentMemory => ({ id, userId, businessId, entityRef: null, kind: 'rule', category: 'stock', text: `مخزون خاص ${id}`, active: true, confidence: 100, usageCount: 0, createdAt: new Date(), updatedAt: new Date() })

test('parallel same-tenant semantic recall is actor scoped even with mixed caller rows', async () => {
  const index = new LocalVectorDB()
  const rows = [memory('a-private', 'a'), memory('b-private', 'b'), memory('other-tenant', 'a', 'foreign')]
  const [a, b] = await Promise.all(['a', 'b'].map((userId) => index.searchSemantic({ businessId: 'biz', userId, query: 'مخزون', memories: rows })))
  expect(a.map((r) => r.doc.id)).toEqual(['a-private'])
  expect(b.map((r) => r.doc.id)).toEqual(['b-private'])
})
test('no actor scope means no personal recall, not all business memories', async () => {
  const index = new LocalVectorDB()
  expect(await index.searchSemantic({ businessId: 'biz', query: 'مخزون', memories: [memory('secret', 'a')] })).toEqual([])
})
test('forget/deactivation removes a cached memory on the next supplied snapshot', async () => {
  const index = new LocalVectorDB()
  const row = memory('forget-me', 'a')
  expect((await index.searchSemantic({ businessId: 'biz', userId: 'a', query: 'مخزون', memories: [row] })).length).toBe(1)
  expect(await index.searchSemantic({ businessId: 'biz', userId: 'a', query: 'مخزون', memories: [{ ...row, active: false }] })).toEqual([])
  const result = await index.buildVectorContextBlock({ businessId: 'biz', userId: 'a', query: 'مخزون', memories: [] })
  expect(result.promptBlock).toBe('')
})
