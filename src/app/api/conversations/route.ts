// /api/conversations — سجل المحادثات القديمة (ChatGPT-style history).
// GET    ?businessId&userId → ConversationSummaryDTO[] (pinned first, then last
//        activity desc, archived excluded, max 50).
// POST   {businessId,userId,title?} → creates a conversation («محادثة جديدة»).
// PATCH  {id,title?,pinned?,archived?} → updated summary.
// DELETE ?id= → deletes the conversation (messages cascade via the relation).
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { ConversationSummaryDTO } from '@/lib/types'
import { badRequest, notFound, searchParams, serverError } from '../_lib/http'
import { guard } from '../_lib/guard'

export const dynamic = 'force-dynamic'

const MAX_CONVERSATIONS = 50
const PREVIEW_LEN = 60
const DEFAULT_TITLE = 'محادثة جديدة'

/** Validate that business + user exist AND the user belongs to that business. */
async function validatePair(
  businessId: string,
  userId: string,
): Promise<NextResponse | null> {
  const [business, user] = await Promise.all([
    db.business.findUnique({ where: { id: businessId }, select: { id: true } }),
    db.user.findUnique({ where: { id: userId }, select: { id: true, businessId: true } }),
  ])
  if (!business) return notFound('النشاط التجاري غير موجود')
  if (!user) return notFound('المستخدم غير موجود')
  if (user.businessId !== businessId) return badRequest('المستخدم مش تابع للنشاط ده')
  return null
}

interface ConversationRow {
  id: string
  title: string
  pinned: boolean
  archived: boolean
  lastMessageAt: Date
  createdAt: Date
  _count: { messages: number }
}

/** Summary DTO for one conversation (preview = last message, 60 chars). */
async function summarize(c: ConversationRow): Promise<ConversationSummaryDTO> {
  const last = await db.message.findFirst({
    where: { conversationId: c.id },
    orderBy: { createdAt: 'desc' },
    select: { text: true, createdAt: true },
  })
  // the true "last activity" — the column can lag behind the real last message
  // for conversations written by older routes
  const lastAt = last ? new Date(Math.max(last.createdAt.getTime(), c.lastMessageAt.getTime())) : c.lastMessageAt
  return {
    id: c.id,
    title: c.title,
    pinned: c.pinned,
    archived: c.archived,
    lastMessageAt: lastAt.toISOString(),
    messageCount: c._count.messages,
    preview: (last?.text ?? '').trim().slice(0, PREVIEW_LEN),
    createdAt: c.createdAt.toISOString(),
  }
}

/** All summaries for a user: pinned first, then true last-activity desc. */
async function listSummaries(businessId: string, userId: string): Promise<ConversationSummaryDTO[]> {
  const rows = await db.conversation.findMany({
    where: { businessId, userId, archived: false },
    orderBy: [{ pinned: 'desc' }, { lastMessageAt: 'desc' }],
    take: MAX_CONVERSATIONS,
    include: { _count: { select: { messages: true } } },
  })
  const summaries = await Promise.all(rows.map(summarize))
  summaries.sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.lastMessageAt.localeCompare(a.lastMessageAt),
  )
  return summaries
}

export async function GET(req: Request) {
  try {
    const sp = searchParams(req)
        const businessId = sp.get('businessId')
    if (!businessId) return badRequest('businessId مطلوب')
    const userId = sp.get('userId')
    if (!userId) return badRequest('userId مطلوب')
    const gate = await guard(req, { businessId, userId })
    if (!gate.ok) return gate.res

    const invalid = await validatePair(businessId, userId)
    if (invalid) return invalid

    return NextResponse.json(await listSummaries(businessId, userId))
  } catch (e) {
    return serverError('conversations', e)
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { businessId?: string; userId?: string; title?: string }
    if (!body.businessId) return badRequest('businessId مطلوب')
    if (!body.userId) return badRequest('userId مطلوب')

    const gate = await guard(req, { businessId: body.businessId, userId: body.userId })
    if (!gate.ok) return gate.res

    const title = body.title?.trim().slice(0, 80) || DEFAULT_TITLE
    const created = await db.conversation.create({
      data: { businessId: body.businessId, userId: body.userId, title },
      include: { _count: { select: { messages: true } } },
    })
    const dto = await summarize(created)
    return NextResponse.json(dto, { status: 201 })
  } catch (e) {
    return serverError('conversations-post', e)
  }
}

export async function PATCH(req: Request) {
  try {
    const body = (await req.json()) as {
      id?: string
      title?: string
      pinned?: boolean
      archived?: boolean
    }
    if (!body.id) return badRequest('id مطلوب')

    const existing = await db.conversation.findUnique({
      where: { id: body.id },
      include: { _count: { select: { messages: true } } },
    })
    if (!existing) return notFound('المحادثة مش موجودة')
    const gate = await guard(req, { businessId: existing.businessId })
    if (!gate.ok) return gate.res

    const data: { title?: string; pinned?: boolean; archived?: boolean } = {}
    if (typeof body.title === 'string') {
      const title = body.title.trim().slice(0, 80)
      if (!title) return badRequest('العنوان مطلوب')
      data.title = title
    }
    if (typeof body.pinned === 'boolean') data.pinned = body.pinned
    if (typeof body.archived === 'boolean') data.archived = body.archived

    const updated = await db.conversation.update({
      where: { id: body.id },
      data,
      include: { _count: { select: { messages: true } } },
    })
    return NextResponse.json(await summarize(updated))
  } catch (e) {
    return serverError('conversations-patch', e)
  }
}

export async function DELETE(req: Request) {
  try {
    const sp = searchParams(req)
    const id = sp.get('id')
    if (!id) return badRequest('id مطلوب')

    const existing = await db.conversation.findUnique({ where: { id } })
    if (!existing) return notFound('المحادثة مش موجودة')
    const gate = await guard(req, { businessId: existing.businessId })
    if (!gate.ok) return gate.res

    // messages cascade via the Prisma relation (onDelete: Cascade)
    await db.conversation.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return serverError('conversations-delete', e)
  }
}
