// GET /api/morning-brief?businessId&userId → MorningBrief
//
// Deterministic (no model): the three things worth doing now, ranked by the
// money at stake, each with the exact chat prompt that fixes it.
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { badRequest, notFound, searchParams, serverError } from '../_lib/http'
import { guard } from '../_lib/guard'
import { buildMorningBrief } from '@/lib/agent/brief'

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

    const business = await db.business.findUnique({ where: { id: businessId }, select: { id: true } })
    if (!business) return notFound('النشاط التجاري غير موجود')

    const brief = await buildMorningBrief(businessId, userId)
    // the brief is a snapshot of a living ledger — never cache it
    return NextResponse.json(brief, { headers: { 'cache-control': 'no-store' } })
  } catch (e) {
    return serverError('morning-brief', e)
  }
}
