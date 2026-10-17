// وكيل — read tools: deterministic queries + deep financial & predictive analytics (R0).
// Results are structured ResultCardDTOs the UI renders as tables/kv cards.

import type { Item, Customer, Supplier, Operation } from '@prisma/client'
import { db } from '@/lib/db'
import type { ResultCardDTO } from '@/lib/types'
import { egp, qty as fmtQty, arDate, arTime } from '@/lib/format'
import { arUnit } from '@/lib/verticals'
import { startOfCairoDay } from '@/app/api/_lib/dates'

export type ReadTool =
  | 'get_daily_summary'
  | 'get_cash_position'
  | 'search_catalog'
  | 'get_item_stock'
  | 'list_low_stock'
  | 'list_expiring'
  | 'get_supplier_balance'
  | 'get_member_status'
  | 'list_receivables'
  | 'list_payables'
  | 'get_activity_history'
  | 'get_transaction_status'
  | 'analyze_profitability'
  | 'forecast_stock'
  | 'get_proactive_insights'

/** Valid read-tool names — validation set for intent parsing (multi-intent). */
export const READ_TOOLS: ReadonlySet<string> = new Set<string>([
  'get_daily_summary',
  'get_cash_position',
  'search_catalog',
  'get_item_stock',
  'list_low_stock',
  'list_expiring',
  'get_supplier_balance',
  'get_member_status',
  'list_receivables',
  'list_payables',
  'get_activity_history',
  'get_transaction_status',
  'analyze_profitability',
  'forecast_stock',
  'get_proactive_insights',
])

function itemRow(it: Item): Record<string, string> {
  return {
    name: it.name,
    stock: fmtQty(it.stockQty, arUnit(it.unit)),
    threshold: fmtQty(it.lowStockThreshold, arUnit(it.unit)),
    price: egp(it.sellPrice),
    ...(it.expiresAt ? { expiry: arDate(it.expiresAt) } : {}),
  }
}

function opRow(op: Operation, userName?: string): Record<string, string> {
  return {
    ref: op.ref,
    type: TYPE_AR[op.type] ?? op.type,
    status: STATUS_AR[op.status] ?? op.status,
    user: userName ?? '—',
    summary: op.summary.length > 40 ? op.summary.slice(0, 40) + '…' : op.summary,
    time: arTime(op.createdAt),
  }
}

export const TYPE_AR: Record<string, string> = {
  sale: 'بيع',
  purchase: 'شرا',
  expense: 'مصروف',
  collection: 'تحصيل',
  payment: 'سداد',
  stock_adjustment: 'تسوية مخزون',
  membership: 'اشتراك',
  attendance: 'حضور',
  reversal: 'عكس عملية',
}
export const STATUS_AR: Record<string, string> = {
  RECEIVED: 'مستلمة',
  AWAITING_APPROVAL: 'مستنية اعتماد',
  EXECUTING: 'بتتنفذ',
  SUCCEEDED: 'تم — موثّق ومتحقق',
  FAILED_SAFE: 'فشلت بأمان',
  OUTCOME_UNKNOWN: 'نتيجة غير محسومة',
  CANCELLED: 'ملغاة',
}

