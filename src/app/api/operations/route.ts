// GET /api/operations?businessId[&status] — operations journal (newest first, max 100).
// Optional status filter (e.g. ?status=AWAITING_APPROVAL). userName joined via users map.
import { NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import type { OperationDTO } from '@/lib/types'
import { badRequest, searchParams, serverError } from '../_lib/http'
import { serializeOp, userNameMap } from '../_lib/serialize'

export const dynamic = 'force-dynamic'

const OP_STATUSES = [
  'RECEIVED',
  'AWAITING_APPROVAL',
  'EXECUTING',
  'SUCCEEDED',
  'FAILED_SAFE',
  'OUTCOME_UNKNOWN',
  'CANCELLED',
] as const

export async function GET(req: Request) {
  try {
    const sp = searchParams(req)
    const businessId = sp.get('businessId')
    if (!businessId) return badRequest('businessId مطلوب')

    const status = sp.get('status')
    const where: Prisma.OperationWhereInput = { businessId }
    if (status) {
      if (!(OP_STATUSES as readonly string[]).includes(status)) {
        return badRequest('قيمة status غير صحيحة')
      }
      where.status = status
    }

    const [ops, users] = await Promise.all([
      db.operation.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 }),
      db.user.findMany({ where: { businessId }, select: { id: true, name: true } }),
    ])

    const usersById = userNameMap(users)
    const dto: OperationDTO[] = ops.map((op) => serializeOp(op, usersById.get(op.userId)))
    return NextResponse.json(dto)
  } catch (e) {
    return serverError('operations', e)
  }
}
