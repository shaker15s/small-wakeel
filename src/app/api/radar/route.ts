// GET /api/radar?businessId&userId → RadarInsightDTO[]
// OWNER-ONLY: if the passed user's role !== 'owner' → [] (honesty radar is
// the owner's private instrument — cashiers never see it).
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { badRequest, notFound, searchParams, serverError } from '../_lib/http'
import { guard } from '../_lib/guard'
import { buildRadar } from '@/lib/agent/radar'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const sp = searchParams(req)
        const businessId = sp.get('businessId')
    if (!businessId) return badRequest('businessId مطلوب')
    const userId = sp.get('userId')
    if (!userId) return badRequest('userId مطلوب')
    const gate = await guard(req, { businessId, userId })
    if (!gate.ok) return gate.res

    const [business, user] = await Promise.all([
      db.business.findUnique({ where: { id: businessId }, select: { id: true } }),
      db.user.findUnique({ where: { id: userId }, select: { id: true, role: true } }),
    ])
    if (!business) return notFound('النشاط التجاري غير موجود')
    if (!user) return notFound('المستخدم غير موجود')

    if (user.role !== 'owner') return NextResponse.json([])

    const insights = await buildRadar(businessId)
    return NextResponse.json(insights)
  } catch (e) {
    return serverError('radar', e)
  }
}
