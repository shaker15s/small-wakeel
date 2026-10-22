import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { Business } from '@prisma/client'
import { VERTICALS } from '@/lib/verticals'
import { createDraft, executeOperation } from '@/lib/domain/executors'
import { testDb } from '../helpers/test-db'

let db: Awaited<ReturnType<typeof testDb>>
const businessIds: string[] = []
const unique = () => `sector-sale-${randomUUID()}`

beforeAll(async () => {
  db = await testDb()
})

afterAll(async () => {
  if (businessIds.length) await db.business.deleteMany({ where: { id: { in: businessIds } } })
  await db.$disconnect?.()
})

describe('core sale accounting across the ten sector profiles', () => {
  test('drafts do not mutate money/stock; approval applies one verified sale in every sector', async () => {
    for (const sector of Object.keys(VERTICALS) as Array<keyof typeof VERTICALS>) {
      const business: Business = await db.business.create({
        data: { name: unique(), type: sector },
      })
      businessIds.push(business.id)
      const owner = await db.user.create({
        data: { businessId: business.id, name: 'Synthetic owner', role: 'owner' },
      })
      const item = await db.item.create({
        data: {
          businessId: business.id,
          name: `Synthetic item ${sector}`,
          unit: VERTICALS[sector].units[0] ?? 'piece',
          stockQty: 10,
          sellPrice: 100,
          costPrice: 50,
        },
      })

      const draft = await createDraft({
        businessId: business.id,
        userId: owner.id,
        type: 'sale',
        summary: `Acceptance sale: ${sector}`,
        payload: { itemId: item.id, qty: 2, total: 200 },
        idempotencyKey: unique(),
      })

      expect(draft.status, `${sector}: sale should be a draft until approval`).toBe('AWAITING_APPROVAL')
      expect((await db.item.findUniqueOrThrow({ where: { id: item.id } })).stockQty)
        .toBe(10)
      expect(await db.cashEntry.count({ where: { businessId: business.id, ref: draft.ref }))
        .toBe(0)

      const approved = await executeOperation(draft.id, owner.id)
      expect(approved.op.status, `${sector}: approved sale status`).toBe('SUCCEEDED')
      expect(approved.outcome.ok, `${sector}: deterministic verification`).toBe(true)
      expect(approved.outcome.checks.length, `${sector}: verification evidence`).toBeGreaterThan(0)
      expect(approved.outcome.checks.every((check) => check.pass), `${sector}: all checks pass`).toBe(true)
      expect((await db.item.findUniqueOrThrow({ where: { id: item.id } })).stockQty)
        .toBe(8)
      expect(await db.cashEntry.count({ where: { businessId: business.id, ref: draft.ref }))
        .toBe(1)
      expect(await db.auditEvent.count({ where: { businessId: business.id, ref: draft.ref, action: 'operation.succeeded' }))
        .toBe(1)
    }
  })
})
