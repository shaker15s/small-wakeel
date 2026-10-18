import { NextRequest, NextResponse } from 'next/server'
import { guard } from '../../_lib/guard'
import { getWorkspacePreferences, updateWorkspacePreferences } from '@/lib/workspace-preferences'
import { preferencePatchSchema } from '@/lib/workspace-options'
import { AuthorizationError } from '@/lib/security/permissions'
import { serverError } from '../../_lib/http'
export const dynamic = 'force-dynamic'
export async function GET(req: NextRequest) {
  try {
    const gate = await guard(req, { businessId: req.nextUrl.searchParams.get('businessId'), userId: req.nextUrl.searchParams.get('userId') })
    if (!gate.ok) return gate.res
    return NextResponse.json(await getWorkspacePreferences(gate.actor.business.id, gate.actor.user.id))
  } catch (e) { return e instanceof AuthorizationError ? NextResponse.json({ error: e.message }, { status: 403 }) : serverError('workspace-get', e) }
}
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'بيانات غير صالحة' }, { status: 400 })
    const { businessId, userId, ...patch } = body
    const gate = await guard(req, { businessId, userId, permission: 'workspace.personalize' })
    if (!gate.ok) return gate.res
    const parsed = preferencePatchSchema.safeParse(patch)
    if (!parsed.success) return NextResponse.json({ error: 'اختار إعدادات معتمدة فقط؛ الكود والألوان الحرة وتغيير الصلاحيات غير مسموح' }, { status: 400 })
    return NextResponse.json(await updateWorkspacePreferences(gate.actor.business.id, gate.actor.user.id, parsed.data))
  } catch (e) { return e instanceof AuthorizationError ? NextResponse.json({ error: e.message }, { status: 403 }) : serverError('workspace-patch', e) }
}