export async function runReadTool(
  tool: ReadTool,
  businessId: string,
  args: Record<string, unknown> = {},
): Promise<ResultCardDTO[]> {
  const biz = await db.business.findUniqueOrThrow({ where: { id: businessId } })

  switch (tool) {
    case 'get_cash_position': {
      const entries = await db.cashEntry.findMany({ where: { businessId }, select: { direction: true, amount: true } })
      const inn = entries.filter((e) => e.direction === 'in').reduce((s, e) => s + e.amount, 0)
      const out = entries.filter((e) => e.direction === 'out').reduce((s, e) => s + e.amount, 0)
      return [
        {
          kind: 'kv',
          title: 'وضع الخزنة',
          rows: [
            { label: 'الافتتاحي', value: egp(biz.openingCash) },
            { label: 'داخل (قبض)', value: egp(inn) },
            { label: 'خارج (دفع)', value: egp(out) },
            { label: 'الرصيد دلوقتي', value: egp(biz.openingCash + inn - out) },
          ],
        },
      ]
    }

    case 'get_daily_summary': {
      const today = startOfCairoDay(0)
      const ops = await db.operation.findMany({
        where: { businessId, status: 'SUCCEEDED', createdAt: { gte: today } },
      })
      const sum = (type: string) =>
        ops.filter((o) => o.type === type).reduce((s, o) => {
          const p = JSON.parse(o.payload) as Record<string, unknown>
          const key = 'total' in p ? 'total' : 'amount'
          return s + Number(p[key] ?? 0)
        }, 0)
      return [
        {
          kind: 'kv',
          title: 'ملخص اليوم',
          rows: [
            { label: 'مبيعات', value: egp(sum('sale')) },
            { label: 'مشتريات', value: egp(sum('purchase')) },
            { label: 'مصروفات', value: egp(sum('expense')) },
            { label: 'تحصيلات', value: egp(sum('collection')) },
            { label: 'اشتراكات', value: egp(sum('membership')) },
            { label: 'عدد العمليات', value: fmtQty(ops.length) },
          ],
        },
      ]
    }

    case 'list_low_stock': {
      const items = await db.item.findMany({
        where: { businessId },
      })
      const low = items.filter((it) => it.stockQty <= it.lowStockThreshold)
      return [
        {
          kind: 'table',
          title: 'المخزون الناقص',
          columns: [
            { key: 'name', label: 'الصنف' },
            { key: 'stock', label: 'الرصيد' },
            { key: 'threshold', label: 'حد التنبيه' },
            { key: 'unit', label: 'الوحدة' },
          ],
          rows: low.map((it) => ({ ...itemRow(it), unit: arUnit(it.unit) })),
          footer: [{ label: 'إجمالي الأصناف الناقصة', value: fmtQty(low.length) }],
        },
      ]
    }

    case 'list_expiring': {
      const items = await db.item.findMany({
        where: { businessId, expiresAt: { not: null } },
        orderBy: { expiresAt: 'asc' },
      })
      const in30 = items.filter((it) => {
        if (!it.expiresAt) return false
        const days = Math.ceil((it.expiresAt.getTime() - Date.now()) / 86400000)
        return days <= 30
      })
      return [
        {
          kind: 'table',
          title: 'الأصناف اللي صلاحيتها قربت تخلص (30 يوم)',
          columns: [
            { key: 'name', label: 'الصنف' },
            { key: 'batch', label: 'التشغيلة' },
            { key: 'expiry', label: 'الصلاحية' },
            { key: 'stock', label: 'الرصيد' },
          ],
          rows: in30.map((it) => ({
            name: it.name,
            batch: it.batchNo ?? '—',
            expiry: arDate(it.expiresAt!),
            stock: fmtQty(it.stockQty, arUnit(it.unit)),
          })),
          footer: [{ label: 'إجمالي', value: fmtQty(in30.length) }],
        },
      ]
    }

    case 'list_receivables': {
      const customers = await db.customer.findMany({
        where: { businessId, balance: { gt: 0 } },
        orderBy: { balance: 'desc' },
      })
      return [
        {
          kind: 'table',
          title: 'المديونيات — اللي لينا عند العملاء',
          columns: [
            { key: 'name', label: 'العميل' },
            { key: 'balance', label: 'المديونية' },
            ...(biz.type === 'gym' ? [{ key: 'plan', label: 'الخطة' }] : []),
          ],
          rows: customers.map((c) => ({
            name: c.name,
            balance: egp(c.balance),
            ...(biz.type === 'gym' ? { plan: c.plan ?? '—' } : {}),
          })),
          footer: [{ label: 'إجمالي المديونيات', value: egp(customers.reduce((s, c) => s + c.balance, 0)) }],
        },
      ]
    }

    case 'list_payables': {
      const suppliers = await db.supplier.findMany({
        where: { businessId, balance: { gt: 0 } },
        orderBy: { balance: 'desc' },
      })
      return [
        {
          kind: 'table',
          title: 'المستحقات — اللي علينا للموردين',
          columns: [
            { key: 'name', label: 'المورد' },
            { key: 'balance', label: 'المستحق' },
          ],
          rows: suppliers.map((s) => ({ name: s.name, balance: egp(s.balance) })),
          footer: [{ label: 'إجمالي المستحقات', value: egp(suppliers.reduce((s, x) => s + x.balance, 0)) }],
        },
      ]
    }

    case 'search_catalog':
    case 'get_item_stock': {
      const query = String(args.query ?? args.name ?? '')
      const items = await db.item.findMany({ where: { businessId }, orderBy: { name: 'asc' } })
      const matched = query
        ? items.filter((it) => {
            const haystack = `${it.name} ${it.aliases}`.toLowerCase()
            return haystack.includes(query.toLowerCase()) || query.includes(it.name.toLowerCase())
          })
        : items.slice(0, 8)
      return [
        {
          kind: 'table',
          title: query ? `نتايج البحث عن «${query}»` : 'الأصناف',
          columns: [
            { key: 'name', label: 'الصنف' },
            { key: 'stock', label: 'الرصيد' },
            { key: 'price', label: 'سعر البيع' },
            { key: 'unit', label: 'الوحدة' },
          ],
          rows: matched.map((it) => ({ ...itemRow(it), unit: arUnit(it.unit) })),
          footer: matched.length === 0 ? [{ label: 'مفيش نتايج', value: 'جرب اسم تاني' }] : undefined,
        },
      ]
    }

    case 'get_supplier_balance': {
      const name = String(args.name ?? '')
      const suppliers: Supplier[] = await db.supplier.findMany({ where: { businessId } })
      const found = suppliers.find((s) => s.name.includes(name) || name.includes(s.name.split(' ')[0]))
      return [
        {
          kind: 'kv',
          title: `رصيد المورد ${found?.name ?? name}`,
          rows: found
            ? [
                { label: 'المستحق له', value: egp(found.balance) },
                { label: 'التليفون', value: found.phone ?? '—' },
              ]
            : [{ label: 'النتيجة', value: `ملقيتش مورد بالاسم «${name}»` }],
        },
      ]
    }

    case 'get_member_status': {
      const name = String(args.name ?? '')
      const members: Customer[] = await db.customer.findMany({ where: { businessId }, orderBy: { name: 'asc' } })
      const found = members.find((m) => m.name.includes(name) || name.includes(m.name.split(' ')[0]))
      const daysLeft = found?.expiresAt ? Math.ceil((found.expiresAt.getTime() - Date.now()) / 86400000) : null
      return [
        {
          kind: 'kv',
          title: `حالة العضو ${found?.name ?? name}`,
          rows: found
            ? [
                { label: 'الخطة', value: found.plan ?? '—' },
                { label: 'الاشتراك لحد', value: found.expiresAt ? arDate(found.expiresAt) : '—' },
                { label: 'فاضل', value: daysLeft != null ? `${daysLeft} يوم` : '—' },
                { label: 'مديونية', value: egp(found.balance) },
              ]
            : [{ label: 'النتيجة', value: `ملقيتش عضو بالاسم «${name}»` }],
        },
      ]
    }

    case 'get_activity_history': {
      const ops = await db.operation.findMany({
        where: { businessId },
        orderBy: { createdAt: 'desc' },
        take: 8,
      })
      const users = await db.user.findMany({ where: { businessId } })
      const nameMap = new Map(users.map((u) => [u.id, u.name]))
      return [
        {
          kind: 'table',
          title: 'آخر الحركات',
          columns: [
            { key: 'ref', label: 'الرقم' },
            { key: 'type', label: 'النوع' },
            { key: 'status', label: 'الحالة' },
            { key: 'user', label: 'من' },
            { key: 'summary', label: 'التفاصيل' },
          ],
          rows: ops.map((op) => opRow(op, nameMap.get(op.userId))),
        },
      ]
    }

    case 'get_transaction_status': {
      const ref = String(args.ref ?? '')
      const op = await db.operation.findFirst({ where: { businessId, ref } })
      return [
        {
          kind: 'kv',
          title: `العملية ${ref}`,
          rows: op
            ? [
                { label: 'النوع', value: TYPE_AR[op.type] ?? op.type },
                { label: 'الحالة', value: STATUS_AR[op.status] ?? op.status },
                { label: 'الملخص', value: op.summary },
                { label: 'وقت التنفيذ', value: op.executedAt ? arTime(op.executedAt) : 'لسه' },
              ]
            : [{ label: 'النتيجة', value: `ملقيتش عملية بالرقم ${ref}` }],
        },
      ]
    }

    case 'analyze_profitability': {
      const since30d = new Date(Date.now() - 30 * 86400000)
      const [items, ops] = await Promise.all([
        db.item.findMany({ where: { businessId }, orderBy: { name: 'asc' } }),
        db.operation.findMany({
          where: { businessId, status: 'SUCCEEDED', createdAt: { gte: since30d } },
        }),
      ])
      const itemMap = new Map(items.map((it) => [it.id, it]))

      let salesRevenue = 0
      let estimatedCogs = 0
      let expensesTotal = 0
      let membershipsRevenue = 0

      for (const op of ops) {
        try {
          const p = JSON.parse(op.payload) as Record<string, unknown>
          if (op.type === 'sale') {
            const total = Number(p.total ?? 0)
            salesRevenue += total
            if (Array.isArray(p.lines)) {
              for (const line of p.lines as Record<string, unknown>[]) {
                const it = itemMap.get(String(line.itemId ?? ''))
                const q = Number(line.qty ?? 0)
                if (it && q > 0) estimatedCogs += Math.round(q * it.costPrice)
              }
            } else {
              const it = itemMap.get(String(p.itemId ?? ''))
              const q = Number(p.qty ?? 0)
              if (it && q > 0) estimatedCogs += Math.round(q * it.costPrice)
            }
          } else if (op.type === 'expense') {
            expensesTotal += Number(p.total ?? p.amount ?? 0)
          } else if (op.type === 'membership') {
            membershipsRevenue += Number(p.total ?? p.amount ?? 0)
          }
        } catch {
          // ignore malformed payload
        }
      }

      const totalRevenue = salesRevenue + membershipsRevenue
      const grossProfit = totalRevenue - estimatedCogs
      const netOperatingProfit = grossProfit - expensesTotal
      const marginPct = totalRevenue > 0 ? Math.round((grossProfit / totalRevenue) * 100) : 0

      const stockCostValue = items.reduce((s, it) => s + Math.round(it.stockQty * it.costPrice), 0)
      const stockSellValue = items.reduce((s, it) => s + Math.round(it.stockQty * it.sellPrice), 0)
      const potentialStockProfit = Math.max(0, stockSellValue - stockCostValue)

      const itemMargins = items
        .filter((it) => it.sellPrice > 0)
        .map((it) => {
          const profitPerUnit = it.sellPrice - it.costPrice
          const margin = it.sellPrice > 0 ? Math.round((profitPerUnit / it.sellPrice) * 100) : 0
          return {
            name: it.name,
            cost: egp(it.costPrice),
            sell: egp(it.sellPrice),
            unitProfit: egp(profitPerUnit),
            margin: `${margin}%`,
            marginNum: margin,
          }
        })
        .sort((a, b) => b.marginNum - a.marginNum)

      return [
        {
          kind: 'kv',
          title: 'تحليل الربحية والتدفق المالي (آخر 30 يوم)',
          rows: [
            { label: 'إجمالي الإيرادات (مبيعات واشتراكات)', value: egp(totalRevenue) },
            { label: 'تكلفة البضاعة المباعة (COGS)', value: egp(estimatedCogs) },
            { label: 'مجمل الربح (Gross Profit)', value: `${egp(grossProfit)} (${marginPct}%)` },
            { label: 'المصروفات التشغيلية', value: egp(expensesTotal) },
            { label: 'صافي الربح التشغيلي', value: egp(netOperatingProfit) },
            { label: 'قيمة المخزون الحالي (بالتكلفة)', value: egp(stockCostValue) },
            { label: 'الربح الكامن في المخزون الحالي', value: egp(potentialStockProfit) },
          ],
        },
        {
          kind: 'table',
          title: 'هوامش ربح الأصناف (من الأعلى للأقل)',
          columns: [
            { key: 'name', label: 'الصنف' },
            { key: 'cost', label: 'التكلفة' },
            { key: 'sell', label: 'سعر البيع' },
            { key: 'unitProfit', label: 'مكسب الوحدة' },
            { key: 'margin', label: 'الهامش' },
          ],
          rows: itemMargins.slice(0, 10).map(({ name, cost, sell, unitProfit, margin }) => ({
            name,
            cost,
            sell,
            unitProfit,
            margin,
          })),
          footer: [{ label: 'إجمالي الأصناف المحللة', value: fmtQty(itemMargins.length) }],
        },
      ]
    }

    case 'forecast_stock': {
      const since14d = new Date(Date.now() - 14 * 86400000)
      const [items, sales] = await Promise.all([
        db.item.findMany({ where: { businessId }, orderBy: { name: 'asc' } }),
        db.operation.findMany({
          where: { businessId, type: 'sale', status: 'SUCCEEDED', createdAt: { gte: since14d } },
        }),
      ])

      const soldByItem = new Map<string, number>()
      for (const s of sales) {
        try {
          const p = JSON.parse(s.payload) as Record<string, unknown>
          if (Array.isArray(p.lines)) {
            for (const l of p.lines as Record<string, unknown>[]) {
              const id = String(l.itemId ?? '')
              const q = Number(l.qty ?? 0)
              if (id && q > 0) soldByItem.set(id, (soldByItem.get(id) ?? 0) + q)
            }
          } else {
            const id = String(p.itemId ?? '')
            const q = Number(p.qty ?? 0)
            if (id && q > 0) soldByItem.set(id, (soldByItem.get(id) ?? 0) + q)
          }
        } catch {
          // ignore
        }
      }

      const forecasts = items
        .map((it) => {
          const sold14 = soldByItem.get(it.id) ?? 0
          const dailyBurn = sold14 > 0 ? sold14 / 14 : it.lowStockThreshold > 0 ? it.lowStockThreshold / 10 : 0.2
          const daysLeft = dailyBurn > 0 ? Math.max(0, Math.round(it.stockQty / dailyBurn)) : 999
          const target14d = Math.ceil(dailyBurn * 14) + it.lowStockThreshold
          const suggestedOrder = Math.max(0, target14d - it.stockQty)
          const estOrderCost = Math.round(suggestedOrder * it.costPrice)
          return {
            it,
            sold14,
            daysLeft,
            suggestedOrder,
            estOrderCost,
            urgent: it.stockQty <= it.lowStockThreshold || daysLeft <= 7,
          }
        })
        .sort((a, b) => a.daysLeft - b.daysLeft)

      const urgentItems = forecasts.filter((f) => f.urgent)
      const totalReorderCost = urgentItems.reduce((s, f) => s + f.estOrderCost, 0)

      return [
        {
          kind: 'table',
          title: 'توقع نفاد المخزون وخطة إعادة الطلب الذكية (تغطية 14 يوم)',
          columns: [
            { key: 'name', label: 'الصنف' },
            { key: 'stock', label: 'الرصيد الحالي' },
            { key: 'daysLeft', label: 'يكفي كام يوم' },
            { key: 'reorder', label: 'الكمية المقترح طلبها' },
            { key: 'cost', label: 'تكلفة الطلبية التقديرية' },
          ],
          rows: forecasts.slice(0, 10).map((f) => ({
            name: f.it.name,
            stock: fmtQty(f.it.stockQty, arUnit(f.it.unit)),
            daysLeft: f.daysLeft >= 180 ? 'مستقر (+6 شهور)' : f.daysLeft <= 0 ? 'نفد بالفعل' : `${fmtQty(f.daysLeft)} يوم`,
            reorder: f.suggestedOrder > 0 ? fmtQty(f.suggestedOrder, arUnit(f.it.unit)) : 'لا يحتاج',
            cost: f.estOrderCost > 0 ? egp(f.estOrderCost) : '—',
          })),
          footer: [
            { label: 'أصناف تحتاج طلب قريب', value: fmtQty(urgentItems.length) },
            { label: 'إجمالي تكلفة الشراء المقترحة', value: egp(totalReorderCost) },
          ],
        },
      ]
    }

    case 'get_proactive_insights': {
      const [items, customers, suppliers, pendingCount, dueTasks, entries] = await Promise.all([
        db.item.findMany({ where: { businessId } }),
        db.customer.findMany({ where: { businessId, balance: { gt: 0 } }, orderBy: { balance: 'desc' } }),
        db.supplier.findMany({ where: { businessId, balance: { gt: 0 } }, orderBy: { balance: 'desc' } }),
        db.operation.count({ where: { businessId, status: 'AWAITING_APPROVAL' } }),
        db.scheduledTask.count({ where: { businessId, status: 'pending' } }),
        db.cashEntry.findMany({ where: { businessId }, select: { direction: true, amount: true } }),
      ])
      const inn = entries.filter((e) => e.direction === 'in').reduce((s, e) => s + e.amount, 0)
      const out = entries.filter((e) => e.direction === 'out').reduce((s, e) => s + e.amount, 0)
      const cashNow = biz.openingCash + inn - out
      const low = items.filter((it) => it.stockQty <= it.lowStockThreshold)
      const totalReceivables = customers.reduce((s, c) => s + c.balance, 0)
      const totalPayables = suppliers.reduce((s, x) => s + x.balance, 0)

      return [
        {
          kind: 'kv',
          title: 'نبض الشغل الاستباقي (تقرير وكيل اللحظي)',
          rows: [
            { label: 'السيولة النقدية في الخزنة', value: egp(cashNow) },
            {
              label: 'حالة المخزون والنواقص',
              value: low.length > 0 ? `${fmtQty(low.length)} صنف تحت حد الأمان (${low.slice(0, 3).map((i) => i.name).join('، ')})` : 'مستقر تماماً',
            },
            {
              label: 'الفلوس اللي لينا بره (مديونيات)',
              value: totalReceivables > 0 ? `${egp(totalReceivables)} عند ${fmtQty(customers.length)} عميل` : 'مفيش مديونيات',
            },
            {
              label: 'المستحقات علينا للموردين',
              value: totalPayables > 0 ? `${egp(totalPayables)} لـ ${fmtQty(suppliers.length)} مورد` : 'مفيش مستحقات',
            },
            { label: 'مسودات مستنية اعتمادك', value: fmtQty(pendingCount) },
            { label: 'مهام مجدولة قيد المتابعة', value: fmtQty(dueTasks) },
          ],
        },
      ]
    }
  }
}
