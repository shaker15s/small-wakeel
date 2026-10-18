// «ابدأ يومك» — the agent's opening move must be TRUE and ACTIONABLE.
//
// The owner's complaint «مش مساعد كفايه» is answered by a card that starts the
// day for him. A wrong number there is worse than no card at all, so this test
// pins the brief to the ledger: the biggest receivable is the one it names, the
// money it quotes is the balance in the database, and every prompt it offers is
// a sentence the intent engine actually understands (not a dead button).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { egp } from '@/lib/format'
import { testDb } from '../helpers/test-db'

process.env.WAKIL_OFFLINE = '1'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let buildMorningBrief: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ruleBasedIntentForTest: any
let business: { id: string; type: string }

beforeAll(async () => {
  db = await testDb()
  business = await db.business.findFirst({ where: { type: 'supermarket' } })
  const brief = await import('../../src/lib/agent/brief')
  buildMorningBrief = brief.buildMorningBrief
  ruleBasedIntentForTest = (await import('../../src/lib/agent/harness')).ruleBasedIntentForTest
})

afterAll(async () => {
  await db?.$disconnect?.()
})

describe('morning brief — البداية لازم تكون صح', () => {
  test('never more than three items, and they are ranked by money', async () => {
    const brief = await buildMorningBrief(business.id)
    expect(brief.items.length).toBeLessThanOrEqual(3)
    expect(brief.headline.length).toBeGreaterThan(0)
    const impacts = brief.items.map((i: { impact: number }) => i.impact)
    expect([...impacts].sort((a: number, b: number) => b - a)).toEqual(impacts)
  })

  test('balance review preserves exact piastres and does not assert a collection (owned fixture)', async () => {
    // A fixture big enough to win the ranking, so the assertion cannot race
    // with other test files writing to the shared database copy.
    const fixture = await db.customer.create({
      data: { businessId: business.id, name: 'زبون اختبار الميزانية', balance: 9_999_955 },
    })
    try {
      const brief = await buildMorningBrief(business.id)
      const collect = brief.items.find((i: { id: string }) => i.id.startsWith('collect:'))
      expect(collect).toBeDefined()
      expect(collect.id).toBe(`collect:${fixture.id}`)
      expect(collect.title).toContain(egp(fixture.balance))
      expect(collect.cta.prompt).not.toContain('حصلت')
      expect(collect.cta.label).toBe('راجع الحساب')
    } finally {
      await db.customer.delete({ where: { id: fixture.id } })
    }
  })

  test('every prompt is understood by the intent engine (no dead button)', async () => {
    const brief = await buildMorningBrief(business.id)
    for (const item of brief.items) {
      if (!item.cta.prompt) continue
      const intent = ruleBasedIntentForTest(item.cta.prompt, business.type)
      expect(intent.intent).not.toBe('chat')
      // A morning suggestion must never claim money has already been received.
      if (item.id.startsWith('collect:')) expect(intent.intent).toBe('read')
    }
  })
})
