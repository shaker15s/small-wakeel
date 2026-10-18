// POST /api/operations/[id]/confirm { action: approve|reject|cancel, reason?, userId }
// Executes via the deterministic domain executor with verification read-back.
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { executeOperation, rejectOperation } from '@/lib/domain/executors'
import { badRequest, notFound, serverError } from '../../../_lib/http'
import { guard } from '../../../_lib/guard'
import { parseJson, serializeOp } from '../../../_lib/serialize'
import { confirmOpSchema, parseBody } from '@/lib/security/validate'

export const dynamic = 'force-dynamic'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const parsed = await parseBody(req, confirmOpSchema)
    if (!parsed.ok) return badRequest(parsed.message)
    const body = parsed.data

    // Authenticate before looking up the operation; unknown and foreign IDs
    // have the same scoped 404, with no operation-existence oracle.
    const gate = await guard(req, { userId: body.userId })
    if (!gate.ok) return gate.res
    const { user, business } = gate.actor
    const op = await db.operation.findFirst({ where: { id, businessId: business.id } })
    if (!op) return notFound('العملية غير موجودة')

    if (body.action === 'approve') {
      // The domain layer owns type/risk permissions, required reason, CAS and
      // all writes. A repeated/forbidden approval must not mutate its reason.
      const { op: updated, outcome } = await executeOperation(id, user.id, body.reason)
      return NextResponse.json({ operation: serializeOp(updated, user.name), outcome })
    }
    if (body.action === 'reject' || body.action === 'cancel') {
      const updated = await rejectOperation(id, user.id, body.reason, body.action)
      return NextResponse.json({ operation: serializeOp(updated, user.name) })
    }

    return badRequest('action لازم يكون approve أو reject')
  } catch (e) {
    return serverError('confirm', e)
  }
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const gate = await guard(req, { scope: 'business', businessId: new URL(req.url).searchParams.get('businessId') })
    if (!gate.ok) return gate.res
    const { id } = await params
    const op = await db.operation.findFirst({ where: { id, businessId: gate.business.id } })
    if (!op) return notFound('العملية غير موجودة')
    const user = await db.user.findUnique({ where: { id: op.userId } })
    return NextResponse.json({
      operation: serializeOp(op, user?.name),
      payload: parseJson<Record<string, unknown>>(op.payload, {}),
    })
  } catch (e) {
    return serverError('confirm-get', e)
  }
}
