// POST /api/companion/claim — bridge polls for its next job.
// Auth: x-companion-device / x-companion-nonce / x-companion-ts / x-companion-hmac
// (HMAC over deviceId|nonce|ts|sha256(body); 60s window; nonce single-use).
// Returns the signed job envelope, or an empty claim.
import { NextResponse } from 'next/server'
import { authenticateDevice, claimJob } from '@/lib/companion/companion'

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
    const job = await claimJob(auth.device.id)
    return NextResponse.json(job ?? {})
  } catch (e) {
    return NextResponse.json({ error: 'خطأ في الخادم' }, { status: 500 })
  }
}
