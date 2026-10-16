// وكيل — read tools: deterministic queries the agent can run (R0).
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
  // R28 — «سوبر باورز»: the questions a real owner asks about money and the
  // future, not just «what happened» (each one is pure SQL + arithmetic).
  | 'get_profit_margin'
  | 'forecast_stockout'
  | 'get_customer_history'
  | 'compare_periods'
  | 'expense_breakdown'

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
  'get_profit_margin',
  'forecast_stockout',
  'get_customer_history',
  'compare_periods',
  'expense_breakdown',
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

/** Total piastres of an operation payload — the ONE place that knows the key
 *  names («total» for sales/purchases, «amount» for money-only moves). */
function opAmount(payload: string): number {
  try {
    const p = JSON.parse(payload) as Record<string, unknown>
    const v = Number(p.total ?? p.amount ?? 0)
    return Number.isFinite(v) ? v : 0
  } catch {
    return 0
  }
}

/** Sold quantity of an operation payload (baskets keep `lines`). */
function opQty(payload: string): number {
  try {
    const p = JSON.parse(payload) as Record<string, unknown>
    if (Array.isArray(p.lines)) {
      return (p.lines as Record<string, unknown>[]).reduce((sum, l) => sum + Number(l.qty ?? 0), 0)
    }
    const v = Number(p.qty ?? 0)
    return Number.isFinite(v) ? v : 0
  } catch {
    return 0
  }
}

/** A basket expanded to lines — used by margin/forecast to price real sales. */
function opLines(payload: string): { itemId: string; qty: number; total: number }[] {
  try {
    const p = JSON.parse(payload) as Record<string, unknown>
    if (Array.isArray(p.lines)) {
      return (p.lines as Record<string, unknown>[]).map((l) => ({
        itemId: String(l.itemId ?? ''),
        qty: Number(l.qty ?? 0),
        total: Number(l.total ?? 0),
      }))
    }
    if (p.itemId) return [{ itemId: String(p.itemId), qty: Number(p.qty ?? 0), total: Number(p.total ?? 0) }]
    return []
  } catch {
    return []
  }
}

