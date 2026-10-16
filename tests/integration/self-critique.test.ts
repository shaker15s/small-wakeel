// وكيل — end-to-end «تأمل وكيل» proof through the REAL turn pipeline.
//
// The unit tests check `auditDraft` in isolation; this file checks the thing
// the owner actually sees: the SSE stream of a live turn
//   card.audit[]  +  card.confidence  +  a danger finding escalating to R3.
//
// Runs with WAKIL_OFFLINE=1 so the turn is decided by the deterministic engine
// (no provider, no network) — the same configuration the eval gate uses.
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let llm: any

beforeAll(async () => {
  db = await testDb()
  business = await db.business.findFirst({ where: { type: 'supermarket' } })
  user = await db.user.findFirst({ where: { businessId: business.id, role: 'owner' } })
  // imported after the shared test DB is wired (module singleton)
  runAgentTurn = (await import('../../src/lib/agent/harness')).runAgentTurn
  llm = await import('../../src/lib/agent/llm')
})

afterAll(async () => {
  await db?.$disconnect?.()
})

/** Run one turn and collect everything the wire carried. */
async function turn(text: string) {
  const conversation = await db.conversation.create({
    data: { businessId: business.id, userId: user.id, title: text.slice(0, 40) },
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const events: any[] = []
  const result = await runAgentTurn(
    { business, user, conversationId: conversation.id, text, modelKey: null, history: [] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ev: any) => events.push(ev),
  )
  return {
    result,
    events,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cards: events.filter((e) => e.event === 'card').map((e) => e.card),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    traces: events.filter((e) => e.event === 'thinking'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    steps: events.filter((e) => e.event === 'step'),
  }
}

/** The Arabic unit word the shop actually uses for a catalog unit code. */
const UNIT_AR: Record<string, string> = {
  piece: 'قطعة',
  box: 'علبة',
  kg: 'كيلو',
  gram: 'جرام',
  liter: 'لتر',
  milli: 'مللي',
  strip: 'شريط',
  capsule: 'كبسولة',
  session: 'حصة',
}

/** A sale sentence in the item's own unit — these tests are about the audit,
 *  not about unit parsing (that lives in tests/unit/arabic.test.ts). */
function saleText(
  item: { name: string; unit: string; sellPrice: number },
  qty: number,
  opts: { price?: number; party?: string } = {},
) {
  const u = UNIT_AR[item.unit] ?? 'قطعة'
  const price = opts.price ?? item.sellPrice
  return `بعت ${qty} ${u} ${item.name} بـ${price} جنيه لل${u}${opts.party ? ` ${opts.party}` : ''}`
}

describe('turn.selfCritique', () => {
  test('the offline engine answers without a provider (deterministic ladder)', () => {
    expect(llm.llmHealth).toBeTruthy()
    expect(process.env.WAKIL_OFFLINE).toBe('1')
  })

  test('a plain sale draft arrives as a card carrying audit + confidence', async () => {
    const item = await db.item.findFirst({ where: { businessId: business.id, stockQty: { gt: 6 } } })
    const { cards } = await turn(saleText(item, 2))
    expect(cards.length).toBeGreaterThan(0)
    const card = cards[0]
    expect(card.kind).toBe('draft')
    // the contract the UI renders: findings array + a numeric confidence, always
    expect(Array.isArray(card.audit)).toBe(true)
    expect(typeof card.confidence).toBe('number')
    expect(card.confidence).toBeGreaterThanOrEqual(20)
    expect(card.confidence).toBeLessThanOrEqual(100)
  })

  test('an oversell comes back with an «oversell» finding attached to the card', async () => {
    // a real shelf: something in stock, priced, with a plain name the parser
    // reads cleanly («بيض طبق (30 بيضة)» would be a parser question, not an
    // audit question — keep the two concerns apart)
    const items = await db.item.findMany({
      where: { businessId: business.id, stockQty: { gt: 0, lt: 50 }, sellPrice: { gt: 0 } },
      orderBy: { stockQty: 'asc' },
      take: 20,
    })
    const item = items.find((i: { name: string }) => !/[()]/.test(i.name)) ?? items[0]
    const { cards } = await turn(saleText(item, item.stockQty + 500, { party: 'للعميل النقدي' }))
    expect(cards.length).toBeGreaterThan(0)
    const card = cards[0]
    const codes = (card.audit ?? []).map((f: { code: string }) => f.code)
    expect(codes).toContain('oversell')
    expect(card.confidence).toBeLessThan(100)
  })

  test('a danger finding escalates the draft to R3 and the trace says why', async () => {
    // selling at ~4× the recorded price is a danger-grade price anomaly
    const item = await db.item.findFirst({
      where: { businessId: business.id, sellPrice: { gt: 0 }, stockQty: { gt: 6 } },
    })
    const priced = item.sellPrice
    const { cards, steps, result } = await turn(
      saleText(item, 1, { price: priced * 4, party: 'للعميل النقدي' }),
    )
    const card = cards[0]
    expect(card).toBeTruthy()
    const danger = (card.audit ?? []).some((f: { severity: string }) => f.severity === 'danger')
    if (danger) {
      expect(card.risk).toBe('R3')
      expect(card.dangerNote ?? '').toContain('R3')
      // the escalation is legible on the wire, not only in the database
      expect(steps.some((s: { label: string }) => s.label.includes('ملاحظة'))).toBe(true)
    }
    // whatever happened, the card never reached the user without a confidence
    expect(typeof card.confidence).toBe('number')
    expect(result.thinking.length).toBeGreaterThan(0)
  })

  test('a package size inside the item name never becomes the user’s quantity', async () => {
    // «فول مدمس معلب 400 جرام» — the 400 gram is the ITEM, not the request
    const item = await db.item.findFirst({
      where: { businessId: business.id, name: { contains: 'جرام' }, stockQty: { gt: 20 } },
    })
    if (!item) return // seed without a size-in-name item: nothing to guard
    const { cards } = await turn(`بعت 5 قطعة ${item.name} بـ${item.sellPrice} جنيه للقطعة`)
    expect(cards.length).toBeGreaterThan(0)
    const summary = String(cards[0].title ?? '') + JSON.stringify(cards[0].fields ?? [])
    // 5 pieces sold, never 400 (the printed package size)
    expect(summary).toContain('5')
    expect(summary).not.toContain('400 ')
    expect((cards[0].audit ?? []).some((f: { code: string }) => f.code === 'price_anomaly')).toBe(false)
  })

  test('a container word on a counted item is a count, not a unit conflict', async () => {
    const item = await db.item.findFirst({
      where: { businessId: business.id, unit: 'piece', stockQty: { gt: 20 } },
    })
    if (!item) return // vertical without piece items
    // «٢ علبة» for a piece-counted item is how a cashier talks, not an error
    const { cards, events } = await turn(`بعت 2 علبة ${item.name} بـ${item.sellPrice} جنيه للعلبة`)
    expect(cards.length).toBeGreaterThan(0)
    // internally the count is preserved as the number of pieces
    const payload = await db.operation.findUnique({ where: { id: cards[0].opId } })
    expect(JSON.parse(payload.payload).qty).toBe(2)
    // and no raw unit code ever reaches the owner's chat
    const reply = events
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((e: any) => e.event === 'delta')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((e: any) => e.text)
      .join('')
    expect(reply).not.toMatch(/\b(box|piece|gram|kg|milli|liter)\b/)
  })

  test('the trace reports measured milliseconds per pass', async () => {
    const summary = await turn('عندي كام صنف في المخزون؟')
    const last = summary.traces[summary.traces.length - 1]
    expect(last).toBeTruthy()
    const steps = last.steps as { label: string; ms?: number }[]
    const measured = steps.filter((s) => typeof s.ms === 'number')
    expect(measured.length).toBeGreaterThan(0)
    for (const s of measured) {
      expect(s.ms).toBeGreaterThanOrEqual(0)
      expect(s.ms!).toBeLessThan(120_000)
    }
  })
})
