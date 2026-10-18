// GET /api/tasks?businessId — scheduled tasks (pending first)
// POST /api/tasks — create a scheduled task (agent schedules its own reminders)
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { badRequest, notFound, serverError } from '../_lib/http'
import { guard } from '../_lib/guard'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const sp = new URL(req.url).searchParams
    const businessId = sp.get('businessId')
    if (!businessId) return badRequest('businessId مطلوب')
    const gate = await guard(req, { businessId, scope: 'business' })
    if (!gate.ok) return gate.res

    const tasks = await db.scheduledTask.findMany({
      where: { businessId, NOT: { tool: { startsWith: 'bg:' } } },
    })
    const pending = tasks
      .filter((t) => t.status === 'pending')
      .sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime())
    const rest = tasks
      .filter((t) => t.status !== 'pending')
      .sort((a, b) => (b.executedAt?.getTime() ?? b.createdAt.getTime()) - (a.executedAt?.getTime() ?? a.createdAt.getTime()))
    const all = [...pending, ...rest]

    return NextResponse.json({
      tasks: all.map((t) => ({
        id: t.id,
        title: t.title,
        tool: t.tool,
        fields: safeParse(t.fields),
        whenLabel: t.whenLabel,
        scheduledFor: t.scheduledFor.toISOString(),
        recurrence: t.recurrence,
        status: t.status,
        result: t.result,
        failReason: t.failReason,
        executedAt: t.executedAt?.toISOString() ?? null,
        createdAt: t.createdAt.toISOString(),
      })),
    })
  } catch (e) {
    return serverError('tasks', e)
  }
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

// Tool the scheduled task runs when it fires. The RESTRICTION is about money —
// a schedule must never draft or execute a write — but a plain reminder is
// explicitly allowed: the runner's `remind` branch delivers the title as a
// message. It used to be missing here, so the API rejected every reminder
// («مش بنجدول أدوات كتابة فلوس») even though the chat path creates them
// directly and the zod schema defaults to `remind`.
const READ_TOOLS = new Set([
  'remind',
  'get_daily_summary',
  'get_cash_position',
  'list_low_stock',
  'list_expiring',
  'list_receivables',
  'list_payables',
  'get_activity_history',
  'analyze_profitability',
  'forecast_stock',
  'get_proactive_insights',
])

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      businessId?: string
      userId?: string
      title?: string
      tool?: string
      fields?: Record<string, unknown>
      whenLabel?: string
      scheduledFor?: string
      recurrence?: 'daily' | 'weekly' | 'monthly' | null
      conversationId?: string | null
    }
    if (!body.businessId) return badRequest('businessId مطلوب')
    if (!body.userId) return badRequest('userId مطلوب')
    const gate = await guard(req, { businessId: body.businessId, userId: body.userId, permission: 'automation.manage' })
    if (!gate.ok) return gate.res
    if (!body.title?.trim()) return badRequest('عنوان المهمة مطلوب')
    if (!body.tool) return badRequest('الأداة مطلوبة')

    const [business, user] = await Promise.all([
      db.business.findUnique({ where: { id: body.businessId } }),
      db.user.findUnique({ where: { id: body.userId } }),
    ])
    if (!business) return notFound('النشاط غير موجود')
    if (!user) return notFound('المستخدم غير موجود')

    if (body.conversationId && !await db.conversation.findFirst({
      where: { id: body.conversationId, businessId: business.id, userId: user.id },
    })) return notFound('المحادثة دي مش تبع المستخدم والنشاط ده')

    // Only read tools may be scheduled (never a money write)
    if (!READ_TOOLS.has(body.tool)) return badRequest('مش بنجدول أدوات كتابة فلوس — أدوات القراءة بس')

    const scheduledFor = body.scheduledFor ? new Date(body.scheduledFor) : defaultNextRun(body.recurrence ?? 'daily')
    if (Number.isNaN(scheduledFor.getTime())) return badRequest('وقت التنفيذ مش صالح')

    const task = await db.scheduledTask.create({
      data: {
        businessId: business.id,
        userId: user.id,
        conversationId: body.conversationId ?? null,
        title: body.title.trim(),
        tool: body.tool,
        fields: JSON.stringify(body.fields ?? {}),
        whenLabel: body.whenLabel?.trim() || 'كل يوم الصبح',
        scheduledFor,
        recurrence: body.recurrence ?? 'daily',
      },
    })

    return NextResponse.json({ task: { ...task, fields: JSON.parse(task.fields) } }, { status: 201 })
  } catch (e) {
    return serverError('tasks-post', e)
  }
}

function defaultNextRun(recurrence: string): Date {
  const d = new Date()
  d.setHours(9, 0, 0, 0)
  if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1)
  if (recurrence === 'weekly') d.setDate(d.getDate() + 7)
  if (recurrence === 'monthly') d.setMonth(d.getMonth() + 1)
  return d
}
