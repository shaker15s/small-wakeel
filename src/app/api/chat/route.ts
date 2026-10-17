// GET /api/chat?businessId&userId[&conversationId] — the conversation for that
// user (explicit id, else latest; creates «محادثة جديدة» when none exists) +
// its messages, oldest first.
// POST /api/chat — SSE stream: the agent turn (thinking → cards → حرف بحرف).
//   Body may carry `suggestionId` (tracked as UsageEvent kind='suggestion_used')
//   and `deepResearch` (R15: forces the بحث عميق pipeline).
//   R15: every POST first runs maybeReflect (correction-pattern lessons), the
//   assistant message persists research/verified JSON, and the `done` event
//   carries {verified, research, notesUpdated} when present (additive).
//   After the turn: conversation.lastMessageAt + messageCount (+2) are updated
//   and an untitled conversation gets its title from the first user message
//   (first 40 chars, trimmed to a word boundary).
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { ActionCardDTO, CardOutcomeDTO, ChatActionDTO, MessageDTO } from '@/lib/types'
import { badRequest, notFound, searchParams, serverError } from '../_lib/http'
import { parseBody, chatPostSchema } from '@/lib/security/validate'
import { guard } from '../_lib/guard'
import { parseJson, serializeMessage } from '../_lib/serialize'
import { runAgentTurn } from '@/lib/agent/harness'
import { maybeReflect } from '@/lib/agent/reflection'

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
    // guard() loads & validates the tenant pair once — reuse it below instead
    // of hitting the database again for the same two rows.
    const gate = await guard(req, { businessId: sp.get('businessId'), userId: sp.get('userId') })
    if (!gate.ok) return gate.res
    const businessId = gate.actor.business.id
    const userId = gate.actor.user.id
    const conversationId = sp.get('conversationId')

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
    const parsed = await parseBody(req, chatPostSchema)
    if (!parsed.ok) return badRequest(parsed.message)
    const body = parsed.data

    // Access token + CSRF + rate limit (class 'chat': agent turns are the
    // expensive path) + tenant isolation, in ONE call.
    const gate = await guard(req, {
      businessId: body.businessId,
      userId: body.userId,
      class: 'chat',
    })
    if (!gate.ok) return gate.res
    const { business, user } = gate.actor

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

    // R34 — «جرّب تاني» بعد ما النت يقطع.
    // The composer sends a stable `turnId`. A retry therefore (a) reuses the
    // user message instead of writing a second one, and (b) if the first
    // attempt actually finished server-side (the stream died on the way back),
    // replays that reply instead of running the turn — and its drafts — twice.
    const turnId = body.turnId ?? null
    const priorUser = turnId
      ? await db.message.findFirst({ where: { conversationId: conversation.id, role: 'user', clientTurnId: turnId } })
      : null
    const userMsg =
      priorUser ??
      (await db.message.create({
        data: { conversationId: conversation.id, role: 'user', text: body.text, ...(turnId ? { clientTurnId: turnId } : {}) },
      }))
    if (!priorUser) {
      // Auto-title on the FIRST user message of an untitled conversation
      const titleUpdate =
        conversation.title === 'محادثة جديدة' ? { title: autoTitle(body.text) } : {}
      await db.conversation.update({
        where: { id: conversation.id },
        data: { updatedAt: new Date(), lastMessageAt: new Date(), ...titleUpdate },
      })
    }
    // Did this exact turn already finish server-side? The assistant row is the
    // one created right after this user message (only user rows carry the id,
    // so the unique key stays one-per-turn).
    let finishedTurn: Awaited<ReturnType<typeof db.message.findFirst>> = null
    if (turnId && priorUser) {
      const candidate = await db.message.findFirst({
        where: { conversationId: conversation.id, role: 'assistant', createdAt: { gt: priorUser.createdAt } },
        orderBy: { createdAt: 'asc' },
      })
      const nextUser = candidate
        ? await db.message.findFirst({
            where: { conversationId: conversation.id, role: 'user', createdAt: { gt: priorUser.createdAt, lt: candidate.createdAt } },
            select: { id: true },
          })
        : null
      finishedTurn = candidate && !nextUser ? candidate : null
    }

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

    // R15 reflection: a correction opener («لا», «غلط», «مش كده», «قصدى») on
    // the PREVIOUS assistant reply extracts a lesson into agent memory.
    // Fire-and-forget by contract — it never throws, never blocks the turn.
    const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant')
    void maybeReflect(business.id, user.id, body.text, lastAssistant?.text ?? null)

    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        const send = (data: unknown) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        }
        try {
          send({ event: 'start', conversationId: conversation!.id, messageId: userMsg.id })
          if (finishedTurn) {
            // The work is already done — do not charge the owner a second turn,
            // do not duplicate the draft. Just deliver the same reply.
            const json = (v: string | null) => (v ? (JSON.parse(v) as unknown) : undefined)
            send({ event: 'delta', text: finishedTurn.text })
            const c0 = json(finishedTurn.card)
            if (c0) send({ event: 'card', card: c0 })
            const cs0 = json(finishedTurn.cards)
            if (cs0) send({ event: 'cards', cards: cs0 })
            const a0 = json(finishedTurn.actions)
            if (a0) send({ event: 'actions', actions: a0 })
            const v0 = json(finishedTurn.verified)
            const r0 = json(finishedTurn.research)
            send({
              event: 'done',
              messageId: finishedTurn.id,
              modelLabel: finishedTurn.modelLabel ?? undefined,
              replayed: true,
              ...(v0 ? { verified: v0 } : {}),
              ...(r0 ? { research: r0 } : {}),
            })
            return
          }
          const result = await runAgentTurn(
            {
              business: business!,
              user: user!,
              conversationId: conversation!.id,
              text: body.text,
              modelKey: body.modelKey ?? null,
              history: history.map((m) => ({ role: m.role, text: m.text })),
              deepResearch: body.deepResearch === true,
              turnId: turnId ?? undefined,
            },
            (ev) => send(ev),
          )

          // Persist assistant message (R15: research + verified ride along).
          // The WORK is already done at this point (draft written, card built):
          // a storage hiccup must not turn a successful turn into «حصل خطأ».
          let assistantMsg: { id: string } | null = null
          try {
            assistantMsg = await db.message.create({
            data: {
              conversationId: conversation!.id,
              role: 'assistant',
              text: result.replyText,
              ...(result.card ? { card: JSON.stringify(result.card) } : {}),
              ...(result.cards ? { cards: JSON.stringify(result.cards) } : {}),
              ...(result.actions ? { actions: JSON.stringify(result.actions) } : {}),
              ...(result.research ? { research: JSON.stringify(result.research) } : {}),
              ...(result.verified ? { verified: JSON.stringify(result.verified) } : {}),
              thinking: JSON.stringify(result.thinking),
              modelLabel: result.modelLabel,
            },
          })
          } catch (persistErr) {
            console.error('[api/chat POST] assistant persist failed', persistErr)
          }
          // one full turn = 2 messages (user + assistant) — cheap increment
          await db.conversation
            .update({
              where: { id: conversation!.id },
              data: { updatedAt: new Date(), lastMessageAt: new Date(), messageCount: { increment: assistantMsg ? 2 : 1 } },
            })
            .catch(() => null)
          // done payload is ADDITIVE: verified/research/notesUpdated appear
          // only when the turn actually produced them (front consumes optionally)
          send({
            event: 'done',
            messageId: assistantMsg?.id ?? null,
            ...(assistantMsg ? {} : { persistFailed: true }),
            modelLabel: result.modelLabel,
            ...(result.verified ? { verified: result.verified } : {}),
            ...(result.research ? { research: result.research } : {}),
            ...(result.notesJotted && result.notesJotted > 0 ? { notesUpdated: true } : {}),
          })
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