/** Sales rows (SUCCEEDED) inside a window, newest first. */
async function salesIn(businessId: string, days: number) {
  const since = startOfCairoDay(-(days - 1))
  return db.operation.findMany({
    where: { businessId, type: 'sale', status: 'SUCCEEDED', createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
  })
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
        where: { businessId, stockQty: { lte: biz.type === 'pharmacy' ? 999999999 : 999999999 } },
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
          rows: in30.map((it) => ({ name: it.name, batch: it.batchNo ?? '—', expiry: arDate(it.expiresAt!), stock: fmtQty(it.stockQty, arUnit(it.unit)) })),
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
          title: 'المديونيات — اللي علينا للعملاء... يعني اللي ليّ عليهم',
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

    // ---------------------------------------------------------------
    // R28 «سوبر باورز» — the five questions a working owner actually asks.
    // All deterministic: SQL + arithmetic, no model, no guessing.
    // ---------------------------------------------------------------

    case 'get_profit_margin': {
      // «أنا كسبان كام على الصنف ده؟» — real margin, from real sales.
      const days = Math.min(365, Math.max(7, Number(args.days ?? 30) || 30))
      const [items, sales] = await Promise.all([db.item.findMany({ where: { businessId } }), salesIn(businessId, days)])
      const perItem = new Map<string, { qty: number; revenue: number }>()
      for (const op of sales) {
        for (const l of opLines(op.payload)) {
          if (!l.itemId) continue
          const cur = perItem.get(l.itemId) ?? { qty: 0, revenue: 0 }
          cur.qty += l.qty
          cur.revenue += l.total
          perItem.set(l.itemId, cur)
        }
      }
      const rows = items
        .map((it) => {
          const sold = perItem.get(it.id)
          const cost = it.costPrice
          const margin = it.sellPrice - cost
          const pct = it.sellPrice > 0 ? Math.round((margin / it.sellPrice) * 100) : 0
          const profit = sold ? Math.round(sold.revenue - cost * sold.qty) : 0
          return { it, sold, margin, pct, profit }
        })
        .filter((r) => r.it.sellPrice > 0)
        .sort((a, b) => b.profit - a.profit)
      const sold = rows.filter((r) => r.sold && r.sold.qty > 0).slice(0, 6)
      // No sales in the window? Never answer with an empty table — fall back to
      // the PRICE margins of the catalog, clearly labelled as such. «مفيش
      // مبيعات» is not a useful answer to «بربح كام؟» at 9am before the day starts.
      const best = sold.length > 0 ? sold : rows.slice(0, 6)
      const thin = rows.filter((r) => r.pct < 12).slice(0, 5)
      const totalProfit = rows.reduce((s2, r) => s2 + r.profit, 0)
      return [
        {
          kind: 'table',
          title: `الربح الحقيقي — آخر ${days} يوم`,
          columns: [
            { key: 'name', label: 'الصنف' },
            { key: 'sold', label: 'اتباع' },
            { key: 'revenue', label: 'الإيراد' },
            { key: 'profit', label: 'الربح' },
            { key: 'pct', label: 'هامش %' },
          ],
          rows: best.map((r) => ({
            name: r.it.name,
            sold: `${fmtQty(r.sold?.qty ?? 0, arUnit(r.it.unit))}`,
            revenue: egp(r.sold?.revenue ?? 0),
            profit: egp(r.profit),
            pct: `${r.pct}%`,
          })),
          footer: [
            { label: 'إجمالي الربح التقديري', value: egp(totalProfit) },
            { label: 'أقل الأصناف ربحية', value: thin.length > 0 ? thin.map((r) => r.it.name).join('، ') : 'مفيش' },
            ...(sold.length === 0
              ? [{ label: 'ملاحظة', value: `مفيش مبيعات في آخر ${days} يوم — الجدول بيعرض هوامش الأسعار` }]
              : []),
          ],
        },
      ]
    }

    case 'forecast_stockout': {
      // «إيه اللي هيخلص قبل ما أحس؟» — velocity → days left → order today.
      const days = Math.min(90, Math.max(7, Number(args.days ?? 14) || 14))
      const [items, sales] = await Promise.all([db.item.findMany({ where: { businessId } }), salesIn(businessId, days)])
      const soldMap = new Map<string, number>()
      for (const op of sales) {
        for (const l of opLines(op.payload)) {
          if (!l.itemId) continue
          soldMap.set(l.itemId, (soldMap.get(l.itemId) ?? 0) + l.qty)
        }
      }
      const atRisk = items
        .map((it) => {
          const soldQty = soldMap.get(it.id) ?? 0
          const perDay = soldQty / days
          const daysLeft = perDay > 0 ? it.stockQty / perDay : null
          // order enough for the next 30 days, never less than the threshold
          const suggested = perDay > 0 ? Math.max(Math.ceil(perDay * 30 - it.stockQty), 0) : 0
          return { it, perDay, daysLeft, suggested }
        })
        .filter((r) => r.daysLeft != null && r.daysLeft <= 10)
        .sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0))
      return [
        {
          kind: 'table',
          title: `توقّع النقص — الأصناف اللي بتخلص في ${days} يوم مراقبة`,
          columns: [
            { key: 'name', label: 'الصنف' },
            { key: 'left', label: 'المتاح' },
            { key: 'rate', label: 'معدل البيع/يوم' },
            { key: 'days', label: 'فاضل' },
            { key: 'order', label: 'اطلب' },
          ],
          rows: atRisk.slice(0, 8).map((r) => ({
            name: r.it.name,
            left: fmtQty(r.it.stockQty, arUnit(r.it.unit)),
            rate: r.perDay.toFixed(2),
            days: r.daysLeft != null ? `${Math.max(0, Math.floor(r.daysLeft))} يوم` : '—',
            order: r.suggested > 0 ? fmtQty(r.suggested, arUnit(r.it.unit)) : '—',
          })),
          footer:
            atRisk.length === 0
              ? [{ label: 'الحالة', value: 'مفيش صنف هيخلص قريب — الدنيا مطمنة' }]
              : [{ label: 'أسرع صنف هيخلص', value: `${atRisk[0].it.name} — ${Math.max(0, Math.floor(atRisk[0].daysLeft ?? 0))} يوم` }],
        },
      ]
    }

    case 'get_customer_history': {
      // «العميل ده بيحاسب إزاي؟» — balance, cadence, last movements.
      const name = String(args.name ?? '')
      const customers = await db.customer.findMany({ where: { businessId } })
      const found = customers.find((c) => c.name.includes(name) || name.includes(c.name.split(' ')[0]))
      if (!found) {
        return [{ kind: 'kv', title: 'ملف العميل', rows: [{ label: 'النتيجة', value: `ملقيتش عميل بالاسم «${name}»` }] }]
      }
      const ops = await db.operation.findMany({
        where: { businessId, status: 'SUCCEEDED', OR: [{ summary: { contains: found.name } }, { type: { in: ['collection', 'sale'] } }] },
        orderBy: { createdAt: 'desc' },
        take: 60,
      })
      const mine = ops.filter((op) => op.summary.includes(found.name) || opLines(op.payload).length > 0)
      const collections = mine.filter((op) => op.type === 'collection')
      const avgCollection =
        collections.length > 0 ? Math.round(collections.reduce((s2, o) => s2 + opAmount(o.payload), 0) / collections.length) : 0
      const gapDays =
        collections.length >= 2
          ? Math.round(
              (collections[0].createdAt.getTime() - collections[collections.length - 1].createdAt.getTime()) /
                86400000 /
                (collections.length - 1),
            )
          : null
      return [
        {
          kind: 'kv',
          title: `ملف ${found.name}`,
          rows: [
            { label: 'المديونية الحالية', value: egp(found.balance) },
            { label: 'آخر تحصيل', value: collections[0] ? `${egp(opAmount(collections[0].payload))} — ${arDate(collections[0].createdAt)}` : 'مفيش' },
            { label: 'متوسط التحصيل', value: avgCollection > 0 ? egp(avgCollection) : '—' },
            { label: 'بيسدد كل', value: gapDays != null ? `${gapDays} يوم تقريبًا` : 'مفيش بيانات كفاية' },
            ...(found.phone ? [{ label: 'التليفون', value: found.phone }] : []),
          ],
        },
        {
          kind: 'table',
          title: `آخر حركات ${found.name}`,
          columns: [
            { key: 'ref', label: 'الرقم' },
            { key: 'type', label: 'النوع' },
            { key: 'amount', label: 'المبلغ' },
            { key: 'date', label: 'التاريخ' },
          ],
          rows: mine.slice(0, 6).map((op) => ({
            ref: op.ref,
            type: TYPE_AR[op.type] ?? op.type,
            amount: egp(opAmount(op.payload)),
            date: arDate(op.createdAt),
          })),
        },
      ]
    }

    case 'compare_periods': {
      // «أنا أحسن من الأسبوع اللي فات؟» — two windows, one honest verdict.
      const days = Math.min(90, Math.max(2, Number(args.days ?? 7) || 7))
      const nowStart = startOfCairoDay(-(days - 1))
      const prevStart = startOfCairoDay(-(days * 2 - 1))
      const [nowOps, prevOps] = await Promise.all([
        db.operation.findMany({ where: { businessId, status: 'SUCCEEDED', createdAt: { gte: nowStart } } }),
        db.operation.findMany({ where: { businessId, status: 'SUCCEEDED', createdAt: { gte: prevStart, lt: nowStart } } }),
      ])
      const sum = (ops: typeof nowOps, type: string) =>
        ops.filter((o) => o.type === type).reduce((s2, o) => s2 + opAmount(o.payload), 0)
      const count = (ops: typeof nowOps, type: string) => ops.filter((o) => o.type === type).length
      const now = { sales: sum(nowOps, 'sale'), expense: sum(nowOps, 'expense'), collections: sum(nowOps, 'collection'), tickets: count(nowOps, 'sale') }
      const prev = { sales: sum(prevOps, 'sale'), expense: sum(prevOps, 'expense'), collections: sum(prevOps, 'collection'), tickets: count(prevOps, 'sale') }
      const delta = (a: number, b: number) => {
        if (b === 0) return a > 0 ? 'جديد ↑' : '—'
        const pct = Math.round(((a - b) / b) * 100)
        return `${pct >= 0 ? '↑' : '↓'} ${Math.abs(pct)}%`
      }
      const verdict =
        now.sales > prev.sales
          ? prev.sales > 0
            ? `مبيعاتك زادت ${Math.round(((now.sales - prev.sales) / prev.sales) * 100)}% — كمّل`
            : 'بيعت في الفترة دي ومفيش مبيعات قبلها'
          : prev.sales > 0
            ? 'المبيعات نزلت — بص على الأصناف اللي بطّلت تتحرك'
            : 'الفترتين فاضيين — لسه مفيش حركة مسجلة'
      return [
        {
          kind: 'kv',
          title: `مقارنة آخر ${days} يوم بالـ${days} اللي قبلهم`,
          rows: [
            { label: 'المبيعات', value: `${egp(now.sales)} (${delta(now.sales, prev.sales)})` },
            { label: 'عدد الفواتير', value: `${now.tickets} (${delta(now.tickets, prev.tickets)})` },
            { label: 'المصروف', value: `${egp(now.expense)} (${delta(now.expense, prev.expense)})` },
            { label: 'التحصيل', value: `${egp(now.collections)} (${delta(now.collections, prev.collections)})` },
            { label: 'الفرق الصافي', value: egp(now.sales - now.expense - (prev.sales - prev.expense)) },
            { label: 'الحكم', value: verdict },
          ],
        },
      ]
    }

    case 'expense_breakdown': {
      // «فلوسي بتتصرف في إيه؟» — categories, not a flat list.
      const days = Math.min(365, Math.max(7, Number(args.days ?? 30) || 30))
      const since = startOfCairoDay(-(days - 1))
      const expenses = await db.operation.findMany({
        where: { businessId, type: 'expense', status: 'SUCCEEDED', createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
      })
      const byCat = new Map<string, number>()
      for (const op of expenses) {
        let cat = 'مصروفات عامة'
        try {
          const p = JSON.parse(op.payload) as Record<string, unknown>
          cat = String(p.category ?? p.kind ?? cat)
        } catch {
          /* keep the default bucket */
        }
        byCat.set(cat, (byCat.get(cat) ?? 0) + opAmount(op.payload))
      }
      const total = [...byCat.values()].reduce((s2, v) => s2 + v, 0)
      const ranked = [...byCat.entries()].sort((a, b) => b[1] - a[1])
      return [
        {
          kind: 'table',
          title: `المصروفات آخر ${days} يوم — إجمالي ${egp(total)}`,
          columns: [
            { key: 'cat', label: 'البند' },
            { key: 'amount', label: 'المبلغ' },
            { key: 'share', label: 'النسبة' },
            { key: 'perDay', label: 'في اليوم' },
          ],
          rows: ranked.slice(0, 8).map(([cat, amount]) => ({
            cat,
            amount: egp(amount),
            share: total > 0 ? `${Math.round((amount / total) * 100)}%` : '—',
            perDay: egp(Math.round(amount / days)),
          })),
          footer:
            ranked.length === 0
              ? [{ label: 'الحالة', value: 'مفيش مصروفات مسجلة في الفترة دي' }]
              : [
                  { label: 'أكبر بند', value: `${ranked[0][0]} — ${egp(ranked[0][1])}` },
                  { label: 'عدد المصروفات', value: String(expenses.length) },
                ],
        },
      ]
    }
  }
}
