// POST /api/tasks/tick — runs due scheduled tasks (read tools only) and
// posts the result into the owner's conversation as an agent message.
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { runReadTool, type ReadTool } from '@/lib/agent/tools'
import { serverError } from '../../_lib/http'
import { guard } from '../../_lib/guard'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    // System job (the in-process scheduler calls it too): token + origin +
    // rate limit apply, tenant scoping does not — it sweeps every business.
    const gate = await guard(req, { scope: 'open' })
    if (!gate.ok) return gate.res
    const due = await db.scheduledTask.findMany({
      where: { status: 'pending', scheduledFor: { lte: new Date() } },
      orderBy: { scheduledFor: 'asc' },
      take: 10,
    })

    let ran = 0
    for (const task of due) {
      try {
        // R18 «remind» tasks: pure reminders — no tool to run, the title IS
        // the payload. It lands in the conversation as a scheduled message.
        if (task.tool === 'remind') {
          await db.scheduledTask.update({
            where: { id: task.id },
            data: { status: 'done', executedAt: new Date(), result: task.title },
          })
          let conv = task.conversationId
            ? await db.conversation.findUnique({ where: { id: task.conversationId } })
            : await db.conversation.findFirst({ where: { businessId: task.businessId, userId: task.userId }, orderBy: { updatedAt: 'desc' } })
          if (!conv) {
            conv = await db.conversation.create({
              data: { businessId: task.businessId, userId: task.userId, title: 'مهام وكيل المجدولة' },
            })
          }
          await db.message.create({
            data: {
              conversationId: conv.id,
              role: 'assistant',
              text: `⏰ تذكير: ${task.title}\nدي مهمة مجدولة من ${task.whenLabel} — وقتها وصل.`,
              thinking: JSON.stringify([
                { label: 'مهمة مجدولة', detail: `${task.title} (${task.whenLabel})`, state: 'done', icon: 'verify' },
              ]),
              modelLabel: 'مهمة مجدولة · وكيل',
            },
          })
          await db.conversation.update({ where: { id: conv.id }, data: { updatedAt: new Date() } })
          ran++
          continue
        }
        const cards = await runReadTool(task.tool as ReadTool, task.businessId, safeParse(task.fields))
        // Recurrence: schedule next run before marking done
        if (task.recurrence) {
          const next = new Date(task.scheduledFor)
          if (task.recurrence === 'daily') next.setDate(next.getDate() + 1)
          else if (task.recurrence === 'weekly') next.setDate(next.getDate() + 7)
          else if (task.recurrence === 'monthly') next.setMonth(next.getMonth() + 1)
          await db.scheduledTask.update({
            where: { id: task.id },
            data: { scheduledFor: next, executedAt: new Date(), status: 'done', result: JSON.stringify(cards).slice(0, 4000) },
          })
        } else {
          await db.scheduledTask.update({
            where: { id: task.id },
            data: { status: 'done', executedAt: new Date(), result: JSON.stringify(cards).slice(0, 4000) },
          })
        }

        // Post into the user's conversation
        let conversation = task.conversationId
          ? await db.conversation.findUnique({ where: { id: task.conversationId } })
          : await db.conversation.findFirst({ where: { businessId: task.businessId, userId: task.userId }, orderBy: { updatedAt: 'desc' } })
        if (!conversation) {
          conversation = await db.conversation.create({
            data: { businessId: task.businessId, userId: task.userId, title: 'مهام وكيل المجدولة' },
          })
        }
        const summaryText = cards
          .map((c) => (c.kind === 'table' ? `${c.title}: ${c.rows.length} صف` : c.kind === 'kv' ? c.title : c.title))
          .join(' · ')
        await db.message.create({
          data: {
            conversationId: conversation.id,
            role: 'assistant',
            text: `⏰ مهمة مجدولة: ${task.title} — ${summaryText}`,
            cards: JSON.stringify(cards),
            thinking: JSON.stringify([
              { label: 'مهمة مجدولة', detail: `${task.title} (${task.whenLabel})`, state: 'done', icon: 'verify' },
            ]),
            modelLabel: 'مهمة مجدولة · وكيل',
          },
        })
        await db.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } })
        ran++
      } catch (err) {
        console.error('[tasks/tick] task failed:', task.id, err)
        await db.scheduledTask.update({
          where: { id: task.id },
          data: { status: 'failed', failReason: err instanceof Error ? err.message : 'فشل', executedAt: new Date() },
        })
      }
    }

    return NextResponse.json({ ran, due: due.length })
  } catch (e) {
    return serverError('tasks-tick', e)
  }
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}
