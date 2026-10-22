// وكيل — PR-010 (plan v2 §9, P5): DURABLE task runner — the proof matrix.
//
// Acceptance criteria proven here (each test = one crash point or one
// concurrency hazard from the plan):
//   1. SIGKILL after CLAIM, before execute → lease expiry recovers it; it
//      finishes once; nothing lost, nothing duplicated.
//   2. SIGKILL after the EXECUTE commit (outbox row exists), before delivery
//      → re-execution is idempotent (deterministic outbox id); one message.
//   3. TWO workers in parallel on the same due task → the atomic claim lets
//      exactly ONE run it.
//   4. Failing task → bounded retry budget (RETRY_WAIT + backoff), then
//      `failed` with the REAL reason — no fake success, no infinite loop,
//      no notification ever delivered.
//   5. SIGKILL mid-DELIVERY (message already posted, commit lost) →
//      redelivery finds the deterministic message id → NO duplicate message.
//   6. Recurring task → distinct firing generations (outbox + message ids),
//      so a real second firing delivers, while a crashed first firing never
//      double-delivers.
//   7. Cancellation is honest: pending cancels, mid-execution refuses.
//   8. The task box is honest: state, last completed step, next step, reason.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { testDb } from '../helpers/test-db'
import { createNewBusinessWithDefaults } from '@/lib/domain/business-builder'
import {
  cancelTask,
  deliverPendingNotifications,
  describeTask,
  requeueStuckNotifications,
  requeueStuckTasks,
  runDueTasks,
} from '@/lib/tasks/runner'

let db: Awaited<ReturnType<typeof testDb>>
const ids: string[] = []

beforeAll(async () => {
  db = await testDb()
  // The test DB is copied from the developer seed, which intentionally contains
  // example reminders. Remove that demo queue from this disposable test copy so
  // global worker sweeps measure only tasks created by this proof matrix.
  await db.taskNotification.deleteMany()
  await db.scheduledTask.deleteMany()
})

afterAll(async () => {
  await db.business.deleteMany({ where: { id: { in: ids } } })
})

async function shop() {
  const created = await createNewBusinessWithDefaults({ name: `durable-runner-${randomUUID()}`, type: 'supermarket' })
  ids.push(created.id)
  return {
    business: await db.business.findUniqueOrThrow({ where: { id: created.id } }),
    user: await db.user.findUniqueOrThrow({ where: { id: created.users[0].id } }),
  }
}

async function makeTask(extra: Record<string, unknown> = {}) {
  const { business, user } = await shop()
  const conversation = await db.conversation.create({ data: { businessId: business.id, userId: user.id, title: 't' } })
  const task = await db.scheduledTask.create({
    data: {
      businessId: business.id,
      userId: user.id,
      conversationId: conversation.id,
      title: `مهمة ${randomUUID().slice(0, 8)}`,
      tool: 'remind',
      fields: '{}',
      whenLabel: 'من دلوقتي',
      scheduledFor: new Date(Date.now() - 60_000),
      recurrence: null,
      status: 'pending',
      ...extra,
    },
  })
  return { business, user, conversation, task }
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000)

