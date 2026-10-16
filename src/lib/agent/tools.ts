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
            { label: 'عدد العمليات', value: String(ops.length) },
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
          footer: [{ label: 'إجمالي الأصناف الناقصة', value: String(low.length) }],
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
          footer: [{ label: 'إجمالي', value: String(in30.length) }],
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
  }
}
