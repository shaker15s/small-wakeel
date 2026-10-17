// وكيل — read tools: deterministic queries the agent can run (R0).
// Results are structured ResultCardDTOs the UI renders as tables/kv cards.

import type { Item, Customer, Supplier, Operation } from '@prisma/client'
import { normalizeAr } from './arabic'
import { searchWeb } from './websearch'
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
  | 'get_period_totals'
  | 'search_web'
  | 'business_advice'

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
  'search_web',
  'business_advice',
  'get_period_totals',
])

/**
 * «مين اللي …» / «ايه …» / «كام …» are question words, not names. Without this
 * guard a question became a lookup for a customer/member literally called
 * «مين اللي» and the agent answered «ملقيتش عضو بالاسم «مين اللي»» (live R29).
 */
const QUESTION_WORDS =
  /^(مين|من|ايه|إيه|كام|قد|قدايه|قد\s*ايه|اللي|هو|هي|هما|دول|دي|ده|فين|امتى|إمتى|ازاي|إزاي|ليه|ليه|على|عن|العميل|العميله|العضو|الاعضاء|الاعضاء|بتاع|بتاعت|كل|أي|اي)$/
export function isQuestionWord(name: string): boolean {
  const words = normalizeAr(name).replace(/\s+/g, ' ').trim().split(' ')
  return words.length > 0 && words.every((w) => QUESTION_WORDS.test(w))
}

/** العضويات اللي قربت تخلص — shared by list_expiring and a question-shaped
 *  get_member_status («مين اللي عضويته قربت تخلص؟» is a LIST question, not a
 *  lookup for a member literally called «مين اللي»). */
