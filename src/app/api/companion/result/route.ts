// POST /api/companion/result — bridge reports one job's outcome + evidence.
// Body: { jobId, ok, evidence?: { hash, hash2, size, lines, content, ... } | errorReason }
// The server refuses any file/CLI success whose double-read hash disagrees —
// «القراءة الخارجية تطابق مصدرها» is evidence, not a promise.
import { NextResponse } from 'next/server'
import { authenticateDevice, submitJobResult } from '@/lib/companion/companion'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const bodyText = await req.text()
    const auth = await authenticateDevice(
      {
        deviceId: req.headers.get('x-companion-device'),
        nonce: req.headers.get('x-companion-nonce'),
        ts: req.headers.get('x-companion-ts'),
        hmac: req.headers.get('x-companion-hmac'),
      },
      bodyText,
    )
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error }, { status: auth.error.includes('مفصول') ? 403 : 401 })
    }
    let payload: { jobId?: string; ok?: boolean; evidence?: unknown; errorReason?: string }
    try {
      payload = JSON.parse(bodyText) as typeof payload
    } catch {
      return NextResponse.json({ error: 'body غير صالح' }, { status: 400 })
    }
    if (!payload.jobId) return NextResponse.json({ error: 'jobId مطلوب' }, { status: 400 })
    const out = await submitJobResult(
      auth.device.id,
      payload.jobId,
      {
        ok: payload.ok === true,
        evidence: payload.evidence as never,
        errorReason: payload.errorReason,
      },
    )
    if ('error' in out) {
      const notFound = out.error.includes('غير موجودة')
      return NextResponse.json({ error: out.error }, { status: notFound ? 404 : 409 })
    }
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: 'خطأ في الخادم' }, { status: 500 })
  }
}
