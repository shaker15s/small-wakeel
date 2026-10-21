import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Business, User } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import type { PresetVertical } from '@/lib/types'
import { VERTICALS } from '@/lib/verticals'
import { testDb } from '../helpers/test-db'
import { createDraft, executeOperation } from '@/lib/domain/executors'

/**
 * Minimum end-to-end smoke, not proof that every sector-specific feature is
 * complete. For each advertised preset it verifies a real temporary-DB write:
 * draft -> explicit owner approval -> deterministic executor -> read-back ->
 * financial ledger + success audit. Gym uses membership, not a retail sale.
 * Expiry, grams/unit conversion, attendance, and other sector-specific paths
 * need separate, focused acceptance cases before being advertised as proven.
 */
const SECTORS: { key: PresetVertical; unit: string }[] = [
  { key: 'supermarket', unit: 'piece' },
  { key: 'gym', unit: 'session' },
  { key: 'pharmacy', unit: 'box' },
  { key: 'attar', unit: 'gram' },
  { key: 'restaurant', unit: 'cup' },
  { key: 'clinic', unit: 'visit' },
  { key: 'electronics', unit: 'piece' },
  { key: 'wholesale', unit: 'carton' },
  { key: 'clothing', unit: 'piece' },
  { key: 'tools', unit: 'roll' },
]

const key = () => randomUUID()
let db: Awaited<ReturnType<typeof testDb>>
let fixtures: Map<PresetVertical, { business: Business; owner: User }>
const businessIds: string[] = []

beforeAll(async () => {
  db = await testDb()
  fixtures = new Map()
  for (const sector of SECTORS) {
    const business = await db.business.create({
      data: { name: `E2E ${sector.key} ${key()}`, type: sector.key },
    })
    businessIds.push(business.id)
    const owner = await db.user.create({
      data: { businessId: business.id, name: `Synthetic owner ${key()}`, role: 'owner' },
    })
    fixtures.set(sector.key, { business, owner })
  }
})

afterAll(async () => {
  if (businessIds.length) await db.business.deleteMany({ where: { id: { in: businessIds } } })
  await db.$disconnect?.()
})

describe('sector end-to-end financial write smoke', () => {
  for (const sector of SECTORS) {
    test(`${sector.key}: one declared write reaches the verified ledger`, async () => {
      const fixture = fixtures.get(sector.key)
      expect(fixture).toBeDefined()
      const { business, owner } = fixture!
      const descriptor = VERTICALS[sector.key]
      let operationRef: string

      if (sector.key === 'gym') {
        expect(descriptor.tools).toContain('register_member')
        const name = `Synthetic member ${key()}`
        const draft = await createDraft({
          businessId: business.id,
          userId: owner.id,
          type: 'membership',
          summary: 'Synthetic gym membership end-to-end test',
          payload: { customerName: name, plan: 'شهرية', months: 1, total: 35_000, paid: 35_000 },
          idempotencyKey: key(),
        })
        operationRef = draft.ref
        expect(draft.status).toBe('AWAITING_APPROVAL')

        const result = await executeOperation(draft.id, owner.id)
        expect(result.op.status).toBe('SUCCEEDED')
        expect(result.outcome.ok).toBe(true)
        expect(result.outcome.checks.length).toBeGreaterThan(0)
        expect(result.outcome.checks.every((check) => check.pass)).toBe(true)

        const member = await db.customer.findFirstOrThrow({ where: { businessId: business.id, name } })
        expect(member.plan).toBe('شهرية')
        expect(member.expiresAt).toBeInstanceOf(Date)
        const entries = await db.cashEntry.findMany({ where: { businessId: business.id, ref: operationRef } })
        expect(entries).toHaveLength(1)
        expect(entries[0].direction).toBe('in')
        expect(entries[0].amount).toBe(35_000)
      } else {
        expect(descriptor.tools).toContain('record_sale')
        const item = await db.item.create({
          data: {
            businessId: business.id,
            name: `Synthetic ${sector.key} item ${key()}`,
            unit: sector.unit,
            stockQty: 100,
            sellPrice: 200,
            costPrice: 100,
          },
        })
        const draft = await createDraft({
          businessId: business.id,
          userId: owner.id,
          type: 'sale',
          summary: `Synthetic ${sector.key} sale end-to-end test`,
          payload: { itemId: item.id, qty: 2, total: 400, paid: 400 },
          idempotencyKey: key(),
        })
        operationRef = draft.ref
        expect(draft.status).toBe('AWAITING_APPROVAL')

        const result = await executeOperation(draft.id, owner.id)
        expect(result.op.status).toBe('SUCCEEDED')
        expect(result.outcome.ok).toBe(true)
        expect(result.outcome.checks.length).toBeGreaterThan(0)
        expect(result.outcome.checks.every((check) => check.pass)).toBe(true)

        const after = await db.item.findUniqueOrThrow({ where: { id: item.id } })
        expect(after.stockQty).toBe(98)
        const entries = await db.cashEntry.findMany({ where: { businessId: business.id, ref: operationRef } })
        expect(entries).toHaveLength(1)
        expect(entries[0].direction).toBe('in')
        expect(entries[0].amount).toBe(400)
      }

      expect(
        await db.auditEvent.count({ where: { businessId: business.id, ref: operationRef, action: 'operation.succeeded' } }),
      ).toBe(1)
    })
  }
})
