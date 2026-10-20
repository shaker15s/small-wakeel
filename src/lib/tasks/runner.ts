// وكيل — DUE-TASK RUNNER (PR-010 / plan v2 §9: durable, crash-safe execution).
//
// One implementation shared by:
//   • POST /api/tasks/tick      (manual / external cron — atomic-claim based)
//   • the in-process scheduler  (src/lib/scheduler.ts, started by instrumentation)
//
// WHY this shape (crash matrix from the plan's P5 acceptance criteria):
// A task firing is three committed steps, and a crash between any two of them
// must cause neither silent loss nor a duplicated side effect:
//
//   1. CLAIM    — atomic conditional UPDATE (pending|retry_wait → running,
//                 leaseOwner, claimedAt). Two workers (cron + scheduler, or
//                 two server processes) can never run the same task twice.
//   2. EXECUTE  — run the read tool / build the reminder, then ONE
//                 transaction inserts the outbox row (deterministic id
//                 `tn_<taskId>_<generation>`) and records lastStep. A crash
//                 here re-queues via lease expiry; re-executing a READ is
//                 safe, and the outbox insert is idempotent (same id).
//   3. DELIVER  — the outbox row is claimed separately (pending → sending),
//                 the chat message is posted with a DETERMINISTIC message id,
//                 and one transaction marks the outbox `sent` + finishes the
//                 task (done / next recurrence slot, executionCount+1).
//                 «task finished» is never conflated with «notification
//                 delivered» — and the deterministic ids make redelivery
//                 after a crash post the message at most ONCE.
//
// Retry policy: reads and reminders are safe to retry, so a failed execution
// moves to RETRY_WAIT with a bounded budget (attempts < maxAttempts) and a
// growing backoff; when the budget is exhausted the task is `failed` with the
// REAL reason — never a fake success, never an infinite silent loop.
//
// Hooks boundary (plan §9.2): a scheduled task may only run a READ tool or a
// reminder. A money write can never be scheduled — the gate below refuses
// anything else, so hooks cannot invoke a financial tool (P1 gate stays the
// only door to writes).

import { isKnownRecurrence, nextCairoRun } from './cairo-time'
import { requireBusinessUser } from '@/lib/security/permissions'
import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { READ_TOOLS, runReadTool, type ReadTool } from '@/lib/agent/tools'
import type { ResultCardDTO } from '@/lib/types'

export interface TaskRunSummary {
  ran: number
  due: number
  failed: number
  delivered: number
  /** Human-readable lines for the health endpoint / logs. */
  details: string[]
}

export interface RunDueOptions {
  /** Also run pending tasks whose time has NOT arrived (external cron force). */
  forceAll?: boolean
  businessId?: string
}

// ---------------------------------------------------------------------------
// Worker identity, leases, and budgets
// ---------------------------------------------------------------------------

/** One stable identity per process — shows up in leaseOwner/claimedBy. */
const WORKER_ID = `wk_${process.pid}_${Math.random().toString(36).slice(2, 8)}`

/** A running task whose lease is older than this is considered a dead worker. */
function leaseMs(): number {
  const raw = Number(process.env.WAKIL_TASK_LEASE_MS)
  return Number.isFinite(raw) && raw >= 30_000 ? raw : 10 * 60_000
}

/** A `sending` notification older than this is a dead delivery. */
function deliveryLeaseMs(): number {
  return 5 * 60_000
}

/** Backoff after attempt N (1-based): 30s → 2m → 5m. */
function retryBackoffMs(attempt: number): number {
  if (attempt <= 1) return 30_000
  if (attempt === 2) return 2 * 60_000
  return 5 * 60_000
}

const MAX_DELIVERY_ATTEMPTS = 5

function safeParse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// Claim + execute (steps 1–2)
// ---------------------------------------------------------------------------

/**
 * Run every task that is due (or every pending task when `forceAll`).
 * Safe to call from anywhere, any number of times, by any number of workers —
 * the claim is atomic. Ends with a delivery pass so the caller observes the
 * settled state.
 */
