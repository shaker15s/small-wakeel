// «بعت كام …؟» — the owner asks for ONE NUMBER.
//
// Live R31: «بعت كام علبة لبن الشهر ده؟» answered with «آخر الحركات» (eight
// rows). The fix is a deterministic period aggregate that must match the ledger
// exactly — these tests compute the expected sum from the database itself.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { testDb } from '../helpers/test-db'

process.env.WAKIL_OFFLINE = '1'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let runAgentTurn: any
let business: { id: string; type: string }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let user: any

beforeAll(async () => {
  db = await testDb()
  business = await db.business.findFirst({ where: { type: 'supermarket' } })
  user = await db.user.findFirst({ where: { businessId: business.id, role: 'owner' } })
  runAgentTurn = (await import('../../src/lib/agent/harness')).runAgentTurn
})

afterAll(async () => {
  await db?.$disconnect?.()
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function turn(text: string): Promise<{ cards: any[]; reply: string }> {
  const conversation = await db.conversation.create({
    data: { businessId: business.id, userId: user.id, title: text.slice(0, 40) },
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const events: any[] = []
  const result = await runAgentTurn({ business, user, conversationId: conversation.id, text, modelKey: null, history: [] }, (ev: unknown) =>
    events.push(ev),
  )
  // a single-value read arrives as `cards` (array), a draft as `card`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cards = events.filter((e) => e.event === 'card').map((e) => e.card)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const e of events.filter((x) => x.event === 'cards')) cards.push(...(e.cards ?? []))
  return { cards, reply: String(result.replyText ?? '') }
}

const flat = (x: string) => x.replace(/\s+/g, ' ').trim()

describe('period totals — بيع/شرا/مصروف/تحصيل في فترة', () => {
  test('«بعت كام <صنف> الشهر ده؟» answers with the ledger sum, not a list', async () => {
    const item = await db.item.findFirst({ where: { businessId: business.id, name: { contains: 'سكر' } } })
    const from = new Date(Date.now() - 30 * 86400000)
    const sales = await db.operation.findMany({
      where: { businessId: business.id, status: 'SUCCEEDED', type: 'sale', createdAt: { gte: from } },
    })
    const expected = sales
      .filter((o: { payload: string }) => o.payload.includes(item.name))
      .reduce((sum: number, o: { payload: string }) => {
        const p = JSON.parse(o.payload)
        const total = Number(p.total ?? p.amount ?? 0)
        const lines = Array.isArray(p.lines) ? p.lines : []
        const lineSum = lines.reduce(
          (s: number, l: { total?: number; unitPrice?: number; qty?: number }) => s + Number(l.total ?? (l.unitPrice ?? 0) * (l.qty ?? 0)),
          0,
        )
        return sum + (total > 0 ? total : lineSum)
      }, 0)

    const { cards } = await turn('بعت كام كيلو سكر الشهر ده؟')
    expect(cards.length).toBeGreaterThan(0)
    expect(cards[0].kind).toBe('kv')
    expect(flat(String(cards[0].title))).toContain('مبيعات')
    const body = JSON.stringify(cards[0])
    // the number the owner sees must be the number in the ledger
    if (expected > 0) {
      const egp = new Intl.NumberFormat('ar-EG', { style: 'currency', currency: 'EGP', maximumFractionDigits: 0 }).format(expected / 100)
      expect(body.includes(egp) || body.includes(new Intl.NumberFormat('ar-EG').format(expected / 100))).toBe(true)
    }
  })

  test('a question never produces a draft', async () => {
    const { cards } = await turn('صرفت كام النهارده؟')
    expect(cards.every((c: { kind: string }) => c.kind !== 'draft')).toBe(true)
  })

  test('a plain command still drafts (no over-correction)', async () => {
    const { cards } = await turn('صرفت ١٥٠ كهربا')
    expect(cards.some((c: { kind: string }) => c.kind === 'draft')).toBe(true)
  })
})
