// R75 / PR-007 — the onboarding state machine API.
//
//   GET  /api/onboarding/profile?businessId=&userId=
//     → { stage, answers, consents, pending, questions, openingCashStatedAt }
//     `pending` is the server's single source of truth for «what is NOT yet
//     answered» — the client can never re-ask an answered question.
//
//   POST /api/onboarding/profile  { businessId, userId, key, value?, skip? }
//     → the new state. An answer is persisted IMMEDIATELY (a refresh never
//     loses progress); a skipped financial fact stays unknown, not 0.
import { NextRequest, NextResponse } from 'next/server'
import { guard } from '../../_lib/guard'
import { serverError } from '../../_lib/http'
import { answerProfile, getProfileState } from '@/lib/domain/onboarding-profile'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    const gate = await guard(req, { businessId: req.nextUrl.searchParams.get('businessId'), userId: req.nextUrl.searchParams.get('userId') })
    if (!gate.ok) return gate.res
    return NextResponse.json(await getProfileState(gate.actor.business.id))
  } catch (e) {
    return serverError('onboarding-profile-get', e)
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'بيانات غير صالحة' }, { status: 400 })
    const { businessId, userId, key, value, skip } = body as { businessId?: string; userId?: string; key?: string; value?: string | number | null; skip?: boolean }
    const gate = await guard(req, { businessId, userId, permission: 'business.configure' })
    if (!gate.ok) return gate.res
    if (typeof key !== 'string' || key.length === 0) return NextResponse.json({ error: 'السؤال مطلوب' }, { status: 400 })
    const state = await answerProfile(gate.actor.business.id, key, skip ? null : (value ?? null), { skip: Boolean(skip) })
    return NextResponse.json(state)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'تعذّر حفظ الإجابة'
    if (/سؤال|الإجابة|المبلغ|لازم/.test(msg)) return NextResponse.json({ error: msg }, { status: 400 })
    return serverError('onboarding-profile-answer', e)
  }
}