export async function runDueTasks(limit = 10, opts: RunDueOptions = {}): Promise<TaskRunSummary> {
  const now = new Date()
  const due = await db.scheduledTask.findMany({
    where: {
      OR: opts.forceAll
        ? [{ status: 'pending' }, { status: 'retry_wait' }]
        : [
            { status: 'pending', scheduledFor: { lte: now } },
            { status: 'retry_wait', nextRetryAt: { lte: now } },
          ],
      ...(opts.businessId ? { businessId: opts.businessId } : {}),
    },
    orderBy: [{ scheduledFor: 'asc' }],
    take: limit,
  })

  const summary: TaskRunSummary = { ran: 0, due: due.length, failed: 0, delivered: 0, details: [] }

  for (const task of due) {
    // ATOMIC CLAIM — only the first worker flips the status; the rest see 0.
    const claim = await db.scheduledTask.updateMany({
      where: { id: task.id, status: { in: ['pending', 'retry_wait'] } },
      data: { status: 'running', claimedAt: now, leaseOwner: WORKER_ID, lastStep: 'started' },
    })
    if (claim.count === 0) continue

    try {
      await requireBusinessUser(task.businessId, task.userId)

      // HOOKS BOUNDARY — only reads and reminders may run from a schedule.
      if (task.tool !== 'remind' && !READ_TOOLS.has(task.tool)) {
        throw new Error(`أداة «${task.tool}» مش مسموح تتجدول — القراءة والتذكير بس`)
      }

      // Step 2: EXECUTE. The side effects of a firing are (a) a read (safe to
      // repeat) and (b) ONE outbox row with a deterministic id (idempotent).
      const payload =
        task.tool === 'remind'
          ? {
              messageId: messageIdFor(task),
              text: `⏰ تذكير: ${task.title}\nدي مهمة مجدولة من ${task.whenLabel} — وقتها وصل.`,
              detail: `${task.title} (${task.whenLabel})`,
              result: task.title,
            }
          : await buildToolPayload(task)

      await db.$transaction([
        db.taskNotification.upsert({
          where: { id: outboxIdFor(task) },
          update: {}, // a crashed earlier firing already enqueued it — keep it
          create: {
            id: outboxIdFor(task),
            taskId: task.id,
            businessId: task.businessId,
            userId: task.userId,
            conversationId: task.conversationId,
            payload: JSON.stringify(payload),
            status: 'pending',
          },
        }),
        db.scheduledTask.update({
          where: { id: task.id },
          data: { lastStep: 'executed' },
        }),
      ])

      summary.ran++
      summary.details.push(`${task.tool}:${task.title}${task.recurrence ? `→${task.recurrence}` : ''}`)
    } catch (err) {
      summary.failed++
      const reason = err instanceof Error ? err.message : 'فشل غير متوقع'
      summary.details.push(`failed:${task.title}=${reason.slice(0, 200)}`)
      console.error('[tasks] execution failed:', task.id, reason)
      await applyFailureBudget(task, reason)
    }
  }

  // Step 3 runs as its own pass: pending outbox rows (including ones from
  // earlier crashed firings) are delivered and committed.
  const delivered = await deliverPendingNotifications(20)
  summary.delivered = delivered
  return summary
}

async function buildToolPayload(task: {
  id: string
  title: string
  whenLabel: string
  tool: string
  businessId: string
  fields: string
  executionCount: number
}): Promise<Record<string, unknown>> {
  const cards = (await runReadTool(task.tool as ReadTool, task.businessId, safeParse(task.fields))) as ResultCardDTO[]
  const summaryText = cards
    .map((c: ResultCardDTO) => (c.kind === 'table' ? `${c.title}: ${c.rows.length} صف` : c.title))
    .join(' · ')
  return {
    messageId: messageIdFor(task),
    text: `⏰ مهمة مجدولة: ${task.title} — ${summaryText}`,
    cards: JSON.stringify(cards),
    detail: `${task.title} (${task.whenLabel})`,
    result: JSON.stringify(cards),
  }
}

/**
 * Bounded retry: attempts < maxAttempts → RETRY_WAIT until the backoff elapses
 * (the next sweep claims it then); budget exhausted → failed with the reason.
 */