async function gymExpiringCards(businessId: string): Promise<ResultCardDTO[]> {
  const members = await db.customer.findMany({
    where: { businessId, expiresAt: { not: null } },
    orderBy: { expiresAt: 'asc' },
  })
  const soon = members
    .map((m) => ({ m, days: Math.ceil(((m.expiresAt as Date).getTime() - Date.now()) / 86400000) }))
    .filter((r) => r.days <= 30)
  const expired = soon.filter((r) => r.days < 0)
  return [
    {
      kind: 'table',
      title: 'العضويات اللي قربت تخلص (30 يوم)',
      columns: [
        { key: 'name', label: 'العضو' },
        { key: 'plan', label: 'الاشتراك' },
        { key: 'expiry', label: 'بينتهي' },
        { key: 'days', label: 'فاضل' },
        { key: 'balance', label: 'عليه' },
      ],
      rows: soon.slice(0, 12).map(({ m, days }) => ({
        name: m.name,
        plan: m.plan ?? '—',
        expiry: arDate(m.expiresAt as Date),
        days: days < 0 ? `متأخر ${fmtQty(Math.abs(days))} يوم` : `${fmtQty(days)} يوم`,
        balance: m.balance > 0 ? egp(m.balance) : '—',
      })),
      footer: [
        { label: 'إجمالي', value: `${fmtQty(soon.length)} عضوية` },
        { label: 'منتهية بالفعل', value: `${fmtQty(expired.length)}` },
      ],
    },
  ]
}

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
  customer_add: 'عميل جديد',
  supplier_add: 'مورد جديد',
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

    case 'get_period_totals': {
      // «بعت كام علبة لبن الشهر ده؟» used to answer with «آخر الحركات» (eight
      // rows) — technically related, practically useless. The owner asked for a
      // NUMBER; this tool gives the number, the quantity and the count.
      const metric = String(args.metric ?? 'sales')
      const days = Math.max(1, Math.min(365, Number(args.days ?? 30) || 30))
      // «النهارده» is the Cairo day, not «now − 24h»: the shop's day starts at
      // midnight, and a 24h window silently includes yesterday evening (live
      // R31: «صرفت كام النهارده؟» counted 10 old expenses).
      const from = days === 1 ? startOfCairoDay(0) : new Date(Date.now() - days * 86400000)
      const types =
        metric === 'sales'
          ? ['sale', 'membership']
          : metric === 'collections'
            ? ['collection']
            : metric === 'purchases'
              ? ['purchase']
              : ['expense']
      const label = metric === 'sales' ? 'مبيعات' : metric === 'collections' ? 'تحصيلات' : metric === 'purchases' ? 'مشتريات' : 'مصروفات'
      const ops = await db.operation.findMany({
        where: { businessId, status: 'SUCCEEDED', type: { in: types }, createdAt: { gte: from } },
      })
      const money = (payload: string): number => {
        const p = (() => {
          try {
            return JSON.parse(payload) as Record<string, unknown>
          } catch {
            return {}
          }
        })()
        for (const k of ['total', 'amount', 'paid', 'value']) {
          const n = Number(p[k])
          if (Number.isFinite(n) && n > 0) return Math.round(n)
        }
        return 0
      }
      const flat = (x: string) => normalizeAr(x).replace(/\s+/g, ' ').trim()
      const query = flat(String(args.query ?? ''))
      // a name in the question («لبن» / «أم حسن») narrows the same numbers
      let matched = ops
      let subject = ''
      if (query.length >= 2) {
        const tokens = query.split(' ').filter((t) => t.length >= 3)
        const candidates = metric === 'collections' ? (await db.customer.findMany({ where: { businessId } })).map((c) => ({ name: c.name })) : (await db.item.findMany({ where: { businessId } })).map((i) => ({ name: i.name }))
        const hit =
          candidates.find((c) => tokens.length > 0 && tokens.every((t) => flat(c.name).includes(t))) ??
          candidates.find((c) => tokens.some((t) => t.length >= 3 && flat(c.name).includes(t)))
        if (hit) {
          subject = hit.name
          const key = flat(hit.name)
          matched = ops.filter((o) => flat(o.payload).includes(key))
        }
      }
      // a gym «sells» memberships: call them مبيعات in the same number
      const total = matched.reduce((sum, o) => sum + money(o.payload), 0)
      let qty = 0
      if (metric === 'sales') {
        for (const o of matched) {
          try {
            const p = JSON.parse(o.payload) as Record<string, unknown>
            const n = Number(p.qty)
            if (Number.isFinite(n) && n > 0) qty += n
            // a seeded sale is stored as `lines` — the quantity lives there
            const lines = Array.isArray(p.lines) ? (p.lines as Record<string, unknown>[]) : []
            for (const l of lines) {
              const ln = Number(l.qty)
              if (Number.isFinite(ln) && ln > 0) qty += ln
            }
          } catch {
            /* a payload we cannot read contributes money only */
          }
        }
      }
      const period = days === 1 ? 'النهارده' : days === 7 ? 'آخر ٧ أيام' : `آخر ${fmtQty(days)} يوم`
      return [
        {
          kind: 'kv',
          title: `${label}${subject ? ` — ${subject}` : ''} · ${period}`,
          rows: [
            { label: 'الإجمالي', value: egp(total) },
            ...(qty > 0 ? [{ label: 'الكمية', value: fmtQty(qty) }] : []),
            { label: 'عدد العمليات', value: fmtQty(matched.length) },
          ],
          ...(matched.length === 0
            ? { rows: [{ label: 'النتيجة', value: `مفيش ${label} مسجلة ${period}${subject ? ` ل${subject}` : ''}` }] }
            : {}),
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
      // «ايه اللي قرب ينتهي؟» means a MEMBERSHIP at a gym and a BATCH at a shop.
      // Answering a gym owner with the pharmacy's expiry table (live bug: the
      // gym's question returned «الأصناف اللي صلاحيتها قربت تخلص») is exactly the
      // wrong-tool class the owner notices immediately.
      const business = await db.business.findUnique({ where: { id: businessId }, select: { type: true } })
      const isGym = business?.type === 'gym'
      if (isGym) return gymExpiringCards(businessId)
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
      const name = String(args.name ?? '').trim()
      const members: Customer[] = await db.customer.findMany({ where: { businessId }, orderBy: { name: 'asc' } })
      // Same money rule as the customer file: an exact name wins; a partial one
      // is accepted only when it is unambiguous (multi-word or 6+ chars), and a
      // near miss is REPORTED rather than answered with another member's plan.
      // normalized on both sides (see get_customer_history) — and a QUESTION word
      // («مين اللي عضويته قربت تخلص؟») is not a member name: it must fall to the
      // list, never to «ملقيتش عضو بالاسم «مين اللي»» (live R29).
      const flat = (x: string) => normalizeAr(x).replace(/\s+/g, ' ').trim()
      const asked = !name || isQuestionWord(name)
      // A question word is the owner asking for a LIST. Answer the list.
      if (asked) return gymExpiringCards(businessId)
      const strong = members.filter((m) => {
        if (!name || asked || !flat(m.name).includes(flat(name))) return false
        return flat(name).split(' ').filter(Boolean).length >= 2 || flat(name).length >= 6
      })
      const exact = name && !asked ? members.find((m) => flat(m.name) === flat(name)) : undefined
      const found = exact ?? (strong.length === 1 ? strong[0] : undefined)
      const near =
        found || !name
          ? []
          : members
              .filter((m) => {
                // «عمر الشناوي عضويته باقي قد إيه؟» — the member is the words
                // BEFORE «عضويته/اشتراكه»: token-overlap, longest first
                const tokens = name.split(' ').filter((t) => t.length >= 2)
                return tokens.length > 0 && tokens.every((t) => flat(m.name).includes(t))
              })
              .slice(0, 3)
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
            : [
                { label: 'النتيجة', value: name ? `ملقيتش عضو بالاسم «${name}»` : 'اكتبلي اسم العضو' },
                ...(near.length > 0
                  ? [{ label: 'قصدت؟', value: near.map((m) => `${m.name}${m.expiresAt ? ` — لحد ${arDate(m.expiresAt)}` : ''}`).join(' · ') }]
                  : []),
              ],
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
      const name = String(args.name ?? '').trim()
      const customers = await db.customer.findMany({ where: { businessId } })
      // Money answers must name the RIGHT person: an exact name wins, and a
      // partial hit is used only when nothing exact exists. A near miss is
      // REPORTED («مفيش أحمد — بس فيه أحمد عبد الرحمن») instead of silently
      // landing on someone else's debt (live R29 bug: «أحمد» answered with the
      // balance of «أحمد عبد الرحمن»).
      // The name arrives NORMALIZED (normalizeAr folds ى→ي, ة→ه, أ→ا) while the
      // DB stores the raw spelling — comparing them directly meant «مستشفى الرحمة»
      // (typed) never matched «مستشفى الرحمة» (stored). Normalize BOTH sides.
      const flat = (x: string) => normalizeAr(x).replace(/\s+/g, ' ').trim()
      const wordCount = (x: string) => flat(x).split(' ').filter(Boolean).length
      // (1) EXACT name. (2) else a STRONG partial only: a word-boundary match
      // that is multi-word or long enough to be unambiguous. «أم حسن» resolves,
      // «أحمد» does NOT — it is a first name shared by several people, and
      // answering one man with another man's debt is the one mistake an
      // accountant must never make (live R29: «أحمد عليه كام؟» answered with
      // «أحمد عبد الرحمن»'s balance).
      const exact = customers.find((c) => flat(c.name) === flat(name))
      const strong = customers.filter((c) => {
        if (!flat(c.name).includes(flat(name))) return false
        return wordCount(name) >= 2 || flat(name).length >= 6
      }).filter((c) => !isQuestionWord(name))
      const partial = exact ?? (strong.length === 1 ? strong[0] : undefined)
      if (!partial) {
        const near = customers.filter((c) => flat(c.name).includes(flat(name))).slice(0, 3)
        return [
          {
            kind: 'kv',
            title: 'ملف العميل',
            rows: [
              { label: 'النتيجة', value: `ملقيتش عميل بالاسم «${name}» — مفيش عميل بالاسم ده في السجل` },
              ...(near.length > 0
                ? [{ label: 'قصدت؟', value: `${near.map((c) => `${c.name} (عليه ${egp(c.balance)})`).join(' · ')} — اكتب الاسم زي ما هو في السجل` }]
                : [{ label: 'الخطوة', value: `قولّي «ضيف ${name}» وأنا أسجله في السجل` }]),
            ],
          },
        ]
      }
      const found = partial
      const ops = await db.operation.findMany({
        where: { businessId, status: 'SUCCEEDED', OR: [{ summary: { contains: found.name } }, { type: { in: ['collection', 'sale'] } }] },
        orderBy: { createdAt: 'desc' },
        take: 60,
      })
      const mine = ops.filter((op) => op.summary.includes(found.name) || opLines(op.payload).length > 0)
      const collections = mine.filter((op) => op.type === 'collection')
      const avgCollection =
        collections.length > 0 ? Math.round(collections.reduce((s2, o) => s2 + opAmount(o.payload), 0) / collections.length) : 0
      // «ضيف أحمد وعليه ٤٥٠ من أيام ١٠ أكتوبر» — the opening balance's own date is
      // read back from the customer_add operation, so the owner sees WHEN the debt
      // started (not just the amount).
      const addOp = mine.find((op) => op.type === 'customer_add' || op.type === 'supplier_add')
      let sinceLabel: string | null = null
      if (addOp) {
        try {
          const pj = JSON.parse(addOp.payload) as { since?: string }
          if (pj.since) {
            const d = new Date(pj.since)
            if (!Number.isNaN(d.getTime())) sinceLabel = arDate(d)
          }
        } catch {
          /* payload not JSON — the balance is still shown */
        }
      }
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
            ...(sinceLabel ? [{ label: 'الرصيد الافتتاحي من', value: sinceLabel }] : []),
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

    case 'search_web': {
      // «ابحث في الويب عن سعر الجبنة» — pluggable backend (see websearch.ts).
      // The ledger stays the source of truth; the web enters as SOURCES with a
      // snippet and a host, never as a number the agent pretends to know.
      const query = String(args.query ?? args.q ?? '').trim()
      if (query.length < 2) {
        return [{ kind: 'kv', title: 'بحث في الويب', rows: [{ label: 'النتيجة', value: 'محتاج كلمة أبحث بيها' }] }]
      }
      const outcome = await searchWeb(query, 5)
      if (outcome.results.length === 0) {
        return [
          {
            kind: 'kv',
            title: `بحث في الويب: ${query}`,
            rows: [
              { label: 'النتيجة', value: 'مفيش نتايج' },
              { label: 'السبب', value: outcome.error ?? 'المزوّد مرجّعش حاجة' },
              { label: 'الحل', value: 'ظبّط WAKIL_SEARCH_URL أو .z-ai-config عشان البحث يشتغل' },
            ],
          },
        ]
      }
      return [
        {
          kind: 'sources',
          title: `نتايج البحث: ${query}`,
          sources: outcome.results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet, host: r.host })),
        },
        {
          kind: 'kv',
          title: 'خلاصة البحث',
          rows: [
            { label: 'أول نتيجة', value: outcome.results[0].snippet.slice(0, 180) },
            { label: 'المصادر', value: `${fmtQty(outcome.results.length)} مصدر · ${outcome.backend}` },
          ],
        },
      ]
    }

    case 'business_advice': {
      // «انصحني» / «حلل شغلي» — a deterministic advisor. It reads the ledger and
      // states what is measurably true (or nothing at all): no invented advice,
      // no generic business-school filler.
      const days = Math.min(90, Math.max(7, Number(args.days ?? 30) || 30))
      const since = startOfCairoDay(-(days - 1))
      const prevStart = startOfCairoDay(-(days * 2 - 1))
      const [ops, prevOps, items, entries] = await Promise.all([
        db.operation.findMany({ where: { businessId, status: 'SUCCEEDED', createdAt: { gte: since } }, orderBy: { createdAt: 'desc' } }),
        db.operation.findMany({ where: { businessId, status: 'SUCCEEDED', createdAt: { gte: prevStart, lt: since } } }),
        db.item.findMany({ where: { businessId } }),
        db.cashEntry.findMany({ where: { businessId } }),
      ])
      const sum = (list: typeof ops, type: string) => list.filter((o) => o.type === type).reduce((acc, o) => acc + opAmount(o.payload), 0)
      const sales = sum(ops, 'sale')
      const prevSales = sum(prevOps, 'sale')
      const expenses = sum(ops, 'expense')
      const collections = sum(ops, 'collection')
      const cash = biz.openingCash + entries.reduce((acc, e) => acc + (e.direction === 'in' ? e.amount : -e.amount), 0)

      // Velocity per item (last `days`) → what is about to run out.
      const sold = new Map<string, number>()
      for (const op of ops) {
        if (op.type !== 'sale') continue
        for (const line of opLines(op.payload)) {
          if (!line.itemId) continue
          sold.set(line.itemId, (sold.get(line.itemId) ?? 0) + line.qty)
        }
      }
      const atRisk = items
        .map((it) => {
          const perDay = (sold.get(it.id) ?? 0) / days
          return { it, daysLeft: perDay > 0 ? it.stockQty / perDay : null }
        })
        .filter((r) => r.daysLeft != null && r.daysLeft <= 7)
        .sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0))

      // Dead stock: real money sitting on the shelf with no movement.
      const dead = items
        .filter((it) => !sold.has(it.id) && it.stockQty > 0 && it.costPrice > 0)
        .map((it) => ({ it, value: it.stockQty * it.costPrice }))
        .sort((a, b) => b.value - a.value)

      const customers = await db.customer.findMany({ where: { businessId, balance: { gt: 0 } }, orderBy: { balance: 'desc' } })
      const receivables = customers.reduce((acc, c) => acc + c.balance, 0)
      const salesDelta = prevSales > 0 ? Math.round(((sales - prevSales) / prevSales) * 100) : null
      const collectionRate = sales > 0 ? Math.round((collections / sales) * 100) : null
      const expenseShare = sales > 0 ? Math.round((expenses / sales) * 100) : null

      const findings: string[] = []
      if (salesDelta != null && salesDelta <= -10) findings.push(`المبيعات نزلت ${Math.abs(salesDelta)}٪ عن الفترة اللي قبلها — راجع الأصناف اللي بطّلت تتحرك`)
      if (salesDelta != null && salesDelta >= 15) findings.push(`المبيعات زادت ${salesDelta}٪ عن الفترة اللي قبلها — كمّل على نفس التشكيلة`)
      if (expenseShare != null && expenseShare >= 25) findings.push(`المصروفات واخدة ${expenseShare}٪ من المبيعات — ده رقم عالي، بص على البنود الكبيرة`)
      if (collectionRate != null && collectionRate < 60) findings.push(`بتحصّل ${collectionRate}٪ بس من مبيعات الفترة — الفلوس قاعدة عند العملاء مش في الخزنة`)
      if (atRisk.length > 0) findings.push(`${fmtQty(atRisk.length)} صنف هتخلص في أقل من أسبوع (أسرعهم ${atRisk[0].it.name})`)
      if (dead.length > 0) findings.push(`رأس مال راكد ${egp(dead.reduce((acc, d) => acc + d.value, 0))} في ${fmtQty(dead.length)} صنف مش بيتحرك`)
      if (cash < 0) findings.push('الخزنة بالسالب — راجع التحصيلات المسجلة')
      if (findings.length === 0) findings.push('مفيش مؤشر خطر واضح في الفترة دي — الأرقام ماشية في نطاقها الطبيعي')

      return [
        {
          kind: 'kv',
          title: `قراءة شغلك — آخر ${days} يوم`,
          rows: [
            { label: 'المبيعات', value: egp(sales) },
            { label: 'المصروفات', value: egp(expenses) },
            { label: 'التحصيل', value: egp(collections) },
            { label: 'المتاح في الخزنة', value: egp(cash) },
            { label: 'مديونيات العملاء', value: egp(receivables) },
            { label: 'أهم ملاحظة', value: findings[0] },
          ],
        },
        {
          kind: 'table',
          title: 'التوصيات المرتبة بالأولوية',
          columns: [
            { key: 'n', label: '#' },
            { key: 'advice', label: 'نصيحة مبنية على أرقامك' },
          ],
          rows: findings.map((f, i) => ({ n: String(i + 1), advice: f })),
          footer: [{ label: 'المصادر', value: 'سجل عملياتك الحقيقي' }],
        },
      ]
    }
  }
}
