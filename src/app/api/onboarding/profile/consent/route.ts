// R75 / PR-007 — consent is STATE the import routes enforce.
//   POST { businessId, userId, key, granted } → new profile state.
import { NextRequest, NextResponse } from 'next/server'
import { guard } from '../../../_lib/guard'
import { serverError } from '../../../_lib/http'
import { setProfileConsent, PROFILE_CONSENTS } from '@/lib/domain/onboarding-profile'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'بيانات غير صالحة' }, { status: 400 })
    const { businessId, userId, key, granted } = body as { businessId?: string; userId?: string; key?: string; granted?: boolean }
    const gate = await guard(req, { businessId, userId, permission: 'business.configure' })
    if (!gate.ok) return gate.res
    if (!PROFILE_CONSENTS.some((c) => c.key === key)) {
      return NextResponse.json({ error: 'نوع موافقة غير معتمد — المصادقة هنا موافقات على استيراد بياناتك بس' }, { status: 400 })
    }
    const state = await setProfileConsent(gate.actor.business.id, key as (typeof PROFILE_CONSENTS)[number]['key'], Boolean(granted))
    return NextResponse.json(state)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'تعذّر حفظ الموافقة'
    if (/موافقة/.test(msg)) return NextResponse.json({ error: msg }, { status: 400 })
    return serverError('onboarding-consent', e)
  }
}