async function applyFailureBudget(task: { id: string; attempts: number; maxAttempts: number }, reason: string) {
  const attempts = task.attempts + 1
  if (attempts < task.maxAttempts) {
    await db.scheduledTask.update({
      where: { id: task.id },
      data: {
        status: 'retry_wait',
        nextRetryAt: new Date(Date.now() + retryBackoffMs(attempts)),
        attempts,
        failReason: reason.slice(0, 500),
        lastStep: `فشل التنفيذ (محاولة ${attempts})`,
        claimedAt: null,
        leaseOwner: null,
      },
    })
  } else {
    await db.scheduledTask.update({
      where: { id: task.id },
      data: {
        status: 'failed',
        attempts,
        failReason: reason.slice(0, 500),
        lastStep: 'فشل بعد كل المحاولات',
        executedAt: new Date(),
        claimedAt: null,
        leaseOwner: null,
      },
    })
  }
}

// ---------------------------------------------------------------------------
// Deliver (step 3) — the outbox
// ---------------------------------------------------------------------------

/** Deterministic ids: the same firing, however many times it is attempted,
 *  can never enqueue two outbox rows or post two messages. */
function outboxIdFor(task: { id: string; executionCount: number }): string {
  return `tn_${task.id}_${task.executionCount}`
}
function messageIdFor(task: { id: string; executionCount: number }): string {
  return `msg_${task.id}_${task.executionCount}`
}

/**
 * Claim and deliver every pending outbox row. Idempotent under crashes:
 * the chat message has a deterministic id, so a redelivery after a crash finds
 * the already-posted message instead of posting a duplicate.
 */
export async function deliverPendingNotifications(limit = 20): Promise<number> {
  const pending = await db.taskNotification.findMany({
    where: { status: 'pending' },
    orderBy: { createdAt: 'asc' },
    take: limit,
  })
  let delivered = 0
  for (const row of pending) {
    const claim = await db.taskNotification.updateMany({
      where: { id: row.id, status: 'pending' },
      data: { status: 'sending', claimedAt: new Date(), claimedBy: WORKER_ID, attempts: { increment: 1 } },
    })
    if (claim.count === 0) continue
    try {
      await deliverOne(row)
      delivered++
    } catch (err) {
      // Leave the row `sending` (claimed) — requeueStuckNotifications()
      // retries it after the delivery lease, within its own budget.
      console.error('[tasks] delivery failed:', row.id, err instanceof Error ? err.message : 'فشل')
    }
  }
  return delivered
}

async function deliverOne(row: {
  id: string
  taskId: string
  businessId: string
  userId: string
  conversationId: string | null
  payload: string
}): Promise<void> {
  const payload = JSON.parse(row.payload) as {
    messageId: string
    text: string
    cards?: string
    detail?: string
    result?: string
  }

  const conv = await deliverConversation(row.businessId, row.userId, row.conversationId)

  // Crash-safe exactly-once posting: the message id is deterministic, so if a
  // previous attempt posted it and then crashed before committing, we find it
  // here and do NOT post a second copy.
  let message = await db.message.findUnique({ where: { id: payload.messageId }, select: { id: true } })
  if (!message) {
    try {
      message = await db.message.create({
        data: {
          id: payload.messageId,
          conversationId: conv.id,
          role: 'assistant',
          text: payload.text,
          ...(payload.cards ? { cards: payload.cards } : {}),
          thinking: JSON.stringify([
            { label: 'مهمة مجدولة', detail: payload.detail ?? 'مهمة مجدولة', state: 'done', icon: 'verify' },
          ]),
          modelLabel: 'مهمة مجدولة · وكيل',
        },
        select: { id: true },
      })
    } catch (e) {
      // Lost a race with a concurrent redelivery — the other one posted it.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        message = await db.message.findUnique({ where: { id: payload.messageId }, select: { id: true } })
      } else throw e
    }
  }
  if (!message) throw new Error('تعذر تأكيد رسالة التنبيه')

  // Commit: outbox `sent` first, then finish the task (recurrence-aware).
  await db.taskNotification.update({
    where: { id: row.id },
    data: { status: 'sent', sentAt: new Date(), claimedAt: null, claimedBy: null, failReason: null },
  })
  await finishTask(row.taskId, conv.id, payload.result ?? null)
}