describe('PR-010 — crash after claim, before execute', () => {
  test('a dead worker’s lease expires; the task recovers and finishes exactly once', async () => {
    const { conversation, task } = await makeTask()

    // Simulate: a worker claimed the task (SIGKILL-equivalent) 11 minutes ago
    // and never finished — older than the 10-minute lease.
    await db.scheduledTask.update({
      where: { id: task.id },
      data: { status: 'running', claimedAt: minutesAgo(11), leaseOwner: 'wk_dead_000000', lastStep: 'started' },
    })

    // A plain run does NOT touch it (it is not claimable while leased)…
    const first = await runDueTasks(10)
    expect(first.due).toBe(0)
    expect((await db.scheduledTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('running')

    // …but recovery re-queues it and the next sweep finishes it.
    expect(await requeueStuckTasks()).toBeGreaterThanOrEqual(1)
    const requeued = await db.scheduledTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(requeued.status).toBe('pending')
    expect(requeued.leaseOwner).toBeNull()

    await runDueTasks(10)
    const done = await db.scheduledTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(done.status).toBe('done')

    const count = await db.message.count({ where: { conversationId: conversation.id, text: { contains: task.title } } })
    expect(count).toBe(1)

    // And forever after: nothing re-fires, nothing duplicates.
    const third = await runDueTasks(10)
    expect(third.due).toBe(0)
    expect(await db.message.count({ where: { conversationId: conversation.id, text: { contains: task.title } } })).toBe(1)
  })
})

describe('PR-010 — crash after execute commit, before delivery', () => {
  test('the outbox row survives; re-execution is idempotent; one message delivered', async () => {
    const { conversation, task } = await makeTask()

    // Simulate: execution committed the outbox row (deterministic id), then
    // the process died before delivery.
    await db.scheduledTask.update({
      where: { id: task.id },
      data: { status: 'running', claimedAt: minutesAgo(11), leaseOwner: 'wk_dead_000001', lastStep: 'executed' },
    })
    await db.taskNotification.create({
      data: {
        id: `tn_${task.id}_0`,
        taskId: task.id,
        businessId: task.businessId,
        userId: task.userId,
        conversationId: task.conversationId,
        payload: JSON.stringify({
          messageId: `msg_${task.id}_0`,
          text: `⏰ تذكير: ${task.title}\nدي مهمة مجدولة من ${task.whenLabel} — وقتها وصل.`,
          detail: task.title,
          result: task.title,
        }),
        status: 'pending',
      },
    })

    await requeueStuckTasks()
    await runDueTasks(10)

    const done = await db.scheduledTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(done.status).toBe('done')
    // Re-execution must NOT have created a second outbox row for the same firing.
    expect(await db.taskNotification.count({ where: { taskId: task.id } })).toBe(1)
    expect((await db.taskNotification.findUniqueOrThrow({ where: { id: `tn_${task.id}_0` } })).status).toBe('sent')
    expect(await db.message.count({ where: { conversationId: conversation.id, text: { contains: task.title } } })).toBe(1)
  })
})

describe('PR-010 — two workers, one task', () => {
  test('two concurrent runDueTasks calls execute the same due task exactly once', async () => {
    const { conversation, task } = await makeTask()

    await Promise.all([runDueTasks(10), runDueTasks(10)])

    const done = await db.scheduledTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(done.status).toBe('done')
    expect(await db.taskNotification.count({ where: { taskId: task.id } })).toBe(1)
    expect(await db.message.count({ where: { conversationId: conversation.id, text: { contains: task.title } } })).toBe(1)
  })
})

describe('PR-010 — bounded retry budget and honest failure', () => {
  test('an unschedulable tool retries within budget, then fails with the real reason', async () => {
    const { conversation, task } = await makeTask({ tool: 'record_sale' }) // a money WRITE — hooks may never run it

    // Attempt 1 → RETRY_WAIT with backoff in the future.
    const s1 = await runDueTasks(10)
    expect(s1.failed).toBe(1)
    let t = await db.scheduledTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(t.status).toBe('retry_wait')
    expect(t.attempts).toBe(1)
    expect(t.failReason).toContain('مش مسموح')
    expect(t.nextRetryAt!.getTime()).toBeGreaterThan(Date.now())

    // Backoff not elapsed → not picked up.
    expect((await runDueTasks(10)).due).toBe(0)

    // Attempt 2 → RETRY_WAIT again (longer backoff).
    await db.scheduledTask.update({ where: { id: task.id }, data: { nextRetryAt: minutesAgo(1) } })
    await runDueTasks(10)
    t = await db.scheduledTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(t.status).toBe('retry_wait')
    expect(t.attempts).toBe(2)

    // Attempt 3 → budget exhausted → FAILED with the real reason.
    await db.scheduledTask.update({ where: { id: task.id }, data: { nextRetryAt: minutesAgo(1) } })
    await runDueTasks(10)
    t = await db.scheduledTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(t.status).toBe('failed')
    expect(t.attempts).toBe(3)
    expect(t.failReason).toContain('مش مسموح')
    expect(t.leaseOwner).toBeNull()

    // No notification was ever enqueued or delivered for a failed task.
    expect(await db.taskNotification.count({ where: { taskId: task.id } })).toBe(0)
    expect(await db.message.count({ where: { conversationId: conversation.id } })).toBe(0)

    // And it stays failed — no silent resurrection on later sweeps.
    expect((await runDueTasks(10)).due).toBe(0)
  })
})

describe('PR-010 — crash mid-delivery: no duplicate message', () => {
  test('a redelivery after a crash finds the deterministic message id and posts nothing new', async () => {
    const { conversation, task } = await makeTask()

    // Simulate the worst split: the FIRST delivery posted the message, then
    // the process died before committing. The outbox row is stuck `sending`.
    await db.message.create({
      data: {
        id: `msg_${task.id}_0`,
        conversationId: conversation.id,
        role: 'assistant',
        text: `⏰ تذكير: ${task.title}\nدي مهمة مجدولة من ${task.whenLabel} — وقتها وصل.`,
        modelLabel: 'مهمة مجدولة · وكيل',
      },
    })
    await db.scheduledTask.update({
      where: { id: task.id },
      data: { status: 'running', claimedAt: minutesAgo(11), leaseOwner: 'wk_dead_000002', lastStep: 'executed' },
    })
    await db.taskNotification.create({
      data: {
        id: `tn_${task.id}_0`,
        taskId: task.id,
        businessId: task.businessId,
        userId: task.userId,
        conversationId: task.conversationId,
        payload: JSON.stringify({
          messageId: `msg_${task.id}_0`,
          text: `⏰ تذكير: ${task.title}\nدي مهمة مجدولة من ${task.whenLabel} — وقتها وصل.`,
          detail: task.title,
          result: task.title,
        }),
        status: 'sending',
        claimedAt: minutesAgo(6),
        claimedBy: 'wk_dead_000002',
        attempts: 1,
      },
    })

    // Recovery + next sweep: task re-queued, outbox re-delivered…
    await requeueStuckTasks()
    await requeueStuckNotifications()
    await runDueTasks(10)

    const done = await db.scheduledTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(done.status).toBe('done')
    expect((await db.taskNotification.findUniqueOrThrow({ where: { id: `tn_${task.id}_0` } })).status).toBe('sent')
    // The message was posted EXACTLY ONCE across the crash.
    expect(await db.message.count({ where: { conversationId: conversation.id } })).toBe(1)
    expect(await db.message.count({ where: { id: `msg_${task.id}_0` } })).toBe(1)
  })
})

describe('PR-010 — recurring firings get distinct generations', () => {
  test('a daily reminder reschedules, and its legitimate second firing delivers again', async () => {
    const { conversation, task } = await makeTask({ recurrence: 'daily' })

    const first = await runDueTasks(10)
    expect(first.delivered).toBeGreaterThanOrEqual(1)
    let t = await db.scheduledTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(t.status).toBe('pending')
    expect(t.scheduledFor.getTime()).toBeGreaterThan(Date.now())
    expect(t.executionCount).toBe(1)
    expect(await db.message.count({ where: { conversationId: conversation.id } })).toBe(1)

    // Second firing (push the slot into the past): a NEW generation — new
    // outbox row, new message id, legitimately a second delivery.
    await db.scheduledTask.update({ where: { id: task.id }, data: { scheduledFor: minutesAgo(1) } })
    await runDueTasks(10)
    t = await db.scheduledTask.findUniqueOrThrow({ where: { id: task.id } })
    expect(t.executionCount).toBe(2)
    expect(await db.taskNotification.count({ where: { taskId: task.id } })).toBe(2)
    expect(await db.taskNotification.findUnique({ where: { id: `tn_${task.id}_1` } })).not.toBeNull()
    expect(await db.message.count({ where: { conversationId: conversation.id } })).toBe(2)
  })
})

describe('PR-010 — honest cancellation', () => {
  test('pending tasks cancel; a leased (running) task refuses with a false', async () => {
    const { task } = await makeTask({ scheduledFor: new Date(Date.now() + 3_600_000) })
    expect(await cancelTask(task.id, task.businessId)).toBe(true)
    expect((await db.scheduledTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('cancelled')

    const { task: t2 } = await makeTask()
    await db.scheduledTask.update({
      where: { id: t2.id },
      data: { status: 'running', claimedAt: new Date(), leaseOwner: 'wk_live_123456' },
    })
    expect(await cancelTask(t2.id, t2.businessId)).toBe(false)
  })
})

describe('PR-010 — the honest task box', () => {
  test('state, last completed step, next step, and the real reason are all reported', async () => {
    const pending = describeTask({
      status: 'pending', whenLabel: 'كل يوم الصبح', scheduledFor: new Date(), failReason: null,
      lastStep: null, nextRetryAt: null, attempts: 0, maxAttempts: 3,
    })
    expect(pending.statusAr).toBe('مجدولة')
    expect(pending.nextStepAr).toContain('كل يوم الصبح')

    const retrying = describeTask({
      status: 'retry_wait', whenLabel: 'كل يوم', scheduledFor: new Date(),
      failReason: 'انقطاع في البيانات', lastStep: 'فشل التنفيذ (محاولة 1)',
      nextRetryAt: new Date(), attempts: 1, maxAttempts: 3,
    })
    expect(retrying.statusAr).toBe('في انتظار إعادة المحاولة')
    expect(retrying.reasonAr).toContain('انقطاع في البيانات')
    expect(retrying.nextStepAr).toContain('إعادة المحاولة')

    const running = describeTask({
      status: 'running', whenLabel: 'كل يوم', scheduledFor: new Date(), failReason: null,
      lastStep: 'executed', nextRetryAt: null, attempts: 0, maxAttempts: 3,
    })
    expect(running.statusAr).toBe('قيد التنفيذ')
    expect(running.nextStepAr).toContain('تسليم النتيجة')

    const failed = describeTask({
      status: 'failed', whenLabel: 'مرة واحدة', scheduledFor: new Date(),
      failReason: 'أداة «record_sale» مش مسموح تتجدول', lastStep: 'فشل بعد كل المحاولات',
      nextRetryAt: null, attempts: 3, maxAttempts: 3,
    })
    expect(failed.statusAr).toBe('فشلت')
    expect(failed.reasonAr).toContain('مش مسموح')
  })
})

describe('PR-010 — delivery pass is idempotent under re-runs', () => {
  test('deliverPendingNotifications called twice delivers a pending row once', async () => {
    const { conversation, task } = await makeTask()
    await db.scheduledTask.update({
      where: { id: task.id },
      data: { status: 'running', claimedAt: new Date(), leaseOwner: 'wk_live_999999', lastStep: 'executed' },
    })
    await db.taskNotification.create({
      data: {
        id: `tn_${task.id}_0`,
        taskId: task.id,
        businessId: task.businessId,
        userId: task.userId,
        conversationId: task.conversationId,
        payload: JSON.stringify({
          messageId: `msg_${task.id}_0`,
          text: `⏰ تذكير: ${task.title}\nدي مهمة مجدولة من ${task.whenLabel} — وقتها وصل.`,
          detail: task.title,
          result: task.title,
        }),
        status: 'pending',
      },
    })

    expect(await deliverPendingNotifications(10)).toBe(1)
    expect(await deliverPendingNotifications(10)).toBe(0)
    expect(await db.message.count({ where: { conversationId: conversation.id } })).toBe(1)
    expect((await db.scheduledTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('done')
  })
})
