// GET /api/export?businessId — full data export as a downloadable JSON file.
// { business, items, customers, suppliers, operations, cashEntries, auditEvents }
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { badRequest, notFound, searchParams, serverError } from '../_lib/http'
import { parseJson, serializeCustomer, serializeItem, serializeOp, serializeSupplier, userNameMap } from '../_lib/serialize'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const sp = searchParams(req)
    const businessId = sp.get('businessId')
    if (!businessId) return badRequest('businessId مطلوب')

    const [business, items, customers, suppliers, operations, cashEntries, auditEvents, users] =
      await Promise.all([
        db.business.findUnique({ where: { id: businessId } }),
        db.item.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } }),
        db.customer.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } }),
        db.supplier.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } }),
        db.operation.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } }),
        db.cashEntry.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } }),
        db.auditEvent.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } }),
        db.user.findMany({ where: { businessId }, select: { id: true, name: true } }),
      ])

    if (!business) return notFound('النشاط التجاري غير موجود')

    const usersById = userNameMap(users)

    const body = {
      exportedAt: new Date().toISOString(),
      business: {
        ...business,
        createdAt: business.createdAt.toISOString(),
      },
      items: items.map(serializeItem),
      customers: customers.map(serializeCustomer),
      suppliers: suppliers.map(serializeSupplier),
      operations: operations.map((op) => serializeOp(op, usersById.get(op.userId))),
      cashEntries: cashEntries.map((c) => ({
        id: c.id,
        direction: c.direction,
        amount: c.amount,
        reason: c.reason,
        ref: c.ref,
        createdAt: c.createdAt.toISOString(),
      })),
      auditEvents: auditEvents.map((a) => ({
        id: a.id,
        actor: a.actor,
        action: a.action,
        ref: a.ref,
        detail: parseJson<Record<string, unknown>>(a.detail, {}),
        createdAt: a.createdAt.toISOString(),
      })),
    }

    return NextResponse.json(body, {
      headers: {
        'content-disposition': `attachment; filename="wakil-export-${businessId}.json"`,
      },
    })
  } catch (e) {
    return serverError('export', e)
  }
}
