// «الشبكة قطعت وأنا ببعت» — retrying a turn must never cost a second draft.
//
// Live R33: the composer kept only the TEXT of the last send. «جرّب تاني» then
// ran the whole turn again, and because every draft got a random idempotency
// key the owner ended up with two identical operations to approve. R34 sends a
// stable `turnId` with each message; the harness derives the key from it, so a
// retried turn finds the draft that already exists.
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
  // leave the demo clean however the assertions went
  await db?.operation?.deleteMany?.({ where: { idempotencyKey: { contains: ':r34test-' } } })
  await db?.$disconnect?.()
})

async function turn(text: string, turnId: string, conversationId?: string): Promise<string> {
  // A network retry is the SAME turn in the SAME conversation; making a new
  // conversation here would correctly produce a different draft, not test a retry.
  const conversation = conversationId
    ? await db.conversation.findFirstOrThrow({ where: { id: conversationId, businessId: business.id, userId: user.id } })
    : await db.conversation.create({
        data: { businessId: business.id, userId: user.id, title: text.slice(0, 40) },
      })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const events: any[] = []
  await runAgentTurn(
    { business, user, conversationId: conversation.id, text, modelKey: null, history: [], turnId },
    (ev: unknown) => events.push(ev),
  )
  return conversation.id
}

const newTurnId = () => `r34test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

describe('turn retry — نفس الرسالة مرتين = مسودة واحدة', () => {
  test('the same turnId never drafts the same operation twice', async () => {
    const turnId = newTurnId()
    const text = 'ضيف مصروف ٣٣ جنيه بند صيانة'
    const before = await db.operation.count({ where: { businessId: business.id } })

    const conversationId = await turn(text, turnId)
    const afterFirst = await db.operation.count({ where: { businessId: business.id } })
    await turn(text, turnId, conversationId)
    const afterRetry = await db.operation.count({ where: { businessId: business.id } })

    expect(afterFirst - before).toBe(1)
    expect(afterRetry - afterFirst).toBe(0)

    const rows = await db.operation.findMany({
      where: { businessId: business.id, idempotencyKey: { contains: turnId } },
      select: { id: true },
    })
    expect(rows.length).toBe(1)
  })

  test('two different turns still get two drafts', async () => {
    const before = await db.operation.count({ where: { businessId: business.id } })
    await turn('ضيف مصروف ١١ جنيه بند ماية', newTurnId())
    await turn('ضيف مصروف ١١ جنيه بند ماية', newTurnId())
    const after = await db.operation.count({ where: { businessId: business.id } })
    expect(after - before).toBe(2)
  })
})
