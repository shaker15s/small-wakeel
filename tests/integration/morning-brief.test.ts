// «ابدأ يومك» — the agent's opening move must be TRUE and ACTIONABLE.
//
// The owner's complaint «مش مساعد كفايه» is answered by a card that starts the
// day for him. A wrong number there is worse than no card at all, so this test
// pins the brief to the ledger: the biggest receivable is the one it names, the
// money it quotes is the balance in the database, and every prompt it offers is
// a sentence the intent engine actually understands (not a dead button).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
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

  test('the collection prompt quotes the balance exactly (owned fixture)', async () => {
    // A fixture big enough to win the ranking, so the assertion cannot race
    // with other test files writing to the shared database copy.
    const fixture = await db.customer.create({
      data: { businessId: business.id, name: 'زبون اختبار الميزانية', balance: 9_999_900 },
    })
    try {
      const brief = await buildMorningBrief(business.id)
      const collect = brief.items.find((i: { id: string }) => i.id.startsWith('collect:'))
      expect(collect).toBeDefined()
      expect(collect.id).toBe(`collect:${fixture.id}`)
      // «حصلت ٩٩٬٩٩٩ من زبون اختبار الميزانية» — the number is the balance
      expect(String(collect.cta.prompt)).toContain('٩٩٬٩٩٩')
      expect(String(collect.cta.prompt)).toContain('زبون اختبار الميزانية')
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
      // a collection prompt must draft a collection, not merely look at data
      if (item.id.startsWith('collect:')) {
        expect(intent.opType).toBe('collection')
      }
    }
  })
})
