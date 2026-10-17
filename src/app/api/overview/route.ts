// GET /api/overview?businessId&userId — اليوم dashboard payload:
// cash position, today's money sums (Cairo day), pending approvals, low stock,
// expiring (pharmacy), receivables/payables, recent ops, and data-driven alerts.
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { egp } from '@/lib/format'
import type { AlertDTO, OverviewDTO } from '@/lib/types'
import { badRequest, notFound, searchParams, serverError } from '../_lib/http'
import { guard } from '../_lib/guard'
import { daysFromTodayCairo, startOfCairoDay } from '../_lib/dates'
import { payloadTotalPiastres, serializeCustomer, serializeItem, serializeOp, serializeSupplier, userNameMap } from '../_lib/serialize'

export const dynamic = 'force-dynamic'

// membership = a gym's revenue; leaving it out made «مبيعات النهاردة» read ٠
const MONEY_TYPES = ['sale', 'membership', 'purchase', 'expense', 'collection', 'payment']
const EXPIRING_WINDOW_DAYS = 30

const arNum = (n: number) => new Intl.NumberFormat('ar-EG').format(n)

export async function GET(req: Request) {
  try {
    const sp = searchParams(req)
        const businessId = sp.get('businessId')
    if (!businessId) return badRequest('businessId مطلوب')
    const userId = sp.get('userId')
    if (!userId) return badRequest('userId مطلوب')
    const gate = await guard(req, { businessId, userId })
    if (!gate.ok) return gate.res

    const business = await db.business.findUnique({ where: { id: businessId } })
    if (!business) return notFound('النشاط التجاري غير موجود')

    const startOfToday = startOfCairoDay(0)

    const [
      cashGrouped,
      todayMoneyOps,
      todayOpsCount,
      todayDoneCount,
      pendingCount,
      pendingOps,
      items,
      customers,
      suppliers,
      recentOps,
      users,
    ] = await Promise.all([
      db.cashEntry.groupBy({ by: ['direction'], where: { businessId }, _sum: { amount: true } }),
      db.operation.findMany({
        where: {
          businessId,
          createdAt: { gte: startOfToday },
          status: 'SUCCEEDED',
          type: { in: MONEY_TYPES },
        },
        select: { type: true, payload: true },
      }),
      db.operation.count({ where: { businessId, createdAt: { gte: startOfToday } } }),
      db.operation.count({ where: { businessId, createdAt: { gte: startOfToday }, status: 'SUCCEEDED' } }),
      db.operation.count({ where: { businessId, status: 'AWAITING_APPROVAL' } }),
      db.operation.findMany({
        where: { businessId, status: 'AWAITING_APPROVAL' },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      db.item.findMany({ where: { businessId } }),
      db.customer.findMany({ where: { businessId } }),
      db.supplier.findMany({ where: { businessId } }),
      db.operation.findMany({ where: { businessId }, orderBy: { createdAt: 'desc' }, take: 8 }),
      db.user.findMany({ where: { businessId }, select: { id: true, name: true } }),
    ])

    const usersById = userNameMap(users)

    // — Cash position (integer piastres)
    const cashIn = cashGrouped.find((g) => g.direction === 'in')?._sum.amount ?? 0
    const cashOut = cashGrouped.find((g) => g.direction === 'out')?._sum.amount ?? 0
    const cash = {
      opening: business.openingCash,
      in: cashIn,
      out: cashOut,
      net: business.openingCash + cashIn - cashOut,
    }

    // — Today's money sums from SUCCEEDED ops (payload.total, piastres)
    const today = {
      sales: 0,
      purchases: 0,
      expenses: 0,
      collections: 0,
      payments: 0,
      opsCount: todayOpsCount,
      doneCount: todayDoneCount,
    }
    for (const op of todayMoneyOps) {
      const total = payloadTotalPiastres(op.payload)
      switch (op.type) {
        case 'membership':
        case 'sale':
          today.sales += total
          break
        case 'purchase':
          today.purchases += total
          break
        case 'expense':
          today.expenses += total
          break
        case 'collection':
          today.collections += total
          break
        case 'payment':
          today.payments += total
          break
      }
    }

    // — Low stock (stockQty at/below its own threshold), worst first
    const lowStock = items
      .filter((i) => i.stockQty <= i.lowStockThreshold)
      .sort((a, b) => a.stockQty - b.stockQty || a.name.localeCompare(b.name, 'ar'))
      .map(serializeItem)

    // — Expiry watch: pharmacy only, expired or expiring within 30 days
    const isPharmacy = business.type === 'pharmacy'
    const expiring = isPharmacy
      ? items
          .filter(
            (i) => i.expiresAt !== null && daysFromTodayCairo(i.expiresAt) <= EXPIRING_WINDOW_DAYS,
          )
          .sort((a, b) => (a.expiresAt?.getTime() ?? 0) - (b.expiresAt?.getTime() ?? 0))
          .map(serializeItem)
      : []

    // — Receivables (customers who owe us) / payables (suppliers we owe)
    const receivables = customers
      .filter((c) => c.balance > 0)
      .sort((a, b) => b.balance - a.balance)
      .map(serializeCustomer)
    const payables = suppliers
      .filter((s) => s.balance > 0)
      .sort((a, b) => b.balance - a.balance)
      .map(serializeSupplier)

    const recentOpsSer = recentOps.map((op) => serializeOp(op, usersById.get(op.userId)))
    const pendingOpsSer = pendingOps.map((op) => serializeOp(op, usersById.get(op.userId)))

    // — Alerts derived from the data above
    const alerts: AlertDTO[] = []
    const expiredCount = isPharmacy
      ? items.filter((i) => i.expiresAt !== null && daysFromTodayCairo(i.expiresAt) < 0).length
      : 0
    const expiringSoonCount = isPharmacy
      ? items.filter(
          (i) =>
            i.expiresAt !== null &&
            daysFromTodayCairo(i.expiresAt) >= 0 &&
            daysFromTodayCairo(i.expiresAt) <= EXPIRING_WINDOW_DAYS,
        ).length
      : 0

    if (expiredCount > 0) {
      alerts.push({
        level: 'danger',
        text: `فيه ${arNum(expiredCount)} صنف صلاحيته خلصت`,
        action: { label: 'راجع المخزون', view: 'inventory' },
      })
    }
    if (expiringSoonCount > 0) {
      alerts.push({
        level: 'warning',
        text: `فيه ${arNum(expiringSoonCount)} صنف صلاحيته قربت تخلص خلال ${arNum(EXPIRING_WINDOW_DAYS)} يوم`,
        action: { label: 'راجع المخزون', view: 'inventory' },
      })
    }
    if (lowStock.length > 0) {
      alerts.push({
        level: 'warning',
        text: `${arNum(lowStock.length)} صنف تحت حد التنبيه`,
        action: { label: 'راجع المخزون', view: 'inventory' },
      })
    }
    if (pendingCount > 0) {
      alerts.push({
        level: 'info',
        text: `${arNum(pendingCount)} عملية مستنية اعتمادك`,
        action: { label: 'افتح اليوم', view: 'today' },
      })
    }
    const receivablesTotal = receivables.reduce((sum, c) => sum + c.balance, 0)
    if (receivablesTotal > 0) {
      alerts.push({
        level: 'info',
        text: `عندك ${egp(receivablesTotal)} مستحقة عند العملاء`,
        action: { label: 'افتح الحسابات', view: 'accounts' },
      })
    }

    // — Gym: memberships expiring within 5 days or already expired (proactive)
    if (business.type === 'gym') {
      const endingMembers = customers
        .filter((c) => c.expiresAt !== null)
        .map((c) => ({ name: c.name, daysLeft: daysFromTodayCairo(c.expiresAt!) }))
        .filter((m) => m.daysLeft <= 5)
        .sort((a, b) => a.daysLeft - b.daysLeft)
        .slice(0, 4)
      for (const m of endingMembers) {
        if (m.daysLeft < 0) {
          alerts.push({
            level: 'danger',
            text: `اشتراك ${m.name} خلص من ${arNum(Math.abs(m.daysLeft))} يوم`,
            action: { label: 'شوف الحسابات', view: 'accounts' },
          })
        } else if (m.daysLeft === 0) {
          alerts.push({
            level: 'warning',
            text: `اشتراك ${m.name} آخر يوم النهاردة`,
            action: { label: 'شوف الحسابات', view: 'accounts' },
          })
        } else {
          alerts.push({
            level: 'warning',
            text: `اشتراك ${m.name} بيخلص بعد ${arNum(m.daysLeft)} يوم`,
            action: { label: 'شوف الحسابات', view: 'accounts' },
          })
        }
      }
    }

    const dto: OverviewDTO = {
      cash,
      today,
      pendingOps: pendingOpsSer,
      lowStock,
      expiring,
      receivables,
      payables,
      recentOps: recentOpsSer,
      alerts,
    }

    return NextResponse.json(dto)
  } catch (e) {
    return serverError('overview', e)
  }
}
