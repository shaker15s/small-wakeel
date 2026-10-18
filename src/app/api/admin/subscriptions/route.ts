// Explicit operator contracts, NOT a fake payment webhook/checkout.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { guard } from '../../_lib/guard'
import { badRequest, serverError } from '../../_lib/http'
import { parseBody } from '@/lib/security/validate'
const schema = z.object({ businessId: z.string().min(1).max(64), plan: z.enum(['trial', 'manual']), status: z.enum(['trialing', 'active', 'suspended']), trialEndsAt: z.coerce.date(), seatLimit: z.number().int().min(1).max(1000), dailyChatLimit: z.number().int().min(1).max(10000), reason: z.string().trim().min(5).max(500) })
export async function POST(req: Request) {
  try {
    const gate = await guard(req, { scope: 'admin' })
    if (!gate.ok) return gate.res
    if (!gate.principal) return NextResponse.json({ error: 'هوية مشغّل صريحة مطلوبة حتى في التطوير' }, { status: 403 })
    const parsed = await parseBody(req, schema)
    if (!parsed.ok) return badRequest(parsed.message)
    const { businessId, reason, ...config } = parsed.data
    if ((config.plan === 'trial') !== (config.status === 'trialing')) return badRequest('الخطة التجريبية تحتاج حالة trialing، والعقد اليدوي active أو suspended')
    const subscription = await db.$transaction(async (tx) => {
      const actors = await tx.user.findMany({ where: { businessId }, select: { id: true } })
      const occupied = await tx.membership.count({ where: { userId: { in: actors.map((u) => u.id) }, disabledAt: null } })
      const invited = await tx.invitation.count({ where: { businessId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } })
      if (occupied + invited > config.seatLimit) return null
      const row = await tx.subscription.upsert({ where: { businessId }, create: { businessId, ...config }, update: config })
      await tx.auditEvent.create({ data: { businessId, actor: gate.principal!.user.id, action: 'saas.subscription.operator_updated', detail: JSON.stringify({ reason, ...config }) } })
      return row
    })
    if (!subscription) return NextResponse.json({ error: 'المقاعد الحالية والدعوات أكبر من الحد المطلوب' }, { status: 409 })
    return NextResponse.json({ subscription, paymentProcessed: false })
  } catch (e) { return serverError('admin-subscription', e) }
}
