// وكيل — due-task runner: one-shot must fire ONCE.
//
// R40 regression (live bug): a legacy task stored `recurrence: 'none'`. The
// old contract `nextCairoRun(unknown) → same instant` + the runner's
// truthy-recurrence check made that task re-fire every scheduler sweep,
// posting the same reminder into the owner's conversation forever
// (14+ identical messages observed in the demo data). A reminder is a
// promise, not a loop: unknown/legacy recurrence values are one-shot.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { testDb } from '../helpers/test-db'
import { createNewBusinessWithDefaults } from '@/lib/domain/business-builder'
import { runDueTasks } from '@/lib/tasks/runner'

let db: Awaited<ReturnType<typeof testDb>>
const ids: string[] = []

beforeAll(async () => {
  db = await testDb()
})

afterAll(async () => {
  await db.business.deleteMany({ where: { id: { in: ids } } })
})

async function shop() {
  const created = await createNewBusinessWithDefaults({ name: `task-runner-${randomUUID()}`, type: 'supermarket' })
  ids.push(created.id)
  return {
    business: await db.business.findUniqueOrThrow({ where: { id: created.id } }),
    user: await db.user.findUniqueOrThrow({ where: { id: created.users[0].id } }),
  }
}

describe('task runner — one-shot lifecycle', () => {
  test('recurrence="none" (legacy garbage) is delivered exactly once, then done — never re-fires', async () => {
    const { business, user } = await shop()
    const past = new Date(Date.now() - 60_000)
    await db.scheduledTask.create({
      data: {
        businessId: business.id,
        userId: user.id,
        title: 'راجع طلبيات فرع المعادي',
        tool: 'remind',
        fields: '{}',
        whenLabel: 'من دلوقتي',
        scheduledFor: past,
        recurrence: 'none', // the exact legacy value observed in the demo DB
        status: 'pending',
      },
    })
    const conversation = await db.conversation.create({ data: { businessId: business.id, userId: user.id, title: 't' } })

    const first = await runDueTasks(10)
    expect(first.ran).toBeGreaterThanOrEqual(1)
    const task = await db.scheduledTask.findFirst({ where: { businessId: business.id } })
    expect(task?.status).toBe('done')
    expect(await db.message.count({ where: { conversationId: conversation.id, text: { contains: 'راجع طلبيات فرع المعادي' } } })).toBe(1)

    // The scheduler sweeps forever: a second sweep must change NOTHING.
    const second = await runDueTasks(10)
    expect(second.due).toBe(0)
    expect(await db.message.count({ where: { conversationId: conversation.id, text: { contains: 'راجع طلبيات فرع المعادي' } } })).toBe(1)
  })

  test('recurrence=null stays one-shot too (defence in depth)', async () => {
    const { business, user } = await shop()
    const past = new Date(Date.now() - 30_000)
    await db.scheduledTask.create({
      data: {
        businessId: business.id,
        userId: user.id,
        title: 'تذكير اختبار',
        tool: 'remind',
        fields: '{}',
        whenLabel: 'من دلوقتي',
        scheduledFor: past,
        recurrence: null,
        status: 'pending',
      },
    })
    await runDueTasks(10)
    const task = await db.scheduledTask.findFirst({ where: { businessId: business.id } })
    expect(task?.status).toBe('done')
    await runDueTasks(10)
    expect((await db.scheduledTask.findFirst({ where: { businessId: business.id } }))?.status).toBe('done')
  })

  test('a real daily recurrence keeps rescheduling into the future', async () => {
    const { business, user } = await shop()
    const past = new Date(Date.now() - 60_000)
    await db.scheduledTask.create({
      data: {
        businessId: business.id,
        userId: user.id,
        title: 'ملخص يومي',
        tool: 'get_daily_summary',
        fields: '{}',
        whenLabel: 'كل يوم',
        scheduledFor: past,
        recurrence: 'daily',
        status: 'pending',
      },
    })
    const first = await runDueTasks(10)
    expect(first.ran).toBeGreaterThanOrEqual(1)
    const t1 = await db.scheduledTask.findFirst({ where: { businessId: business.id } })
    expect(t1?.status).toBe('pending')
    expect(t1!.scheduledFor.getTime()).toBeGreaterThan(Date.now() - 61_000)
    // Next sweep: not due yet.
    const second = await runDueTasks(10)
    expect(second.due).toBe(0)
    expect((await db.scheduledTask.findFirst({ where: { businessId: business.id } }))?.status).toBe('pending')
  })
})
