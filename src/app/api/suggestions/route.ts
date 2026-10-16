// GET /api/suggestions?businessId&userId → SuggestionDTO[] (max 8).
// Ranked: alert-driven > frequent (UsageEvent top) > memory/vertical > time.
// NEVER static — computed live on every call from DB state + usage history.
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { badRequest, notFound, searchParams, serverError } from '../_lib/http'
import { guard } from '../_lib/guard'
import { buildSuggestions } from '@/lib/agent/suggest'

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
      db.user.findUnique({ where: { id: userId }, select: { id: true } }),
    ])
    if (!business) return notFound('النشاط التجاري غير موجود')
    if (!user) return notFound('المستخدم غير موجود')

    const suggestions = await buildSuggestions(businessId, userId)
    return NextResponse.json(suggestions)
  } catch (e) {
    return serverError('suggestions', e)
  }
}
