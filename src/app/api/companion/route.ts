// POST /api/companion — companion control plane (owner side, guarded):
//   { action: 'enroll', deviceName }                    → single-use code (5 min)
//   { action: 'activate', code, deviceName, allowlist } → device + token (once)
//   { action: 'revoke', deviceId }                      → immediate revocation
//   { action: 'job', deviceId, tool, args }             → dispatch one signed job
// GET  /api/companion?businessId=... — devices + recent jobs (honest states)
import { NextResponse } from 'next/server'
import { guard } from '../_lib/guard'
import { badRequest, notFound, serverError } from '../_lib/http'
import {
  activateDevice,
  createEnrollment,
  dispatchJob,
  listDevices,
  revokeDeviceWithJobs,
} from '@/lib/companion/companion'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const sp = new URL(req.url).searchParams
    const businessId = sp.get('businessId')
    if (!businessId) return badRequest('businessId مطلوب')
    const gate = await guard(req, { businessId, scope: 'business' })
    if (!gate.ok) return gate.res
    return NextResponse.json(await listDevices(businessId))
  } catch (e) {
    return serverError('companion-get', e)
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Record<string, unknown>

    // activate is performed by the bridge itself — the single-use code IS
    // its credential (it carries the businessId server-side); no browser
    // session exists on the user's machine.
    if (body.action === 'activate') {
      const code = String(body.code ?? '')
      if (!code) return badRequest('code مطلوب')
      const out = await activateDevice({
        code,
        deviceName: String(body.deviceName ?? 'جهاز المالك'),
        allowlist: (body.allowlist as { paths?: string[]; cli?: Array<{ command: string; label?: string }> } | undefined) ?? { paths: [], cli: [] },
      })
      if ('error' in out) return badRequest(out.error)
      return NextResponse.json(out, { status: 201 })
    }

    const businessId = String(body.businessId ?? '')
    if (!businessId) return badRequest('businessId مطلوب')

    const gate = await guard(req, { businessId, userId: String(body.userId ?? ''), permission: 'automation.manage' })
    if (!gate.ok) return gate.res

    if (body.action === 'enroll') {
      const out = await createEnrollment(businessId, String(body.deviceName ?? 'جهاز المالك'))
      return NextResponse.json(out, { status: 201 })
    }
    if (body.action === 'revoke') {
      const deviceId = String(body.deviceId ?? '')
      if (!deviceId) return badRequest('deviceId مطلوب')
      const out = await revokeDeviceWithJobs(deviceId, businessId)
      if (!out.device) return notFound('الجهاز غير موجود أو مفصول بالفعل')
      return NextResponse.json({ ok: true, expiredJobs: out.jobs })
    }
    if (body.action === 'job') {
      const out = await dispatchJob({
        businessId,
        deviceId: String(body.deviceId ?? ''),
        tool: String(body.tool ?? ''),
        args: (body.args as Record<string, unknown>) ?? {},
      })
      if ('error' in out) return badRequest(out.error)
      return NextResponse.json(out, { status: 201 })
    }
    return badRequest('action غير معروفة — enroll | activate | revoke | job')
  } catch (e) {
    return serverError('companion-post', e)
  }
}
