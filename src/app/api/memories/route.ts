// /api/memories — وكيل's memory entries.
// GET    ?businessId[&active=true] → MemoryDTO[] (new fields), newest first.
// POST   {businessId,userId,text,kind?} → save a fact/preference.
// PATCH  {id,text?,active?,category?} → edit / (de)activate («انسى» path).
// DELETE ?id= → remove an entry entirely.
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { MemoryDTO } from '@/lib/types'
import { badRequest, notFound, searchParams, serverError } from '../_lib/http'
import { guard } from '../_lib/guard'
import { serializeMemory } from '../_lib/serialize'
import { memoryPostSchema, parseBody } from '@/lib/security/validate'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const parsed = await parseBody(req, memoryPostSchema)
    if (!parsed.ok) return badRequest(parsed.message)
    const body = parsed.data

    const gate = await guard(req, { businessId: body.businessId, userId: body.userId })
    if (!gate.ok) return gate.res

    const memory = await db.agentMemory.create({
      data: {
        businessId: body.businessId,
        userId: body.userId,
        kind: body.kind,
        category: body.category,
        ...(body.entityRef ? { entityRef: body.entityRef } : {}),
        ...(typeof body.confidence === 'number' ? { confidence: body.confidence } : {}),
        text: body.text,
      },
    })
    return NextResponse.json(serializeMemory(memory), { status: 201 })
  } catch (e) {
    return serverError('memories-post', e)
  }
}

export async function GET(req: Request) {
  try {
    const sp = searchParams(req)
    const businessId = sp.get('businessId')
    if (!businessId) return badRequest('businessId مطلوب')
    const gate = await guard(req, { businessId, scope: 'business' })
    if (!gate.ok) return gate.res
    const activeOnly = sp.get('active')

    const memories = await db.agentMemory.findMany({
      where: { businessId, ...(activeOnly === 'true' ? { active: true } : {}) },
      orderBy: { createdAt: 'desc' },
    })

    const dto: MemoryDTO[] = memories.map(serializeMemory)
    return NextResponse.json(dto)
  } catch (e) {
    return serverError('memories', e)
  }
}

export async function PATCH(req: Request) {
  try {
    const body = (await req.json()) as {
      id?: string
      text?: string
      active?: boolean
      category?: string
    }
    if (!body.id) return badRequest('id مطلوب')

    const existing = await db.agentMemory.findUnique({ where: { id: body.id } })
    if (!existing) return notFound('الذاكرة دي مش موجودة')

    // Ownership: the caller must belong to the business that owns this memory.
    const gate = await guard(req, { businessId: existing.businessId })
    if (!gate.ok) return gate.res

    const data: { text?: string; active?: boolean; category?: string; updatedAt: Date } = { updatedAt: new Date() }
    if (typeof body.text === 'string') {
      if (!body.text.trim()) return badRequest('نص الذاكرة فاضي')
      data.text = body.text.trim().slice(0, 500)
    }
    if (typeof body.active === 'boolean') data.active = body.active
    if (typeof body.category === 'string') data.category = body.category.trim().slice(0, 40) || 'general'

    const memory = await db.agentMemory.update({ where: { id: body.id }, data })
    return NextResponse.json(serializeMemory(memory))
  } catch (e) {
    return serverError('memories-patch', e)
  }
}

export async function DELETE(req: Request) {
  try {
    const sp = searchParams(req)
    const id = sp.get('id')
    if (!id) return badRequest('id مطلوب')

    const existing = await db.agentMemory.findUnique({ where: { id } })
    if (!existing) return notFound('الذاكرة دي مش موجودة')

    const gate = await guard(req, { businessId: existing.businessId })
    if (!gate.ok) return gate.res

    await db.agentMemory.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return serverError('memories-delete', e)
  }
}
