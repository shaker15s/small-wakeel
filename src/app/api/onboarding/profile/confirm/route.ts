// R75 / PR-007 — the owner confirms the proposed Business Profile
// after reviewing + correcting. Idempotent: re-confirming is a no-op.
import { NextRequest, NextResponse } from 'next/server'
import { guard } from '../../../_lib/guard'
import { serverError } from '../../../_lib/http'
import { confirmProfile } from '@/lib/domain/onboarding-profile'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'بيانات غير صالحة' }, { status: 400 })
    const { businessId, userId } = body as { businessId?: string; userId?: string }
    const gate = await guard(req, { businessId, userId, permission: 'business.configure' })
    if (!gate.ok) return gate.res
    const state = await confirmProfile(gate.actor.business.id)
    return NextResponse.json(state)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'تعذّر تأكيد الملف'
    if (/أسئلة|لازم/.test(msg)) return NextResponse.json({ error: msg }, { status: 400 })
    return serverError('onboarding-confirm', e)
  }
}
