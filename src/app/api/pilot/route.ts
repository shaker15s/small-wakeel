// GET /api/pilot?businessId&days=30 — the pilot VALUE report (PR-015 / plan §13).
//
// «سجل خط أساس وبعدي لكل نشاط يوضح الوقت الفعلي للمهام، السجلات الناقصة،
// التصحيحات، حالات المتابعة، الأخطاء، وتكلفة التشغيل»
//
// Every number is measured from an append-only ledger (AgentEvent /
// Operation / AuditEvent / PendingRequest / UsageEvent) or is an
// owner-reported baseline row. Categories that cannot be measured are
// `null` + reason — never 0-as-unknown. Tenant-scoped like every read.
import { NextResponse } from 'next/server'
import { guard } from '../_lib/guard'
import { badRequest, searchParams, serverError } from '../_lib/http'
import { pilotValueReport } from '@/lib/pilot'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const sp = searchParams(req)
    const businessId = sp.get('businessId')
    if (!businessId) return badRequest('businessId مطلوب')
    // actor scope (not business scope): the report is an owner-facing value
    // view — the caller must be a member of the business they are reading
    const gate = await guard(req, { businessId })
    if (!gate.ok) return gate.res
    const days = Math.min(365, Math.max(1, Number(sp.get('days') ?? 30) || 30))
    const report = await pilotValueReport(businessId, days)
    return NextResponse.json(report, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    return serverError('pilot', e)
  }
}
