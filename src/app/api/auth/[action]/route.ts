import { NextResponse } from 'next/server'
import { z } from 'zod'
import { guard } from '@/app/api/_lib/guard'
import { serverError } from '@/app/api/_lib/http'
import { cookieHeader, resolveSession, saasEnabled } from '@/lib/saas/session'
import { SaasError } from '@/lib/saas/crypto'
import { authenticatedAction, login, loginMfa, me, register, registrationEnabled, requestReset, resetPassword, sessions, team, verifyEmail } from '@/lib/saas/service'

export const dynamic = 'force-dynamic'
const publicActions = new Set(['register', 'login', 'login-mfa', 'request-reset', 'reset', 'verify'])
const schema = z.object({
  email: z.string().trim().email().max(254).optional(),
  password: z.string().max(128).optional(), currentPassword: z.string().max(128).optional(),
  name: z.string().trim().min(1).max(60).optional(), businessName: z.string().trim().min(1).max(80).optional(),
  type: z.enum(['supermarket', 'gym', 'pharmacy', 'attar']).optional(),
  token: z.string().min(1).max(128).optional(), code: z.string().min(1).max(64).optional(),
  userId: z.string().max(64).optional(), membershipId: z.string().max(64).optional(),
  invitationId: z.string().max(64).optional(), sessionId: z.string().max(64).optional(),
  role: z.enum(['supervisor', 'cashier', 'reception']).optional(), disabled: z.enum(['true', 'false']).optional(),
})
function failure(e: unknown) {
  if (e instanceof SaasError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status })
  return serverError('auth', e)
}
export async function GET(req: Request, context: { params: Promise<{ action: string }> }) {
  try {
    const { action } = await context.params
    const gate = await guard(req, { scope: action === 'config' ? 'auth' : 'open' })
    if (!gate.ok) return gate.res
    if (action === 'config') return NextResponse.json({ saasEnabled: saasEnabled(), registrationEnabled: saasEnabled() && registrationEnabled() })
    const identity = await resolveSession(req)
    if (!identity) throw new SaasError('محتاج تسجيل الدخول', 401)
    if (action === 'me') return NextResponse.json(await me(identity))
    if (action === 'team') return NextResponse.json(await team(identity))
    if (action === 'sessions') return NextResponse.json(await sessions(identity))
    throw new SaasError('المسار غير موجود', 404)
  } catch (e) { return failure(e) }
}
export async function POST(req: Request, context: { params: Promise<{ action: string }> }) {
  try {
    const { action } = await context.params
    const gate = await guard(req, { scope: publicActions.has(action) ? 'auth' : 'open', class: 'write' })
    if (!gate.ok) return gate.res
    if (!saasEnabled()) throw new SaasError('تسجيل SaaS غير مفعّل', 503)
    const reader = req.body?.getReader()
    const chunks: Uint8Array[] = []; let size = 0
    if (reader) {
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break
          size += value.byteLength
          if (size > 16_384) { await reader.cancel(); throw new SaasError('حجم الطلب أكبر من المسموح', 413) }
          chunks.push(value)
        }
      } finally { reader.releaseLock() }
    }
    let raw: unknown
    try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new SaasError('JSON غير صالح') }
    const parsed = schema.safeParse(raw)
    if (!parsed.success) throw new SaasError('راجع الحقول: بريد صالح وأطوال القيم المسموحة')
    const p = parsed.data
    let result: unknown
    if (action === 'register') result = await register(p, gate.ip)
    else if (action === 'login') result = await login(p, gate.ip)
    else if (action === 'login-mfa') result = await loginMfa(p, gate.ip)
    else if (action === 'request-reset') result = await requestReset(p, gate.ip)
    else if (action === 'reset') result = await resetPassword(p, gate.ip)
    else if (action === 'verify') result = await verifyEmail(p)
    else {
      const identity = await resolveSession(req)
      if (!identity) throw new SaasError('محتاج تسجيل الدخول', 401)
      result = await authenticatedAction(action, p, identity)
    }
    if (result && typeof result === 'object' && 'session' in result && 'token' in result) {
      const issued = result as Awaited<ReturnType<typeof register>>
      return NextResponse.json({ ok: true, csrfToken: issued.csrfToken }, { headers: { 'set-cookie': cookieHeader(issued.token, issued.session.expiresAt) } })
    }
    const clearing = ['logout', 'logout-all', 'change-password', 'mfa-disable', 'reset'].includes(action)
    return NextResponse.json(result, { headers: clearing ? { 'set-cookie': cookieHeader('', new Date(0)) } : undefined })
  } catch (e) { return failure(e) }
}
