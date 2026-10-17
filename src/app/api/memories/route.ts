// /api/memories — وكيل's memory entries.
// GET    ?businessId[&active=true] → MemoryDTO[] (new fields), newest first.
// POST   {businessId,userId,text,kind?} → save a fact/preference/rule + instant sync.
// PATCH  {id,text?,active?,category?} → edit / (de)activate («انسى» path) + instant sync.
// DELETE ?id= → remove an entry entirely.
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { MemoryDTO } from '@/lib/types'
import { isRuleText, preferenceCategory, ruleCategory } from '@/lib/agent/memory'
import { decisionEngine } from '@/lib/agent/decision-middleware'
import { badRequest, notFound, searchParams, serverError } from '../_lib/http'
import { guard } from '../_lib/guard'
import { serializeMemory } from '../_lib/serialize'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      businessId?: string
      userId?: string
      text?: string
      kind?: string
      category?: string
    }
    if (!body.businessId) return badRequest('businessId مطلوب')
    if (!body.userId) return badRequest('userId مطلوب')
    const gate = await guard(req, { businessId: body.businessId, userId: body.userId })
    if (!gate.ok) return gate.res
    const trimmed = body.text?.trim()
    if (!trimmed) return badRequest('نص الذاكرة مطلوب')

    const kind = ['fact', 'preference', 'rule', 'lexicon', 'insight'].includes(String(body.kind))
      ? (String(body.kind) as MemoryDTO['kind'])
      : isRuleText(trimmed)
        ? 'rule'
        : 'preference'

    const category =
      body.category?.trim().slice(0, 40) ||
      (kind === 'rule'
        ? ruleCategory(trimmed)
        : kind === 'preference' || kind === 'fact'
          ? preferenceCategory(trimmed)
          : 'general')

    const memory = await db.agentMemory.create({
      data: {
        businessId: body.businessId,
        userId: body.userId,
        kind,
        category,
        text: trimmed.slice(0, 500),
        confidence: kind === 'rule' ? 0.95 : 0.9,
      },
    })

    if (kind === 'rule') {
      await decisionEngine.syncSystemOnMutation({
        businessId: body.businessId,
        userId: body.userId,
        mutationType: 'rule_updated',
        title: category,
        detail: trimmed.slice(0, 500),
      })
    }

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
    const gate = await guard(req, { scope: 'business' })
    if (!gate.ok) return gate.res

    const body = (await req.json()) as {
      id?: string
      text?: string
      active?: boolean
      category?: string
    }
    if (!body.id) return badRequest('id مطلوب')

    const existing = await db.agentMemory.findUnique({ where: { id: body.id } })
    if (!existing) return notFound('الذاكرة دي مش موجودة')

    const data: { text?: string; active?: boolean; category?: string; updatedAt: Date } = { updatedAt: new Date() }
    if (typeof body.text === 'string') {
      if (!body.text.trim()) return badRequest('نص الذاكرة فاضي')
      data.text = body.text.trim().slice(0, 500)
    }
    if (typeof body.active === 'boolean') data.active = body.active
    if (typeof body.category === 'string') data.category = body.category.trim().slice(0, 40) || 'general'

    const memory = await db.agentMemory.update({ where: { id: body.id }, data })

    if (memory.kind === 'rule' && typeof body.text === 'string') {
      await decisionEngine.syncSystemOnMutation({
        businessId: memory.businessId,
        userId: memory.userId,
        mutationType: 'rule_updated',
        title: memory.category,
        detail: memory.text,
      })
    }

    return NextResponse.json(serializeMemory(memory))
  } catch (e) {
    return serverError('memories-patch', e)
  }
}

export async function DELETE(req: Request) {
  try {
    const gate = await guard(req, { scope: 'business' })
    if (!gate.ok) return gate.res

    const sp = searchParams(req)
    const id = sp.get('id')
    if (!id) return badRequest('id مطلوب')

    const existing = await db.agentMemory.findUnique({ where: { id } })
    if (!existing) return notFound('الذاكرة دي مش موجودة')

    await db.agentMemory.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return serverError('memories-delete', e)
  }
}

