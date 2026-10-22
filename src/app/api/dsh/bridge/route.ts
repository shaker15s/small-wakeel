import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { AuthorizationError } from '@/lib/security/permissions'
import { OperationConflictError, OperationValidationError } from '@/lib/domain/errors'
import { runWakilDshAction, WakilBridgeError } from '@/lib/dsh-bridge/bridge'

export const dynamic = 'force-dynamic'

function secureEqual(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, 'utf8')
  const right = Buffer.from(actual, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

function fail(status: number, error: string) {
  return NextResponse.json({ ok: false, error }, { status, headers: { 'Cache-Control': 'no-store' } })
}

/**
 * Private server-to-server bridge for the local DeepSeek Harness profile.
 *
 * The client token can only read the configured owner's business and prepare
 * AWAITING_APPROVAL operations. Business/user identity comes from server-side
 * env, never from model arguments. There is deliberately no approval/execute
 * route in this bridge.
 */
export async function POST(req: Request) {
  try {
    if (process.env.WAKIL_DSH_ENABLED !== '1') {
      return fail(503, 'ربط DSH غير مفعّل. اضبط WAKIL_DSH_ENABLED=1 بعد مراجعة إعدادات الأمان.')
    }

    const expectedToken = process.env.WAKIL_DSH_BRIDGE_TOKEN ?? ''
    const businessId = process.env.WAKIL_DSH_BUSINESS_ID ?? ''
    const userId = process.env.WAKIL_DSH_USER_ID ?? ''
    if (expectedToken.length < 32 || !businessId || !userId) {
      return fail(503, 'إعدادات ربط DSH ناقصة؛ يلزم رمز قوي وهوية نشاط ومالك على الخادم.')
    }

    const authorization = req.headers.get('authorization') ?? ''
    const match = /^Bearer ([^\s]+)$/.exec(authorization)
    if (!match || !secureEqual(expectedToken, match[1])) {
      return fail(401, 'بيانات دخول ربط DSH غير صالحة.')
    }

    const bodyText = await req.text()
    if (bodyText.length > 64 * 1024) return fail(413, 'حجم طلب DSH أكبر من المسموح.')
    let body: unknown
    try { body = JSON.parse(bodyText) } catch { return fail(400, 'طلب JSON غير صالح.') }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'الطلب لازم يكون كائن JSON.')
    const input = body as Record<string, unknown>
    if (typeof input.action !== 'string') return fail(400, 'action مطلوب.')

    // Every request is bound to one owner and one business by the server.
    // No businessId/userId supplied by the model is ever used for lookup.
    const [business, user] = await Promise.all([
      db.business.findUnique({ where: { id: businessId }, select: { id: true } }),
      db.user.findUnique({ where: { id: userId }, select: { id: true, businessId: true, role: true } }),
    ])
    if (!business || !user || user.businessId !== business.id || user.role !== 'owner') {
      return fail(503, 'هوية ربط DSH غير صالحة. يجب أن يكون المستخدم مالكًا داخل النشاط المحدد.')
    }

    const data = await runWakilDshAction({
      action: input.action,
      body: input,
      businessId: business.id,
      userId: user.id,
    })
    return NextResponse.json({ ok: true, data }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (error instanceof WakilBridgeError) return fail(error.status, error.message)
    if (error instanceof AuthorizationError) return fail(403, 'المالك المحدد غير مخوّل لتجهيز هذه المسودة.')
    if (error instanceof OperationValidationError) return fail(422, error.message)
    if (error instanceof OperationConflictError) return fail(409, 'المسودة تعارضت مع تغيير آخر؛ أعد قراءة السجل وجهّز مسودة جديدة.')
    // Do not expose Prisma details, filesystem paths, environment or secrets.
    return fail(500, 'تعذر تنفيذ طلب ربط DSH؛ لم يُسمح للطلب بتجاوز مسار وكيل المالي.')
  }
}

export async function GET() {
  return fail(405, 'استخدم POST. مسار ربط DSH لا يعرض البيانات دون مصادقة.')
}
