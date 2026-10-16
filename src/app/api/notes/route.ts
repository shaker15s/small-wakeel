// /api/notes — «ورقة وكيل» scratchpad CRUD (R15). (R15)
// GET    ?businessId&conversationId → NoteDTO[] (active only, pinned first,
//        then newest first).
// POST   {businessId,userId,conversationId,kind,text,source?,pinned?} → NoteDTO
//        (kind must be in the 5-union, text 1..500).
// PATCH  {id,text?,pinned?,active?} → NoteDTO.
// DELETE ?id= → soft-delete (active=false) → {ok:true}.
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { NoteDTO } from '@/lib/types'
import { badRequest, notFound, searchParams, serverError } from '../_lib/http'
import { serializeNote } from '../_lib/serialize'
import { ensurePrismaFresh } from '@/lib/agent/scratchpad'

export const dynamic = 'force-dynamic'

const NOTE_KINDS: ReadonlySet<string> = new Set(['fact', 'hypothesis', 'todo', 'plan', 'citation'])
const TEXT_MIN = 1
const TEXT_MAX = 500

/** GET: the live paper — pinned notes first, then the newest active ones. */
export async function GET(req: Request) {
  ensurePrismaFresh()
  try {
    const sp = searchParams(req)
    const businessId = sp.get('businessId')
    if (!businessId) return badRequest('businessId مطلوب')
    const conversationId = sp.get('conversationId')
    if (!conversationId) return badRequest('conversationId مطلوب')

    const [business, conversation] = await Promise.all([
      db.business.findUnique({ where: { id: businessId }, select: { id: true } }),
      db.conversation.findFirst({ where: { id: conversationId, businessId }, select: { id: true } }),
    ])
    if (!business) return notFound('النشاط التجاري غير موجود')
    if (!conversation) return notFound('المحادثة غير موجودة')

    const rows = await db.agentNote.findMany({
      where: { conversationId, active: true },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      take: 60,
    })
    const dto: NoteDTO[] = rows.map(serializeNote)
    return NextResponse.json(dto)
  } catch (e) {
    return serverError('notes', e)
  }
}

/** POST: the agent (or the UI) jots a note on the paper. */
export async function POST(req: Request) {
  ensurePrismaFresh()
  try {
    const body = (await req.json()) as {
      businessId?: string
      userId?: string
      conversationId?: string
      kind?: string
      text?: string
      source?: string
      pinned?: boolean
    }
    if (!body.businessId) return badRequest('businessId مطلوب')
    if (!body.userId) return badRequest('userId مطلوب')
    if (!body.conversationId) return badRequest('conversationId مطلوب')
    const kind = String(body.kind ?? 'fact')
    if (!NOTE_KINDS.has(kind)) return badRequest('نوع الملاحظة لازم يكون fact/hypothesis/todo/plan/citation')
    const text = String(body.text ?? '').trim().replace(/\s+/g, ' ')
    if (text.length < TEXT_MIN) return badRequest('نص الملاحظة فاضي')
    if (text.length > TEXT_MAX) return badRequest('نص الملاحظة أطول من ٥٠٠ حرف')

    const [business, user, conversation] = await Promise.all([
      db.business.findUnique({ where: { id: body.businessId }, select: { id: true } }),
      db.user.findUnique({ where: { id: body.userId }, select: { id: true, businessId: true } }),
      db.conversation.findFirst({ where: { id: body.conversationId, businessId: body.businessId }, select: { id: true } }),
    ])
    if (!business) return notFound('النشاط التجاري غير موجود')
    if (!user) return notFound('المستخدم غير موجود')
    if (user.businessId !== body.businessId) return badRequest('المستخدم مش تابع للنشاط ده')
    if (!conversation) return notFound('المحادثة غير موجودة')

    const created = await db.agentNote.create({
      data: {
        businessId: body.businessId,
        userId: body.userId,
        conversationId: body.conversationId,
        kind,
        text,
        ...(body.source ? { source: String(body.source).slice(0, 80) } : {}),
        ...(body.pinned === true ? { pinned: true } : {}),
      },
    })
    return NextResponse.json(serializeNote(created))
  } catch (e) {
    return serverError('notes', e)
  }
}

/** PATCH: edit the text / pin / (de)activate a note. */
export async function PATCH(req: Request) {
  ensurePrismaFresh()
  try {
    const body = (await req.json()) as {
      id?: string
      text?: string
      pinned?: boolean
      active?: boolean
    }
    if (!body.id) return badRequest('id مطلوب')
    if (body.text !== undefined) {
      const text = String(body.text).trim().replace(/\s+/g, ' ')
      if (text.length < TEXT_MIN) return badRequest('نص الملاحظة فاضي')
      if (text.length > TEXT_MAX) return badRequest('نص الملاحظة أطول من ٥٠٠ حرف')
    }

    const existing = await db.agentNote.findUnique({ where: { id: body.id } })
    if (!existing) return notFound('الملاحظة مش موجودة')

    const updated = await db.agentNote.update({
      where: { id: body.id },
      data: {
        ...(body.text !== undefined ? { text: String(body.text).trim().replace(/\s+/g, ' ').slice(0, TEXT_MAX) } : {}),
        ...(body.pinned !== undefined ? { pinned: body.pinned === true } : {}),
        ...(body.active !== undefined ? { active: body.active === true } : {}),
      },
    })
    return NextResponse.json(serializeNote(updated))
  } catch (e) {
    return serverError('notes', e)
  }
}

/** DELETE: soft-delete — the paper never loses history, it just deactivates. */
export async function DELETE(req: Request) {
  ensurePrismaFresh()
  try {
    const sp = searchParams(req)
    const id = sp.get('id')
    if (!id) return badRequest('id مطلوب')
    const existing = await db.agentNote.findUnique({ where: { id } })
    if (!existing) return notFound('الملاحظة مش موجودة')
    await db.agentNote.update({ where: { id }, data: { active: false } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return serverError('notes', e)
  }
}
