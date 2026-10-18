import { setWorkflow } from '@/lib/domain/workflow'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { serializeOp } from '../_lib/serialize'
import { guard } from '../_lib/guard'
import { serverError } from '../_lib/http'
import { cashbookCash } from '@/lib/domain/cashbook'
import { cairoIsoDay } from '../_lib/dates'
export const dynamic = 'force-dynamic'
export async function GET(req: NextRequest) {
  try {
    const gate = await guard(req, { businessId: req.nextUrl.searchParams.get('businessId'), userId: req.nextUrl.searchParams.get('userId') })
    if (!gate.ok) return gate.res
    const { business, user } = gate.actor
    const result = await db.$transaction(async tx => {
      const [cash, entries, customers, suppliers, reminders, pendingOps] = await Promise.all([
        cashbookCash(tx, business.id),
        tx.cashbookEntry.findMany({ where: { businessId: business.id }, include: { operation: { select: { reversedByRef: true } } }, orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }], take: 40 }),
        tx.customer.findMany({ where: { businessId: business.id, balance: { gt: 0 } }, select: { id: true, name: true, balance: true }, orderBy: { balance: 'desc' }, take: 50 }),
        tx.supplier.findMany({ where: { businessId: business.id, balance: { gt: 0 } }, select: { id: true, name: true, balance: true }, orderBy: { balance: 'desc' }, take: 50 }),
        tx.shopReminder.findMany({ where: { businessId: business.id, userId: user.id, active: true }, select: { id: true, subject: true }, take: 20 }),
        tx.operation.findMany({ where: { businessId: business.id, status: 'AWAITING_APPROVAL' }, orderBy: { createdAt: 'desc' }, take: 20 }),
      ])
      const totals = await Promise.all([tx.customer.aggregate({ where: { businessId: business.id, balance: { gt: 0 } }, _sum: { balance: true } }), tx.supplier.aggregate({ where: { businessId: business.id, balance: { gt: 0 } }, _sum: { balance: true } })])
      return { cash, entries, customers, suppliers, reminders, pendingOps: pendingOps.map(op => serializeOp(op)), receivable: totals[0]._sum.balance ?? 0, payable: totals[1]._sum.balance ?? 0, today: cairoIsoDay(new Date()) }
    })
    return NextResponse.json(result)
  } catch (err) { return serverError('cashbook', err) }
}
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object' || typeof body.mode !== 'string' || body.businessId != null && typeof body.businessId !== 'string' || body.userId != null && typeof body.userId !== 'string') return NextResponse.json({ error: 'طلب غير صالح' }, { status: 400 })
    const gate = await guard(req, { permission: 'business.configure', businessId: body.businessId, userId: body.userId })
    if (!gate.ok) return gate.res
    const result = await setWorkflow(gate.actor.business.id, gate.actor.user.id, body.mode)
    return NextResponse.json(result)
  } catch (err) { return serverError('cashbook', err) }
}
