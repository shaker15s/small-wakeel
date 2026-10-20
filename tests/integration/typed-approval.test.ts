// وكيل — R68: typed-approval regression gate («اعملها»/«اعتمد»/«الغيها»).
//
// Pins the invariants the plan's P0 demands of the typed path — the same
// canonical domain path the confirm API uses, so a word can never become a
// bypass:
//   • approve executes exactly once (CAS) — a repeated word is a no-op
//   • R3 drafts refuse a typed word and keep the typed-reason flow
//   • the reject verb cancels without effects
//   • a turn with NO pending draft never enters the approve path
//   • foreign-conversation isolation: the pending op must be of THIS conversation
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { testDb } from '../helpers/test-db'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let harness: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let business: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let owner: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let otherBusiness: any
const emit = () => {}

beforeAll(async () => {
  db = await testDb()
  harness = await import('../../src/lib/agent/harness')
  business = await db.business.findFirst({ where: { type: 'supermarket' } })
  owner = await db.user.findFirst({ where: { businessId: business.id, role: 'owner' } })
  otherBusiness = await db.business.findFirst({ where: { type: 'gym' } })
})

afterAll(async () => {
  await db?.$disconnect?.()
})

async function freshConversation(title: string, biz = business, user = owner) {
  return db.conversation.create({ data: { businessId: biz.id, userId: user.id, title } })
}

async function draftSale(conv: { id: string }) {
  const item = await db.item.findFirst({ where: { businessId: business.id, stockQty: { gt: 10 } } })
  return harness
    .runAgentTurn(
      { business, user: owner, conversationId: conv.id, modelKey: null, text: 'بعت ٢ تونه تونك كاش', history: [] },
      emit,
    )
      .then(async (r) => {
        const op = await db.operation.findFirst({ where: { conversationId: conv.id, status: 'AWAITING_APPROVAL' } })
        if (!op || op.type !== 'sale') throw new Error(`no sale draft (reply: ${r.replyText})`)
        return op
      })
      .catch(async (e) => {
        // offline-deterministic fallbacks may phrase it differently — the op is the source of truth
        const op = await db.operation.findFirst({ where: { conversationId: conv.id, status: 'AWAITING_APPROVAL' } })
        if (op && op.type === 'sale') return op
        throw e
      })
}

async function typed(conv: { id: string }, text: string, history: { role: 'user' | 'assistant'; text: string }[] = []) {
  return harness.runAgentTurn(
    { business, user: owner, conversationId: conv.id, modelKey: null, text, history },
    emit,
  )
}

describe('integration.typed-approval (R68)', () => {
  test('«اعملها» executes the pending draft exactly once, verified', async () => {
    const conv = await freshConversation('R68 approve')
    const op = await draftSale(conv)
    const before = await db.cashEntry.count({ where: { ref: op.ref } })

    const r = await typed(conv, 'اعملها')
    expect(r.replyText).toContain('تم')
    const after = await db.operation.findUnique({ where: { id: op.id } })
    expect(after.status).toBe('SUCCEEDED')
    expect(after.executedAt).toBeDefined()
    // effects happened exactly once
    expect(await db.cashEntry.count({ where: { ref: op.ref } })).toBe(before + 1)
    // the result card carries the verified outcome
    expect(JSON.stringify(r.cards)).toContain('تم — موثّق ومتحقق')

    // a second «اعملها» is a safe no-op — nothing pending, nothing double-executed
    const r2 = await typed(conv, 'اعملها')
    expect(typeof r2.replyText).toBe('string')
    expect(await db.cashEntry.count({ where: { ref: op.ref } })).toBe(before + 1)
    expect(await db.operation.count({ where: { conversationId: conv.id, status: 'SUCCEEDED' } })).toBe(1)
  })

  test('R3 draft refuses a typed word — the typed-reason flow stays mandatory', async () => {
    const conv = await freshConversation('R68 R3')
    // An R2 sale is the common draft; force R3 through the domain directly so
    // the gate is about the RISK, not the item.
    const item = await db.item.findFirst({ where: { businessId: business.id, stockQty: { gt: 10 } } })
    const { createDraft } = await import('../../src/lib/domain/executors')
    const op = await createDraft({
      businessId: business.id,
      userId: owner.id,
      type: 'sale',
      summary: 'بيع حساس اختبار',
      risk: 'R3',
      conversationId: conv.id,
      idempotencyKey: `r68-r3-${Date.now()}`,
      payload: { itemId: item.id, qty: 1, total: item.sellPrice, paid: item.sellPrice },
    })
    expect(op.risk).toBe('R3')

    const r = await typed(conv, 'اعملها')
    expect(r.replyText).toContain('R3')
    expect(r.replyText).toMatch(/سبب/)
    const after = await db.operation.findUnique({ where: { id: op.id } })
    expect(after.status).toBe('AWAITING_APPROVAL') // untouched
  })

  test('«الغيها» cancels the pending draft without any effects', async () => {
    const conv = await freshConversation('R68 reject')
    const op = await draftSale(conv)
    const before = await db.cashEntry.count({ where: { ref: op.ref } })
    const r = await typed(conv, 'الغيها')
    expect(r.replyText).toContain('اتلغت')
    const after = await db.operation.findUnique({ where: { id: op.id } })
    expect(after.status).toBe('CANCELLED')
    expect(await db.cashEntry.count({ where: { ref: op.ref } })).toBe(before)
  })

  test('no pending draft — the approve word never fabricates an operation', async () => {
    const conv = await freshConversation('R68 no-pending')
    const r = await typed(conv, 'اعملها')
    expect(typeof r.replyText).toBe('string')
    expect(r.replyText.length).toBeGreaterThan(0)
    expect(await db.operation.count({ where: { conversationId: conv.id } })).toBe(0)
  })

  test('conversation isolation — a pending op of ANOTHER conversation is not approved', async () => {
    const convA = await freshConversation('R68 conv A')
    const convB = await freshConversation('R68 conv B')
    const op = await draftSale(convA)
    // speak in conv B while conv A has the pending draft
    const r = await typed(convB, 'اعملها')
    const after = await db.operation.findUnique({ where: { id: op.id } })
    expect(after.status).toBe('AWAITING_APPROVAL')
    expect(await db.operation.count({ where: { conversationId: convB.id, status: 'SUCCEEDED' } })).toBe(0)
    void r
  })

  test('foreign BUSINESS cannot approve through a word — tenant binding holds', async () => {
    // owner of business A drafts in A; the OTHER business's owner (foreign user)
    // is not the decider — the domain's requireBusinessUser refuses.
    const conv = await freshConversation('R68 tenant')
    const op = await draftSale(conv)
    const foreignOwner = await db.user.findFirst({ where: { businessId: otherBusiness.id, role: 'owner' } })
    if (!foreignOwner) throw new Error('no foreign owner in seed')
    await expect(
      harness.runAgentTurn(
        { business, user: foreignOwner, conversationId: conv.id, modelKey: null, text: 'اعملها', history: [] },
        emit,
      ),
    ).rejects.toBeInstanceOf(Error)
    const after = await db.operation.findUnique({ where: { id: op.id } })
    expect(after.status).toBe('AWAITING_APPROVAL')
  })
})
