// وكيل — «الفلوس ما تتقراش غلط» — the money-parsing contract.
//
// Every case here is a sentence a real owner said during the R30/R31 walkthrough
// and got a WRONG draft from:
//   • «بعت ٢ لبن كرتونة لأم حسن»            → qty 1 at the catalog price
//   • «بعت لبن كرتونة لأم حسن بـ٩٠»          → qty 90 (the price read as quantity)
//   • «بعت كرتونة لبن لأحمد ودفع ١٠٠ بس»    → 100 boxes (the payment read as qty)
//   • «بعت ٢ كيلو جبنة رومي بـ٤٥٠ للكيلو»    → 450 total instead of 900
//
// These are not parser unit tests: they run the REAL turn pipeline offline and
// read the Operation payload the owner would approve. If any of them regresses,
// the agent is silently charging the wrong amount — the one thing a shop app
// can never get wrong.
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

/** Run one offline turn and return the draft's stored payload (what gets executed). */
async function draftPayload(text: string): Promise<Record<string, unknown> | null> {
  const conversation = await db.conversation.create({
    data: { businessId: business.id, userId: user.id, title: text.slice(0, 40) },
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const events: any[] = []
  await runAgentTurn({ business, user, conversationId: conversation.id, text, modelKey: null, history: [] }, (ev: unknown) =>
    events.push(ev),
  )
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const card = events.filter((e) => e.event === 'card').map((e) => e.card)[0]
  if (!card?.opId) return null
  const op = await db.operation.findUnique({ where: { id: card.opId }, select: { payload: true } })
  return op ? (JSON.parse(op.payload) as Record<string, unknown>) : null
}

const item = async (name: string) => db.item.findFirst({ where: { businessId: business.id, name: { contains: name } } })

describe('money parsing — الحقيقة من الجملة', () => {
  test('a bare quantity before the item is the quantity (not the model default 1)', async () => {
    const sugar = await item('سكر')
    const p = await draftPayload('بعت ٢ كيلو سكر لأم حسن')
    expect(p).not.toBeNull()
    expect(p!.qty).toBe(2)
    expect(p!.total).toBe(sugar.sellPrice * 2)
  })

  test('a price after the item is a price, never a quantity', async () => {
    const cheese = await item('جبنة رومي')
    const p = await draftPayload('بعت كيلو جبنة رومي لأم حسن بـ٢٠٠')
    expect(p).not.toBeNull()
    expect(p!.qty).toBe(1)
    expect(p!.total).toBe(20000)
    expect(p!.priceOverride).toBe(true)
    expect(p!.total).not.toBe(cheese.sellPrice)
  })

  test('a paid clause is money out of the ticket, never the quantity', async () => {
    const p = await draftPayload('بعت كيلو جبنة رومي لأم حسن ودفع ١٠٠ بس')
    expect(p).not.toBeNull()
    expect(p!.qty).toBe(1)
    expect(p!.paid).toBe(10000)
  })

  test('«للكيلو» marks a UNIT price — the total multiplies by the quantity', async () => {
    const p = await draftPayload('بعت ٢ كيلو جبنة رومي بـ٤٥٠ للكيلو لأم حسن')
    expect(p).not.toBeNull()
    expect(p!.qty).toBe(2)
    expect(p!.total).toBe(90000)
    expect(p!.unitPrice).toBe(45000)
  })
})
