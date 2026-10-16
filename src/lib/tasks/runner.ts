// وكيل — due-task runner.
//
// One implementation shared by:
//   • POST /api/tasks/tick   (manual / external cron)
//   • the in-process scheduler (src/lib/scheduler.ts, started by instrumentation)
//
// It runs every task whose `scheduledFor` has passed:
//   • tool tasks  → run the read tool, post the result cards into the chat
//   • «remind»    → pure reminder; the title IS the payload
//   • recurrence  → reschedule (daily/weekly/monthly) instead of closing
//
// Concurrency: a claim is done with an atomic conditional UPDATE
// (`status: pending → running`), so two runners (a cron hit + the scheduler)
// can never execute the same task twice.

import { db } from '@/lib/db'
import { runReadTool, type ReadTool } from '@/lib/agent/tools'
import type { ResultCardDTO } from '@/lib/types'

export interface TaskRunSummary {
  ran: number
  due: number
  failed: number
  /** Human-readable lines for the health endpoint / logs. */
  details: string[]
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Ensure a conversation exists to deliver the result into. */
async function deliverConversation(businessId: string, userId: string, conversationId: string | null) {
  if (conversationId) {
    const existing = await db.conversation.findUnique({ where: { id: conversationId } })
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

async function postAgentMessage(conversationId: string, data: { text: string; cards?: string; detail: string }) {
  await db.message.create({
    data: {
      conversationId,
      role: 'assistant',
      text: data.text,
      ...(data.cards ? { cards: data.cards } : {}),
      thinking: JSON.stringify([
        { label: 'مهمة مجدولة', detail: data.detail, state: 'done', icon: 'verify' },
      ]),
      modelLabel: 'مهمة مجدولة · وكيل',
    },
  })
  await db.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date(), lastMessageAt: new Date(), messageCount: { increment: 1 } },
  })
}

function nextRun(from: Date, recurrence: string): Date {
  const next = new Date(from)
  if (recurrence === 'daily') next.setDate(next.getDate() + 1)
  else if (recurrence === 'weekly') next.setDate(next.getDate() + 7)
  else if (recurrence === 'monthly') next.setMonth(next.getMonth() + 1)
  return next
}

/**
 * Run every task that is due. Safe to call from anywhere, any number of times.
 * `limit` bounds the work per call so a huge backlog can't stall the tick.
 */
export async function runDueTasks(limit = 10): Promise<TaskRunSummary> {
  const now = new Date()
  const due = await db.scheduledTask.findMany({
    where: { status: 'pending', scheduledFor: { lte: now } },
    orderBy: { scheduledFor: 'asc' },
    take: limit,
  })

  const summary: TaskRunSummary = { ran: 0, due: due.length, failed: 0, details: [] }

  for (const task of due) {
    // ATOMIC CLAIM — only the first runner flips pending → running.
    const claim = await db.scheduledTask.updateMany({
      where: { id: task.id, status: 'pending' },
      data: { status: 'running', claimedAt: now },
    })
    if (claim.count === 0) continue

    try {
      if (task.tool === 'remind') {
        const conv = await deliverConversation(task.businessId, task.userId, task.conversationId)
        await postAgentMessage(conv.id, {
          text: `⏰ تذكير: ${task.title}\nدي مهمة مجدولة من ${task.whenLabel} — وقتها وصل.`,
          detail: `${task.title} (${task.whenLabel})`,
        })
        await db.scheduledTask.update({
          where: { id: task.id },
          data: { status: 'done', executedAt: new Date(), result: task.title },
        })
        summary.ran++
        summary.details.push(`remind:${task.title}`)
        continue
      }

      const cards = await runReadTool(task.tool as ReadTool, task.businessId, safeParse(task.fields))
      if (task.recurrence) {
        await db.scheduledTask.update({
          where: { id: task.id },
          data: {
            scheduledFor: nextRun(task.scheduledFor, task.recurrence),
            executedAt: new Date(),
            status: 'pending',
            result: JSON.stringify(cards).slice(0, 4000),
          },
        })
      } else {
        await db.scheduledTask.update({
          where: { id: task.id },
          data: { status: 'done', executedAt: new Date(), result: JSON.stringify(cards).slice(0, 4000) },
        })
      }

      const conv = await deliverConversation(task.businessId, task.userId, task.conversationId)
      const summaryText = cards
        .map((c: ResultCardDTO) => (c.kind === 'table' ? `${c.title}: ${c.rows.length} صف` : c.title))
        .join(' · ')
      await postAgentMessage(conv.id, {
        text: `⏰ مهمة مجدولة: ${task.title} — ${summaryText}`,
        cards: JSON.stringify(cards),
        detail: `${task.title} (${task.whenLabel})`,
      })
      summary.ran++
      summary.details.push(`tool:${task.tool}`)
    } catch (err) {
      summary.failed++
      const reason = err instanceof Error ? err.message : 'فشل'
      summary.details.push(`failed:${task.title}=${reason}`)
      console.error('[tasks] task failed:', task.id, reason)
      await db.scheduledTask.update({
        where: { id: task.id },
        data: { status: 'failed', failReason: reason, executedAt: new Date() },
      })
    }
  }

  return summary
}

/**
 * Recover tasks stuck in `running` because the process died mid-run: anything
 * claimed longer ago than `stuckAfterMs` goes back to `pending` (and will be
 * retried by the next tick) with a note in the result field.
 */
export async function requeueStuckTasks(stuckAfterMs = 10 * 60_000): Promise<number> {
  const cutoff = new Date(Date.now() - stuckAfterMs)
  const stuck = await db.scheduledTask.findMany({
    where: { status: 'running', claimedAt: { lt: cutoff } },
    select: { id: true },
    take: 50,
  })
  if (stuck.length === 0) return 0
  const res = await db.scheduledTask.updateMany({
    where: { id: { in: stuck.map((t) => t.id) } },
    data: { status: 'pending', claimedAt: null, failReason: 'اتعاد جدولتها بعد توقف غير متوقع' },
  })
  return res.count
}
