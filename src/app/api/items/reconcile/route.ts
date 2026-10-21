// POST /api/items/reconcile — Excel/CSV reconciliation (PR-012).
//
//   { action: 'dry-run', file, fileName? }
//     → per-row verdicts + field diffs. ZERO writes. Returns reportId +
//       contentHash (the fingerprint of exactly what was previewed).
//   { action: 'apply', reportId, contentHash, acknowledge: true }
//     → applies ONLY that previewed report (hash must match) after the
//       owner's explicit acknowledgement, in one transaction, then reads
//       back every applied row and stores the verification evidence.
//   { action: 'reports' } → the business's recent reports (honest states)
//   { action: 'connector' } → the §10.3 manifest with a COMPUTED state
//
// «لا write قبل dry-run/owner approval» is structural here: apply has no
// file input at all — it can only act on a previewed, fingerprinted report.
import { NextResponse } from 'next/server'
import { guard } from '../../_lib/guard'
import { badRequest, notFound, serverError } from '../../_lib/http'
import {
  applyReconcileReport,
  buildReconcileReport,
  getReconcileReport,
  listReconcileReports,
} from '@/lib/reconciliation'
import { describeFileReconciliationConnector, describePlannedLevels } from '@/lib/connectors/connector'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Record<string, unknown>
    const businessId = String(body.businessId ?? '')
    if (!businessId) return badRequest('businessId مطلوب')
    const gate = await guard(req, { businessId, userId: String(body.userId ?? ''), permission: 'catalog.manage' })
    if (!gate.ok) return gate.res

    if (body.action === 'dry-run') {
      // Same consent gate as the catalog importer (R75): file-based onboarding
      // only happens when the owner granted «استيراد ملفات».
      const { hasConsent } = await import('@/lib/domain/onboarding-profile')
      if (!(await hasConsent(businessId, 'importFromFiles'))) {
        return NextResponse.json(
          { error: 'استيراد الملفات محتاج موافقتك — ارجع لإعداد النشاط ووافق على «استيراد ملفات»' },
          { status: 403 },
        )
      }
      const file = String(body.file ?? '')
      if (!file) return badRequest('محتوى الملف مطلوب')
      if (file.length > 2_000_000) return badRequest('حجم الملف كبير جدًا — حد المرة 2MB')
      const out = await buildReconcileReport(businessId, file, body.fileName ? String(body.fileName) : undefined)
      if ('error' in out) return badRequest(out.error)
      return NextResponse.json(out, { status: 201 })
    }

    if (body.action === 'apply') {
      const out = await applyReconcileReport({
        businessId,
        userId: gate.actor.user.id,
        reportId: String(body.reportId ?? ''),
        contentHash: String(body.contentHash ?? ''),
        acknowledge: body.acknowledge === true,
      })
      if ('error' in out) {
        const res = NextResponse.json({ error: out.error }, { status: out.status ?? 400 })
        return res
      }
      return NextResponse.json(out)
    }

    if (body.action === 'report') {
      const r = await getReconcileReport(businessId, String(body.reportId ?? ''))
      if (!r) return notFound('التقرير غير موجود')
      return NextResponse.json(r)
    }

    if (body.action === 'reports') {
      return NextResponse.json({ reports: await listReconcileReports(businessId) })
    }

    if (body.action === 'connector') {
      const manifest = await describeFileReconciliationConnector(businessId)
      return NextResponse.json({ manifest, plannedLevels: describePlannedLevels() })
    }

    return badRequest('action غير معروفة — dry-run | apply | report | reports | connector')
  } catch (e) {
    return serverError('items/reconcile', e)
  }
}