/**
 * Finish a task after its notification is committed. Recurrence-aware: a
// recurring task moves to its next slot and stays `pending` (a reminder is a
 * promise that keeps firing); a one-shot task is `done`. The update is
 * conditional on `running`, so a task the owner canceled in the meantime is
 * never resurrected — its notification was still delivered, which is correct.
 */
async function finishTask(taskId: string, conversationId: string, result: string | null): Promise<void> {
  const task = await db.scheduledTask.findUnique({ where: { id: taskId } })
  if (!task || task.status !== 'running') return

  const data: Record<string, unknown> = {
    executedAt: new Date(),
    claimedAt: null,
    leaseOwner: null,
    executionCount: task.executionCount + 1,
    lastStep: 'انتهت وسلمت النتيجة',
    result: result ? result.slice(0, 4000) : null,
  }

  // Recurrence-aware finish: a recurring task moves to its next slot and stays
  // `pending` (a reminder is a promise that keeps firing); a one-shot task is
  // `done`. Unknown/legacy recurrence values are one-shot (R40 contract).
  const rec = task.recurrence
  if (isKnownRecurrence(rec)) {
    const next = nextRun(task.scheduledFor, rec)
    if (next && next > new Date()) {
      data.status = 'pending'
      data.scheduledFor = next
    } else {
      data.status = 'done'
    }
  } else {
    data.status = 'done'
  }

  await db.$transaction([
    db.scheduledTask.update({ where: { id: task.id }, data }),
    db.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date(), lastMessageAt: new Date(), messageCount: { increment: 1 } },
    }),
  ])
}

// ---------------------------------------------------------------------------
// Recovery (the «restart» acceptance criterion)
// ---------------------------------------------------------------------------

/**
 * Recover tasks stuck in `running` because the worker died mid-run: anything
 * claimed longer ago than the lease goes back to `pending` (retry keeps its
 * budget) and is claimed again by the next sweep.
 */
export async function requeueStuckTasks(stuckAfterMs = leaseMs()): Promise<number> {
  const cutoff = new Date(Date.now() - stuckAfterMs)
  const stuck = await db.scheduledTask.findMany({
    where: { status: 'running', claimedAt: { lt: cutoff } },
    select: { id: true },
    take: 50,
  })
  if (stuck.length === 0) return 0
  const res = await db.scheduledTask.updateMany({
    where: { id: { in: stuck.map((t) => t.id) } },
    data: {
      status: 'pending',
      claimedAt: null,
      leaseOwner: null,
      lastStep: 'اتعاد الجدولة بعد توقف غير متوقع',
    },
  })
  return res.count
}

/**
 * Recover outbox rows stuck in `sending` (crash between posting the message
 * and committing). Within budget they go back to `pending` — redelivery is
 * idempotent. Over budget the notification is `failed` (shown honestly) and,
 * if its task is still `running`, the task is `failed` with the real reason —
 * a lost notification is never reported as delivered.
 */
export async function requeueStuckNotifications(staleAfterMs = deliveryLeaseMs()): Promise<number> {
  const cutoff = new Date(Date.now() - staleAfterMs)
  const stuck = await db.taskNotification.findMany({
    where: { status: 'sending', claimedAt: { lt: cutoff } },
    take: 50,
  })
  if (stuck.length === 0) return 0
  let touched = 0
  for (const row of stuck) {
    if (row.attempts >= MAX_DELIVERY_ATTEMPTS) {
      await db.taskNotification.update({
        where: { id: row.id },
        data: {
          status: 'failed',
          failReason: 'تعذر تسليم التنبيه بعد عدة محاولات — الرسالة لم تُرسَل',
          claimedAt: null,
          claimedBy: null,
        },
      })
      const task = await db.scheduledTask.findUnique({ where: { id: row.taskId } })
      if (task?.status === 'running') {
        await db.scheduledTask.update({
          where: { id: task.id },
          data: {
            status: 'failed',
            failReason: 'انتهت المهمة لكن تعذر تسليم نتيجتها',
            executedAt: new Date(),
            claimedAt: null,
            leaseOwner: null,
            lastStep: 'فشل تسليم النتيجة',
          },
        })
      }
    } else {
      await db.taskNotification.update({
        where: { id: row.id },
        data: { status: 'pending', claimedAt: null, claimedBy: null },
      })
    }
    touched++
  }
  return touched
}

