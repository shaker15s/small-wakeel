// GET /api/chat?businessId&userId — latest conversation for that user
// (creates «محادثة جديدة» when none exists) + its messages, oldest first.
// POST /api/chat — SSE stream: the agent turn (thinking → cards → حرف بحرف).
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { ActionCardDTO, CardOutcomeDTO, MessageDTO } from '@/lib/types'
import { badRequest, notFound, searchParams, serverError } from '../_lib/http'
import { parseJson, serializeMessage } from '../_lib/serialize'
import { runAgentTurn } from '@/lib/agent/harness'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const sp = searchParams(req)
    const businessId = sp.get('businessId')
    if (!businessId) return badRequest('businessId مطلوب')
    const userId = sp.get('userId')
    if (!userId) return badRequest('userId مطلوب')

    const [business, user] = await Promise.all([
      db.business.findUnique({ where: { id: businessId }, select: { id: true } }),
      db.user.findUnique({ where: { id: userId }, select: { id: true } }),
    ])
    if (!business) return notFound('النشاط التجاري غير موجود')
    if (!user) return notFound('المستخدم غير موجود')

    let conversation = await db.conversation.findFirst({
      where: { businessId, userId },
      orderBy: { updatedAt: 'desc' },
    })
    if (!conversation) {
      conversation = await db.conversation.create({
        data: { businessId, userId, title: 'محادثة جديدة' },
      })
    }

    const messages = await db.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'asc' },
    })

    // Sync historical action cards with the CURRENT operation state: a stored
    // draft card must show SUCCEEDED/CANCELLED if the op moved on, and carry
    // the verification outcome when executed.
    const cardMessages = messages.filter((m) => m.card)
    const opIds = cardMessages
      .map((m) => parseJson<ActionCardDTO | null>(m.card, null)?.opId)
      .filter((id): id is string => !!id)
    const ops = opIds.length > 0 ? await db.operation.findMany({ where: { id: { in: opIds } } }) : []
    const opMap = new Map(ops.map((o) => [o.id, o]))

    const dto: MessageDTO[] = messages.map((m) => {
      const base = serializeMessage(m)
      if (m.card) {
        const card = parseJson<ActionCardDTO | null>(m.card, null)
        const op = card?.opId ? opMap.get(card.opId) : undefined
        if (card && op) {
          card.status = op.status as ActionCardDTO['status']
          return {
            ...base,
            card,
            ...(op.result
              ? { outcome: parseJson<CardOutcomeDTO | null>(op.result, null) ?? undefined }
              : {}),
          }
        }
      }
      return base
    })

    return NextResponse.json({
      conversation: {
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt.toISOString(),
        updatedAt: conversation.updatedAt.toISOString(),
      },
      messages: dto,
    })
  } catch (e) {
    return serverError('chat', e)
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      businessId?: string
      userId?: string
      text?: string
      modelKey?: string | null
      conversationId?: string | null
    }
    if (!body.businessId) return badRequest('businessId مطلوب')
    if (!body.userId) return badRequest('userId مطلوب')
    if (!body.text?.trim()) return badRequest('الرسالة فاضية')

    const [business, user] = await Promise.all([
      db.business.findUnique({ where: { id: body.businessId } }),
      db.user.findUnique({ where: { id: body.userId } }),
    ])
    if (!business) return notFound('النشاط التجاري غير موجود')
    if (!user) return notFound('المستخدم غير موجود')

    // Conversation: explicit, else latest for that user, else new
    let conversation = body.conversationId
      ? await db.conversation.findUnique({ where: { id: body.conversationId } })
      : await db.conversation.findFirst({ where: { businessId: business.id, userId: user.id }, orderBy: { updatedAt: 'desc' } })
    if (!conversation) {
      conversation = await db.conversation.create({
        data: { businessId: business.id, userId: user.id, title: 'محادثة جديدة' },
      })
    }

    // Persist user message immediately
    const userMsg = await db.message.create({
      data: { conversationId: conversation.id, role: 'user', text: body.text.trim() },
    })
    await db.conversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date(), title: conversation.title === 'محادثة جديدة' ? body.text.trim().slice(0, 40) : conversation.title },
    })

    const history = await db.message.findMany({
      where: { conversationId: conversation.id, createdAt: { lt: userMsg.createdAt } },
      orderBy: { createdAt: 'asc' },
      take: 8,
    })

    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        const send = (data: unknown) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        }
        try {
          send({ event: 'start', conversationId: conversation!.id, messageId: userMsg.id })
          const result = await runAgentTurn(
            {
              business: business!,
              user: user!,
              conversationId: conversation!.id,
              text: body.text!.trim(),
              modelKey: body.modelKey ?? null,
              history: history.map((m) => ({ role: m.role, text: m.text })),
            },
            (ev) => send(ev),
          )

          // Persist assistant message
          const assistantMsg = await db.message.create({
            data: {
              conversationId: conversation!.id,
              role: 'assistant',
              text: result.replyText,
              ...(result.card ? { card: JSON.stringify(result.card) } : {}),
              ...(result.cards ? { cards: JSON.stringify(result.cards) } : {}),
              thinking: JSON.stringify(result.thinking),
              modelLabel: result.modelLabel,
            },
          })
          await db.conversation.update({ where: { id: conversation!.id }, data: { updatedAt: new Date() } })
          send({ event: 'done', messageId: assistantMsg.id, modelLabel: result.modelLabel })
        } catch (err) {
          console.error('[api/chat POST]', err)
          send({ event: 'error', message: 'حصل خطأ في السيرفر — جرّب تاني' })
        } finally {
          controller.close()
        }
      },
    })

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      },
    })
  } catch (e) {
    return serverError('chat', e)
  }
}
