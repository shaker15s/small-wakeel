// POST /api/operations/[id]/confirm { action: approve|reject|cancel, reason?, userId }
// Executes via the deterministic domain executor with verification read-back.
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { executeOperation, rejectOperation } from '@/lib/domain/executors'
import { canApprove } from '@/lib/domain/risk'
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

    const op = await db.operation.findUnique({ where: { id } })
    if (!op) return notFound('العملية غير موجودة')

    // Tenant isolation: the approver must belong to the business that owns the
    // operation (checked here and again by the canApprove role rule below).
    const gate = await guard(req, { businessId: op.businessId, userId: body.userId })
    if (!gate.ok) return gate.res
    const user = gate.actor.user

    if (body.action === 'approve') {
      if (!canApprove(user.role, op.risk as never)) {
        return NextResponse.json(
          { error: `صلاحيتك مش بتسمح باعتماد عملية بدرجة ${op.risk}` },
          { status: 403 },
        )
      }
      if (op.risk === 'R3' && !body.reason?.trim() && op.type !== 'reversal') {
        return badRequest('العمليات الحساسة (R3) محتاجة سبب إلزامي')
      }
      if (op.risk === 'R3' && body.reason?.trim()) {
        await db.operation.update({ where: { id }, data: { reason: body.reason.trim() } })
      }
      try {
        const { op: updated, outcome } = await executeOperation(id, user.id)
        return NextResponse.json({
          operation: serializeOp(updated, user.name),
          outcome,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'مش قادر أنفّذ العملية'
        // State-machine conflicts (already approved/cancelled elsewhere — e.g.
        // two taps on the approve button) are CLIENT errors: answer 409 with the
        // real reason instead of a generic 500.
        if (/انتظار اعتماد|مش موجودة/.test(message)) {
          return NextResponse.json({ error: message }, { status: 409 })
        }
        throw err
      }
    }

    if (body.action === 'reject' || body.action === 'cancel') {
      try {
        const updated = await rejectOperation(id, user.id, body.reason)
        return NextResponse.json({ operation: serializeOp(updated, user.name) })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'مش قادر ألغي العملية'
        if (/انتظار اعتماد|مش موجودة/.test(message)) {
          return NextResponse.json({ error: message }, { status: 409 })
        }
        throw err
      }
    }

    return badRequest('action لازم يكون approve أو reject')
  } catch (e) {
    return serverError('confirm', e)
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const op = await db.operation.findUnique({ where: { id } })
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