// ---------------------------------------------------------------------------
// Cancellation + honest task box
// ---------------------------------------------------------------------------

/**
 * Cancel a task. Only pending/retry_wait tasks can be canceled — a task that
 * is mid-execution has already claimed its lease and must finish (returning
 * false lets the API say so honestly instead of pretending).
 */
export async function cancelTask(taskId: string, businessId: string): Promise<boolean> {
  const res = await db.scheduledTask.updateMany({
    where: { id: taskId, businessId, status: { in: ['pending', 'retry_wait'] } },
    data: { status: 'cancelled', claimedAt: null, leaseOwner: null, lastStep: 'ملغاة من قبل المالك' },
  })
  return res.count === 1
}

/** The honest task box: current state, the last COMPLETED step, the next
 *  step, and the REAL reason when waiting or failed (plan §9.3 acceptance). */
export function describeTask(t: {
  status: string
  whenLabel: string
  scheduledFor: Date
  failReason: string | null
  lastStep: string | null
  nextRetryAt: Date | null
  attempts: number
  maxAttempts: number
}): { statusAr: string; lastStepAr: string | null; nextStepAr: string | null; reasonAr: string | null } {
  switch (t.status) {
    case 'pending':
      return {
        statusAr: 'مجدولة',
        lastStepAr: null,
        nextStepAr: `ستنفذ عند: ${t.whenLabel}`,
        reasonAr: null,
      }
    case 'retry_wait':
      return {
        statusAr: 'في انتظار إعادة المحاولة',
        lastStepAr: t.lastStep,
        nextStepAr: t.nextRetryAt ? `إعادة المحاولة في ${t.nextRetryAt.toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' })}` : 'إعادة المحاولة في المسح القادم',
        reasonAr: t.failReason ? `السبب: ${t.failReason}` : null,
      }
    case 'running':
      return {
        statusAr: 'قيد التنفيذ',
        lastStepAr:
          t.lastStep === 'executed' ? 'تم التنفيذ بنجاح' : t.lastStep === 'started' ? 'بدأ التنفيذ' : t.lastStep,
        nextStepAr: t.lastStep === 'executed' ? 'تسليم النتيجة في المحادثة' : 'تسليم النتيجة في المحادثة',
        reasonAr: null,
      }
    case 'done':
      return { statusAr: 'انتهت', lastStepAr: 'انتهت وسلمت النتيجة', nextStepAr: null, reasonAr: null }
    case 'failed':
      return {
        statusAr: 'فشلت',
        lastStepAr: t.lastStep,
        nextStepAr: null,
        reasonAr: t.failReason ? `السبب: ${t.failReason}` : null,
      }
    case 'cancelled':
      return { statusAr: 'ملغاة', lastStepAr: 'ملغاة من قبل المالك', nextStepAr: null, reasonAr: null }
    default:
      return { statusAr: t.status, lastStepAr: t.lastStep, nextStepAr: null, reasonAr: t.failReason }
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Ensure a conversation exists to deliver the result into. */
async function deliverConversation(businessId: string, userId: string, conversationId: string | null) {
  if (conversationId) {
    const existing = await db.conversation.findFirst({ where: { id: conversationId, businessId, userId } })
    if (existing) return existing
  }
  const latest = await db.conversation.findFirst({
    where: { businessId, userId },
    orderBy: { updatedAt: 'desc' },
  })
  if (latest) return latest
  return db.conversation.create({
    data: { businessId, userId, title: 'مهام وكيل المجدولة' },
  })
}

/**
 * Next occurrence of a recurring task (exported for unit tests).
 * Returns null for unknown recurrences — callers must treat that as one-shot.
 */
export function nextRun(from: Date, recurrence: string): Date | null {
  return nextCairoRun(from, recurrence)
}
