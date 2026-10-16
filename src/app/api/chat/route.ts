// GET /api/chat?businessId&userId[&conversationId] — the conversation for that
// user (explicit id, else latest; creates «محادثة جديدة» when none exists) +
// its messages, oldest first.
// POST /api/chat — SSE stream: the agent turn (thinking → cards → حرف بحرف).
//   Body may carry `suggestionId` (tracked as UsageEvent kind='suggestion_used').
//   After the turn: conversation.lastMessageAt + messageCount (+2) are updated
//   and an untitled conversation gets its title from the first user message
//   (first 40 chars, trimmed to a word boundary).
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { ActionCardDTO, CardOutcomeDTO, ChatActionDTO, MessageDTO } from '@/lib/types'
import { badRequest, notFound, searchParams, serverError } from '../_lib/http'
import { parseJson, serializeMessage } from '../_lib/serialize'
import { runAgentTurn } from '@/lib/agent/harness'

export const dynamic = 'force-dynamic'

/** First 40 chars trimmed to a word boundary (no mid-word cuts). */
function autoTitle(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ')
  if (t.length <= 40) return t
  const cut = t.slice(0, 40)
  const sp = cut.lastIndexOf(' ')
  return (sp >= 15 ? cut.slice(0, sp) : cut).trim()
}

export async function GET(req: Request) {
  try {
    const sp = searchParams(req)
    const businessId = sp.get('businessId')
    if (!businessId) return badRequest('businessId مطلوب')
    const userId = sp.get('userId')
    if (!userId) return badRequest('userId مطلوب')
    const conversationId = sp.get('conversationId')

    const [business, user] = await Promise.all([
      db.business.findUnique({ where: { id: businessId }, select: { id: true } }),
      db.user.findUnique({ where: { id: userId }, select: { id: true } }),
    ])
    if (!business) return notFound('النشاط التجاري غير موجود')
    if (!user) return notFound('المستخدم غير موجود')

    let conversation = conversationId
      ? // explicit id MUST belong to the same business AND user — conversations
        // never leak across users of the same business
        await db.conversation.findFirst({ where: { id: conversationId, businessId, userId } })
      : await db.conversation.findFirst({
          where: { businessId, userId },
          orderBy: { updatedAt: 'desc' },
        })
    if (!conversation && !conversationId) {
      conversation = await db.conversation.create({
        data: { businessId, userId, title: 'محادثة جديدة' },
      })
    }
    if (!conversation) return notFound('المحادثة غير موجودة')

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
      // Parse the persisted deep-link buttons (mirrors card/cards handling)
      const actions = parseJson<ChatActionDTO[] | null>(m.actions, null)
      const withActions: MessageDTO = actions && actions.length > 0 ? { ...base, actions } : base
      if (m.card) {
        const card = parseJson<ActionCardDTO | null>(m.card, null)
        const op = card?.opId ? opMap.get(card.opId) : undefined
        if (card && op) {
          card.status = op.status as ActionCardDTO['status']
          return {
            ...withActions,
            card,
            ...(op.result
              ? { outcome: parseJson<CardOutcomeDTO | null>(op.result, null) ?? undefined }
              : {}),
          }
        }
      }
      return withActions
    })

    return NextResponse.json({
      conversation: {
        id: conversation.id,
        title: conversation.title,
        pinned: conversation.pinned,
        archived: conversation.archived,
        messageCount: conversation.messageCount,
        lastMessageAt: conversation.lastMessageAt.toISOString(),
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
      suggestionId?: string | null
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
    // (an explicit id that belongs to another business/user is rejected —
    // messages must never leak across tenants)
    let conversation = body.conversationId
      ? await db.conversation.findUnique({ where: { id: body.conversationId } })
      : await db.conversation.findFirst({ where: { businessId: business.id, userId: user.id }, orderBy: { updatedAt: 'desc' } })
    if (conversation && (conversation.businessId !== business.id || conversation.userId !== user.id)) {
      return notFound('المحادثة دي مش تبع النشاط ده')
    }
    if (!conversation) {
      conversation = await db.conversation.create({
        data: { businessId: business.id, userId: user.id, title: 'محادثة جديدة' },
      })
    }

    // Persist user message immediately
    const userMsg = await db.message.create({
      data: { conversationId: conversation.id, role: 'user', text: body.text.trim() },
    })
    // Auto-title on the FIRST user message of an untitled conversation
    const titleUpdate =
      conversation.title === 'محادثة جديدة' ? { title: autoTitle(body.text) } : {}
    await db.conversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date(), lastMessageAt: new Date(), ...titleUpdate },
    })

    // A suggestion chip was actually used → track it (feeds ranking freshness)
    if (body.suggestionId) {
      await db.usageEvent
        .create({ data: { businessId: business.id, userId: user.id, kind: 'suggestion_used', label: String(body.suggestionId).slice(0, 80) } })
        .catch(() => null)
    }

    // Persisted conversation history for context (raised 8 → 12 messages)
    const history = await db.message.findMany({
      where: { conversationId: conversation.id, createdAt: { lt: userMsg.createdAt } },
      orderBy: { createdAt: 'asc' },
      take: 12,
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
              ...(result.actions ? { actions: JSON.stringify(result.actions) } : {}),
              thinking: JSON.stringify(result.thinking),
              modelLabel: result.modelLabel,
            },
          })
          // one full turn = 2 messages (user + assistant) — cheap increment
          await db.conversation.update({
            where: { id: conversation!.id },
            data: { updatedAt: new Date(), lastMessageAt: new Date(), messageCount: { increment: 2 } },
          })
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
