import { canUsePermission } from '@/lib/security/permissions'
// /api/quick-commands — أدواتك السريعة (user-extensible tools).
// GET    ?businessId → QuickCommandDTO[] (sortOrder asc).
// POST   {businessId,userId,label,prompt,icon} — label ≤24, prompt ≤200,
//        icon ∈ allowed set, max 12 commands per user.
// PATCH  {id,label?,prompt?,icon?,sortOrder?} — or {id,touch:true} to bump
//        usageCount (when the user fires the command from the composer).
// DELETE ?id=.
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { QuickCommandDTO } from '@/lib/types'
import { badRequest, notFound, searchParams, serverError } from '../_lib/http'
import { guard } from '../_lib/guard'

export const dynamic = 'force-dynamic'

const ALLOWED_ICONS = ['spark', 'boxes', 'users', 'wallet', 'chart', 'book', 'today', 'alert'] as const
const MAX_LABEL = 24
const MAX_PROMPT = 200
const MAX_COMMANDS = 12

interface QuickCommandRow {
  id: string
  label: string
  prompt: string
  icon: string
  sortOrder: number
  usageCount: number
  createdAt: Date
}

function serialize(c: QuickCommandRow): QuickCommandDTO {
  return {
    id: c.id,
    label: c.label,
    prompt: c.prompt,
    icon: c.icon,
    sortOrder: c.sortOrder,
    usageCount: c.usageCount,
    createdAt: c.createdAt.toISOString(),
  }
}

/** Validate label/prompt/icon lengths against the tool contract. */
function validateFields(label?: unknown, prompt?: unknown, icon?: unknown): string | null {
  if (typeof label === 'string') {
    const trimmed = label.trim()
    if (!trimmed) return 'اسم الأداة مطلوب'
    if (trimmed.length > MAX_LABEL) return `اسم الأداة طويل — أقصى ${MAX_LABEL} حرف`
  }
  if (typeof prompt === 'string') {
    const trimmed = prompt.trim()
    if (!trimmed) return 'الأمر مطلوب'
    if (trimmed.length > MAX_PROMPT) return `الأمر طويل — أقصى ${MAX_PROMPT} حرف`
  }
  if (typeof icon === 'string' && !ALLOWED_ICONS.includes(icon as (typeof ALLOWED_ICONS)[number])) {
    return 'الأيقونة دي مش متاحة'
  }
  return null
}

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

export async function GET(req: Request) {
  try {
    const sp = searchParams(req)
    const businessId = sp.get('businessId')
    if (!businessId) return badRequest('businessId مطلوب')
    const gate = await guard(req, { businessId, scope: 'business' })
    if (!gate.ok) return gate.res

    const rows = await db.quickCommand.findMany({
      where: { businessId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    })
    return NextResponse.json(rows.map(serialize))
  } catch (e) {
    return serverError('quick-commands', e)
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      businessId?: string
      userId?: string
      label?: string
      prompt?: string
      icon?: string
    }
    if (!body.businessId) return badRequest('businessId مطلوب')
    if (!body.userId) return badRequest('userId مطلوب')

    const gate = await guard(req, { businessId: body.businessId, userId: body.userId })
    if (!gate.ok) return gate.res

    const label = body.label?.trim()
    const prompt = body.prompt?.trim()
    if (!label) return badRequest('اسم الأداة مطلوب')
    if (!prompt) return badRequest('الأمر مطلوب')
    const fieldError = validateFields(label, prompt, body.icon)
    if (fieldError) return badRequest(fieldError)

    const count = await db.quickCommand.count({ where: { businessId: body.businessId, userId: body.userId } })
    if (count >= MAX_COMMANDS) return badRequest(`وصلت الحد الأقصى — ${MAX_COMMANDS} أداة`)

    const last = await db.quickCommand.findFirst({
      where: { businessId: body.businessId, userId: body.userId },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    })

    const created = await db.quickCommand.create({
      data: {
        businessId: body.businessId,
        userId: body.userId,
        label,
        prompt,
        icon: ALLOWED_ICONS.includes(body.icon as (typeof ALLOWED_ICONS)[number]) ? body.icon! : 'spark',
        sortOrder: (last?.sortOrder ?? -1) + 1,
      },
    })
    return NextResponse.json(serialize(created), { status: 201 })
  } catch (e) {
    return serverError('quick-commands-post', e)
  }
}

export async function PATCH(req: Request) {
  try {
    const body = (await req.json()) as {
      id?: string
      label?: string
      prompt?: string
      icon?: string
      sortOrder?: number
      touch?: boolean
    }
    if (!body.id) return badRequest('id مطلوب')

    const existing = await db.quickCommand.findUnique({ where: { id: body.id } })
    if (!existing) return notFound('الأداة مش موجودة')
    const gate = await guard(req, { businessId: existing.businessId })
    if (!gate.ok) return gate.res

    // usage ping from the composer — bump usageCount, ignore other fields
    if (body.touch === true) {
      const touched = await db.quickCommand.update({
        where: { id: body.id },
        data: { usageCount: { increment: 1 } },
      })
      return NextResponse.json(serialize(touched))
    }

    if (existing.userId !== gate.actor.user.id && !canUsePermission(gate.actor.user.role, 'tools.manage')) {
      return NextResponse.json({ error: 'الأداة دي مش تبعك' }, { status: 403 })
    }

    const fieldError = validateFields(body.label, body.prompt, body.icon)
    if (fieldError) return badRequest(fieldError)

    const data: { label?: string; prompt?: string; icon?: string; sortOrder?: number } = {}
    if (typeof body.label === 'string') data.label = body.label.trim()
    if (typeof body.prompt === 'string') data.prompt = body.prompt.trim()
    if (ALLOWED_ICONS.includes(body.icon as (typeof ALLOWED_ICONS)[number])) data.icon = body.icon
    if (typeof body.sortOrder === 'number' && Number.isFinite(body.sortOrder)) {
      data.sortOrder = Math.trunc(body.sortOrder)
    }

    const updated = await db.quickCommand.update({ where: { id: body.id }, data })
    return NextResponse.json(serialize(updated))
  } catch (e) {
    return serverError('quick-commands-patch', e)
  }
}

export async function DELETE(req: Request) {
  try {
    const sp = searchParams(req)
    const id = sp.get('id')
    if (!id) return badRequest('id مطلوب')

    const existing = await db.quickCommand.findUnique({ where: { id } })
    if (!existing) return notFound('الأداة مش موجودة')
    const gate = await guard(req, { businessId: existing.businessId })
    if (!gate.ok) return gate.res

    if (existing.userId !== gate.actor.user.id && !canUsePermission(gate.actor.user.role, 'tools.manage')) {
      return NextResponse.json({ error: 'الأداة دي مش تبعك' }, { status: 403 })
    }
    await db.quickCommand.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return serverError('quick-commands-delete', e)
  }
}
