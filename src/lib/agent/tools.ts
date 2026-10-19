import { reportedType } from '@/lib/cashbook-report'
import { cashbookCash } from '@/lib/domain/cashbook'
// وكيل — read tools: deterministic queries the agent can run (R0).
// Results are structured ResultCardDTOs the UI renders as tables/kv cards.

import type { Item, Customer, Supplier, Operation } from '@prisma/client'
import { normalizeAr, toWesternDigits } from './arabic'
import { searchWeb } from './websearch'
import { db } from '@/lib/db'
import type { ResultCardDTO } from '@/lib/types'
import { egp, qty as fmtQty, arDate, arTime } from '@/lib/format'
import { arUnit } from '@/lib/verticals'
import { cairoIsoDay, startOfCairoDay } from '@/app/api/_lib/dates'
import { inspectDesktopApplication, scanRunningApplications, executeBridgedTool } from './cli-anything/bridge'
import { pythonProbe, cliHubProbe, hubSearch, hubInstall, locateSkillMd, parseSkillMd, registerHarness, generatePipeline, readFileBounded } from './cli-anything/harness-installer'

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
  | 'get_supplier_history'
  | 'get_contact_info'
  | 'get_financial_position'
  | 'compare_periods'
  | 'expense_breakdown'
  | 'get_period_totals'
  | 'get_stock_value'
  | 'get_top_items'
  | 'get_dead_stock'
  | 'get_customer_ranking'
  | 'get_staff_performance'
  | 'get_price_check'
  | 'get_reorder_list'
  | 'get_profit_by_item'
  | 'search_web'
  | 'business_advice'
  | 'analyze_profitability'
  | 'forecast_stock'
  | 'get_proactive_insights'
  | 'cli_inspect_app'
  | 'cli_sync_desktop_data'
  | 'cli_list_desktop_apps'
  | 'cli_control_app'
  | 'cli_harness_install'

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
  'get_supplier_history',
  'get_contact_info',
  'get_financial_position',
  'compare_periods',
  'expense_breakdown',
  'search_web',
  'business_advice',
  'get_period_totals',
  'get_stock_value',
  'get_top_items',
  'get_dead_stock',
  'get_customer_ranking',
  'get_staff_performance',
  'get_price_check',
  'get_reorder_list',
  'get_profit_by_item',
  'analyze_profitability',
  'forecast_stock',
  'get_proactive_insights',
  'cli_inspect_app',
  'cli_sync_desktop_data',
  'cli_list_desktop_apps',
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
  debt_promise: 'تعديل وعد السداد',
  cashbook: 'دفتر الكاش والآجل',
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
  price_change: 'تغيير سعر',
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
// ---------------------------------------------------------------------------
// Payload readers shared by the aggregate tools.
//
// Seeded/real operations store money in four different shapes: `total` (sales,
// purchases), `amount` (collections, expenses, memberships), `paid`, and a
// `lines[]` array whose money is unitPrice×qty. One reader means every screen
// and every answer adds the ledger the same way.
type OpPayload = Record<string, unknown>

function readPayload(raw: string): OpPayload {
  try {
    return JSON.parse(raw) as OpPayload
  } catch {
    return {}
  }
}

function linesOf(p: OpPayload): { name: string; qty: number; money: number }[] {
  if (!Array.isArray(p.lines)) return []
  return (p.lines as OpPayload[])
    .map((l) => {
      const qty = Number(l.qty)
      const price = Number(l.unitPrice ?? l.price ?? 0)
      const money = Number(l.total)
      return {
        name: String(l.name ?? l.itemName ?? '').trim(),
        qty: Number.isFinite(qty) && qty > 0 ? qty : 0,
        money: Number.isFinite(money) && money > 0 ? money : (Number.isFinite(price) ? price : 0) * (Number.isFinite(qty) ? qty : 0),
      }
    })
    .filter((l) => l.name.length > 0)
}

function payloadMoney(p: OpPayload): number {
  for (const k of ['total', 'amount', 'paid', 'value']) {
    const n = Number(p[k])
    if (Number.isFinite(n) && n > 0) return Math.round(n)
  }
  const sum = linesOf(p).reduce((s, l) => s + l.money, 0)
  return sum > 0 ? Math.round(sum) : 0
}

function payloadQty(p: OpPayload): number {
  const n = Number(p.qty)
  let qty = Number.isFinite(n) && n > 0 ? n : 0
  for (const l of linesOf(p)) qty += l.qty
  return qty
}

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

  if (biz.workflowMode === 'cashbook' && ['get_profit_margin', 'get_profit_by_item', 'analyze_profitability', 'forecast_stockout', 'forecast_stock', 'get_stock_value', 'get_top_items', 'compare_periods', 'get_staff_performance'].includes(tool)) {
    return [{ kind: 'text', title: 'البيانات مش كفاية للحساب ده', body: 'دفتر المحل مش بيسجل كل بيعة أو استهلاك المخزون. ما ينفعش نستنتج الربح أو سرعة نفاد صنف أو أداء الكاشير من عدّ الخزنة. أقدر أراجع الكاش والديون والمصاريف ومواعيد السداد المسجلة، أو أسألك عن الناقص فعلًا.' }]
  }
  if (biz.workflowMode === 'cashbook' && ['get_daily_summary', 'get_period_totals', 'expense_breakdown'].includes(tool)) {
    const days = tool === 'get_daily_summary' ? 1 : Math.max(1, Math.min(365, Number(args.days ?? 30) || 30))
    const from = new Date(cairoIsoDay(new Date()) + 'T12:00:00Z'); from.setUTCDate(from.getUTCDate() - days + 1)
    const fromDay = from.toISOString().slice(0, 10)
    const ops = await db.operation.findMany({ where: { businessId, status: 'SUCCEEDED', createdAt: { gte: startOfCairoDay(days - 1) } } })
    const sums: Record<string, number> = { sale: 0, purchase: 0, expense: 0, collection: 0, payment: 0 }
    for (const op of ops) {
      const p = readPayload(op.payload)
      if (op.type === 'cashbook' && (op.reversedByRef || String(p.occurredOn) < fromDay)) continue
      const type = reportedType(op.type, p)
      if (type in sums) sums[type] += payloadMoney(p)
    }
    const cash = await db.$transaction(tx => cashbookCash(tx, businessId))
    return [{ kind: 'kv', title: `المسجل فقط · آخر ${days} يوم`, rows: [
      { label: 'رصيد الخزنة المسجل دلوقتي', value: egp(cash) }, { label: 'بيع مسجل فقط (يشمل الآجل)', value: egp(sums.sale) },
      { label: 'شراء مسجل (يشمل الآجل)', value: egp(sums.purchase) }, { label: 'مصروفات مسجلة', value: egp(sums.expense) },
      { label: 'تحصيلات مسجلة', value: egp(sums.collection) }, { label: 'سداد مسجل', value: egp(sums.payment) },
    ] }, { kind: 'text', title: 'مش حساب أرباح', body: 'ده جزء الدفتر اللي اتسجل، مش إجمالي المبيعات أو الربح. فرق عدّ الخزنة غير مصنف. القرض والسحب والإيداع مش مبيعات.' }]
  }
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
      const [ops, items] = await Promise.all([
        db.operation.findMany({ where: { businessId, status: 'SUCCEEDED', createdAt: { gte: today } } }),
        db.item.findMany({ where: { businessId }, select: { id: true, name: true, costPrice: true } }),
      ])
      const sum = (type: string) =>
        ops.filter((o) => o.type === type).reduce((s, o) => s + payloadMoney(readPayload(o.payload)), 0)
      // «كسبت كام النهارده؟» — the summary used to answer with sales only, so
      // the owner had to do the subtraction in his head. Cost of goods sold is
      // priced from the catalog (same rule as get_profit_by_item); memberships
      // and collections carry no COGS.
      const costById = new Map<string, number>(items.map((i: { id: string; costPrice: number }) => [i.id, i.costPrice] as [string, number]))
      const costByName = new Map<string, number>(items.map((i: { name: string; costPrice: number }) => [i.name, i.costPrice] as [string, number]))
      let cogs = 0
      for (const op of ops) {
        if (op.type !== 'sale') continue
        const p = readPayload(op.payload) as {
          qty?: number
          itemId?: string
          itemName?: string
          lines?: { qty: number; name?: string; itemId?: string }[]
        }
        if (Array.isArray(p.lines) && p.lines.length > 0) {
          for (const l of p.lines) {
            const unitCost = (l.itemId ? costById.get(l.itemId) : undefined) ?? (l.name ? costByName.get(l.name) : undefined) ?? 0
            cogs += Math.round(Number(l.qty ?? 0) * unitCost)
          }
        } else if (p.qty) {
          const unitCost = (p.itemId ? costById.get(p.itemId) : undefined) ?? (p.itemName ? costByName.get(p.itemName) : undefined) ?? 0
          cogs += Math.round(Number(p.qty) * unitCost)
        }
      }
      const sales = sum('sale')
      const expenses = sum('expense')
      return [
        {
          kind: 'kv',
          title: 'ملخص اليوم',
          rows: [
            { label: 'مبيعات', value: egp(sales) },
            { label: 'مشتريات', value: egp(sum('purchase')) },
            { label: 'مصروفات', value: egp(expenses) },
            { label: 'تحصيلات', value: egp(sum('collection')) },
            { label: 'اشتراكات', value: egp(sum('membership')) },
            { label: 'تكلفة البضاعة المباعة', value: egp(cogs) },
            { label: 'صافي الربح', value: egp(sales - cogs - expenses) },
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
      // R58: امبارح is a full Cairo day on its own — «بعت كام امبارح؟» must NOT
      // return 30 days of sales (the old fallback) and NOT today.
      const isYesterday = args.yesterday === true
      const from = isYesterday ? startOfCairoDay(1) : days === 1 ? startOfCairoDay(0) : new Date(Date.now() - days * 86400000)
      const when = isYesterday ? { gte: from, lt: startOfCairoDay(0) } : { gte: from }
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
        where: { businessId, status: 'SUCCEEDED', type: { in: types }, createdAt: when },
      })
      const money = (payload: string): number => payloadMoney(readPayload(payload))
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
      const qty = metric === 'sales' ? matched.reduce((sum, o) => sum + payloadQty(readPayload(o.payload)), 0) : 0
      // R56: of the money we SOLD, how much is actually in hand vs. on account?
      // The owner manages exposure by this split every single day. Sales only
      // (memberships settle in full).
      let cashSold = 0
      let creditSold = 0
      if (metric === 'sales') {
        for (const o of matched) {
          if (o.type !== 'sale') continue
          const p = readPayload(o.payload)
          const t = Number(p.total ?? 0) || 0
          const paid = Math.min(Math.max(0, Number(p.paid ?? 0)), t)
          cashSold += paid
          creditSold += t - paid
        }
      }
      const period = isYesterday ? 'امبارح' : days === 1 ? 'النهارده' : days === 7 ? 'آخر ٧ أيام' : `آخر ${fmtQty(days)} يوم`
      return [
        {
          kind: 'kv',
          title: `${label}${subject ? ` — ${subject}` : ''} · ${period}`,
          rows: [
            { label: 'الإجمالي', value: egp(total) },
            ...(qty > 0 ? [{ label: 'الكمية', value: fmtQty(qty) }] : []),
            ...(metric === 'sales' && (cashSold > 0 || creditSold > 0)
              ? [
                  { label: 'كاش (في اليد)', value: egp(cashSold) },
                  { label: 'على الحساب (عند العملاء)', value: egp(creditSold) },
                ]
              : []),
            // R59: the planning number — what a NORMAL day looks like.
            ...(matched.length > 0 && days > 1 && total > 0
              ? [{ label: 'المتوسط اليومي', value: egp(Math.round(total / days)) }]
              : []),
            { label: 'عدد العمليات', value: fmtQty(matched.length) },
          ],
          ...(matched.length === 0
            ? { rows: [{ label: 'النتيجة', value: `مفيش ${label} مسجلة ${period}${subject ? ` ل${subject}` : ''}` }] }
            : {}),
        },
      ]
    }

    case 'get_financial_position': {
      // R55 — «فلوسي واقفين فين؟» — the owner's single snapshot of where the
      // money sits: cash + at the customers + on the shelves − owed to
      // suppliers = working capital. Same readers as get_cash_position and
      // get_stock_value so every screen adds the ledger the same way.
      const [cashEntries, customers, suppliers, items] = await Promise.all([
        db.cashEntry.findMany({ where: { businessId }, select: { direction: true, amount: true } }),
        db.customer.findMany({ where: { businessId }, select: { balance: true } }),
        db.supplier.findMany({ where: { businessId }, select: { balance: true } }),
        db.item.findMany({ where: { businessId } }),
      ])
      const cash =
        biz.openingCash + cashEntries.reduce((s, e) => s + (e.direction === 'in' ? e.amount : -e.amount), 0)
      const receivables = customers.reduce((s, c) => s + Math.max(0, c.balance), 0)
      const payables = suppliers.reduce((s, sp) => s + Math.max(0, sp.balance), 0)
      const stock = items.reduce((s, it) => s + it.stockQty * it.costPrice, 0)
      const net = cash + receivables + stock - payables
      return [
        {
          kind: 'kv',
          title: 'المركز المالي — فلوسي واقفين فين',
          rows: [
            { label: 'كاش في الخزنة', value: egp(cash) },
            { label: 'فلوسي عند العملاء', value: egp(receivables) },
            { label: 'بضاعة على الرف (تكلفة)', value: egp(stock) },
            { label: 'علينا للموردين', value: `- ${egp(payables)}` },
            { label: 'رأس المال العامل التقريبي', value: egp(net) },
          ],
        },
        {
          kind: 'text',
          title: 'ببساطة',
          body: `فلوسك دلوقتي: ${egp(cash)} كاش في الخزنة + ${egp(receivables)} عند العملاء + ${egp(stock)} بضاعة على الرف، ومعنا ${egp(payables)} عند الموردين. الصافي التقريبي ${egp(net)}.`,
        },
      ]
    }
    case 'get_stock_value': {
      // «المخزون ده مكلّفني كام؟» — the capital asleep on the shelves. The
      // owner asks this before every restock, and it must be exact: cost basis
      // and retail basis, never the same number twice.
      const items = await db.item.findMany({ where: { businessId } })
      const cost = items.reduce((s, it) => s + it.stockQty * it.costPrice, 0)
      const retail = items.reduce((s, it) => s + it.stockQty * it.sellPrice, 0)
      const low = items.filter((it) => it.stockQty <= it.lowStockThreshold).length
      return [
        {
          kind: 'kv',
          title: 'قيمة المخزون',
          rows: [
            { label: 'بسعر التكلفة', value: egp(cost) },
            { label: 'لو اتباع بسعر البيع', value: egp(retail) },
            { label: 'الربح المتوقع', value: egp(retail - cost) },
            { label: 'عدد الأصناف', value: fmtQty(items.length) },
            { label: 'أصناف ناقصة', value: fmtQty(low) },
          ],
        },
      ]
    }

    case 'get_top_items': {
      const days = Math.max(1, Math.min(365, Number(args.days ?? 30) || 30))
      const since = days === 1 ? startOfCairoDay(0) : new Date(Date.now() - days * 86400000)
      const ops = await db.operation.findMany({
        where: { businessId, status: 'SUCCEEDED', type: { in: ['sale', 'membership'] }, createdAt: { gte: since } },
      })
      // Some sales carry only `itemId` (older rows, and the owner's own quick
      // sales). Without resolving the id they all collapse into «عملية بيع» and
      // the ranking lies — so resolve ids → names in one query.
      const itemIds = new Set<string>()
      for (const o of ops) {
        const p = readPayload(o.payload)
        if (typeof p.itemId === 'string') itemIds.add(p.itemId)
      }
      const itemNames = new Map(
        itemIds.size > 0
          ? (await db.item.findMany({ where: { id: { in: [...itemIds] } }, select: { id: true, name: true } })).map((i) => [i.id, i.name] as const)
          : [],
      )
      const byName = new Map<string, { qty: number; money: number; count: number }>()
      for (const o of ops) {
        const p = readPayload(o.payload)
        const lines = linesOf(p)
        if (lines.length > 0) {
          for (const l of lines) {
            const cur = byName.get(l.name) ?? { qty: 0, money: 0, count: 0 }
            byName.set(l.name, { qty: cur.qty + l.qty, money: cur.money + l.money, count: cur.count + 1 })
          }
        } else {
          // a gym membership, or a one-line sale typed by the owner
          const name =
            String(p.itemName ?? itemNames.get(String(p.itemId ?? '')) ?? p.member ?? p.customer ?? '').trim() ||
            (String(p.plan ?? '') ? `اشتراك ${String(p.plan)}` : 'عملية بيع')
          const cur = byName.get(name) ?? { qty: 0, money: 0, count: 0 }
          byName.set(name, { qty: cur.qty + payloadQty(p), money: cur.money + payloadMoney(p), count: cur.count + 1 })
        }
      }
      const rows = [...byName.entries()].sort((a, b) => b[1].money - a[1].money).slice(0, 10)
      const period = days === 1 ? 'النهارده' : days === 7 ? 'آخر ٧ أيام' : `آخر ${fmtQty(days)} يوم`
      if (rows.length === 0) {
        return [{ kind: 'kv', title: `أعلى الأصناف مبيعًا · ${period}`, rows: [{ label: 'النتيجة', value: 'مفيش مبيعات مسجلة في الفترة دي' }] }]
      }
      const total = rows.reduce((s, [, v]) => s + v.money, 0)
      return [
        {
          kind: 'table',
          title: `أعلى الأصناف مبيعًا · ${period}`,
          columns: [
            { key: 'name', label: 'الصنف' },
            { key: 'qty', label: 'الكمية' },
            { key: 'money', label: 'الإيراد' },
            { key: 'count', label: 'مرات البيع' },
          ],
          rows: rows.map(([name, v]) => ({ name, qty: fmtQty(v.qty), money: egp(v.money), count: fmtQty(v.count) })),
          footer: [
            { label: 'إجمالي أعلى ١٠', value: egp(total) },
            { label: 'عدد الأصناف', value: fmtQty(byName.size) },
          ],
        },
      ]
    }

    case 'get_dead_stock': {
      // Money that stopped moving. A shelf full of stock nobody buys looks
      // like an asset on paper and like cash burned in the drawer.
      const days = Math.max(7, Math.min(365, Number(args.days ?? 30) || 30))
      const since = new Date(Date.now() - days * 86400000)
      const [items, ops] = await Promise.all([
        db.item.findMany({ where: { businessId, stockQty: { gt: 0 } } }),
        db.operation.findMany({
          where: { businessId, status: 'SUCCEEDED', type: 'sale', createdAt: { gte: since } },
          select: { payload: true },
        }),
      ])
      const sold = new Set<string>()
      const soldIds = new Set<string>()
      for (const o of ops) {
        const p = readPayload(o.payload)
        for (const l of linesOf(p)) sold.add(l.name)
        if (typeof p.itemId === 'string') soldIds.add(p.itemId)
      }
      const dead = items
        .filter((it) => !sold.has(it.name) && !soldIds.has(it.id))
        .map((it) => ({ it, value: it.stockQty * it.costPrice }))
        .sort((a, b) => b.value - a.value)
      if (dead.length === 0) {
        return [
          {
            kind: 'kv',
            title: `البضاعة الراكدة · آخر ${fmtQty(days)} يوم`,
            rows: [{ label: 'النتيجة', value: 'كل صنف عندك اتحرك في الفترة دي — مفيش رأس مال راكد' }],
          },
        ]
      }
      const capital = dead.reduce((s, d) => s + d.value, 0)
      return [
        {
          kind: 'table',
          title: `البضاعة اللي مش بتتحرك · آخر ${fmtQty(days)} يوم`,
          columns: [
            { key: 'name', label: 'الصنف' },
            { key: 'stock', label: 'الرصيد' },
            { key: 'value', label: 'رأس المال المحبوس' },
          ],
          rows: dead.slice(0, 12).map(({ it, value }) => ({ name: it.name, stock: fmtQty(it.stockQty, arUnit(it.unit)), value: egp(value) })),
          footer: [
            { label: 'إجمالي المحبوس', value: egp(capital) },
            { label: 'عدد الأصناف', value: fmtQty(dead.length) },
          ],
        },
      ]
    }

    case 'get_customer_ranking': {
      // «مين أفضل عميل عندي؟» — a relationship question answered with numbers.
      const since = new Date(Date.now() - 90 * 86400000)
      const [ops, customers] = await Promise.all([
        db.operation.findMany({
          where: { businessId, status: 'SUCCEEDED', type: { in: ['sale', 'membership', 'collection'] }, createdAt: { gte: since } },
          select: { type: true, payload: true },
        }),
        db.customer.findMany({ where: { businessId }, select: { name: true, balance: true } }),
      ])
      const balances = new Map(customers.map((c) => [c.name, c.balance]))
      // collections store `customer`, newer sales store `customerId`
      const ids = new Set<string>()
      for (const o of ops) {
        const p = readPayload(o.payload)
        if (typeof p.customerId === 'string') ids.add(p.customerId)
      }
      const namesById = new Map(
        ids.size > 0
          ? (await db.customer.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true } })).map((c) => [c.id, c.name] as const)
          : [],
      )
      const book = new Map<string, { bought: number; collected: number; count: number }>()
      for (const o of ops) {
        const p = readPayload(o.payload)
        const name = String(p.customer ?? p.member ?? namesById.get(String(p.customerId ?? '')) ?? '').trim()
        if (!name) continue
        const cur = book.get(name) ?? { bought: 0, collected: 0, count: 0 }
        if (o.type === 'collection') cur.collected += payloadMoney(p)
        else cur.bought += payloadMoney(p)
        cur.count += 1
        book.set(name, cur)
      }
      const rows = [...book.entries()].sort((a, b) => b[1].bought - a[1].bought).slice(0, 10)
      if (rows.length === 0) {
        return [{ kind: 'kv', title: 'أفضل العملاء · آخر ٩٠ يوم', rows: [{ label: 'النتيجة', value: 'مفيش عمليات مسجلة باسم عميل في الفترة دي' }] }]
      }
      return [
        {
          kind: 'table',
          title: 'أفضل العملاء · آخر ٩٠ يوم',
          columns: [
            { key: 'name', label: 'العميل' },
            { key: 'bought', label: 'شرا' },
            { key: 'collected', label: 'تحصيل' },
            { key: 'balance', label: 'عليه دلوقتي' },
            { key: 'count', label: 'عمليات' },
          ],
          rows: rows.map(([name, v]) => ({
            name,
            bought: v.bought > 0 ? egp(v.bought) : '—',
            collected: v.collected > 0 ? egp(v.collected) : '—',
            balance: (balances.get(name) ?? 0) > 0 ? egp(balances.get(name) ?? 0) : '—',
            count: fmtQty(v.count),
          })),
          footer: [{ label: 'عدد العملاء النشطين', value: fmtQty(book.size) }],
        },
      ]
    }

    case 'get_staff_performance': {
      const since = new Date(Date.now() - 30 * 86400000)
      const [ops, users] = await Promise.all([
        db.operation.findMany({
          where: { businessId, status: 'SUCCEEDED', createdAt: { gte: since } },
          select: { userId: true, type: true, payload: true, createdAt: true },
        }),
        db.user.findMany({ where: { businessId }, select: { id: true, name: true, role: true } }),
      ])
      const book = new Map<string, { count: number; sold: number; last: Date }>()
      for (const o of ops) {
        const cur = book.get(o.userId) ?? { count: 0, sold: 0, last: o.createdAt }
        cur.count += 1
        if (o.type === 'sale' || o.type === 'membership' || o.type === 'collection') cur.sold += payloadMoney(readPayload(o.payload))
        if (o.createdAt > cur.last) cur.last = o.createdAt
        book.set(o.userId, cur)
      }
      if (book.size === 0) {
        return [{ kind: 'kv', title: 'أداء الفريق · آخر ٣٠ يوم', rows: [{ label: 'النتيجة', value: 'مفيش عمليات مكتملة في الفترة دي' }] }]
      }
      const rows = users
        .filter((u) => book.has(u.id))
        .map((u) => ({ u, v: book.get(u.id)! }))
        .sort((a, b) => b.v.sold - a.v.sold)
      return [
        {
          kind: 'table',
          title: 'أداء الفريق · آخر ٣٠ يوم',
          columns: [
            { key: 'name', label: 'الموظف' },
            { key: 'role', label: 'الدور' },
            { key: 'count', label: 'عمليات' },
            { key: 'sold', label: 'مبيعات وتحصيل' },
            { key: 'last', label: 'آخر عملية' },
          ],
          rows: rows.map(({ u, v }) => ({
            name: u.name,
            role: u.role === 'owner' ? 'صاحب' : u.role === 'manager' ? 'مشرف' : 'كاشير',
            count: fmtQty(v.count),
            sold: egp(v.sold),
            last: arDate(v.last),
          })),
          footer: [{ label: 'إجمالي العمليات', value: fmtQty(ops.length) }],
        },
      ]
    }

    case 'get_reorder_list': {
      // «أشتري إيه؟» — the question that turns a stock report into a purchase
      // order. Quantity targets 2× the alert threshold, priced at cost.
      const items = await db.item.findMany({ where: { businessId } })
      const need = items
        .filter((it) => it.lowStockThreshold > 0 && it.stockQty <= it.lowStockThreshold)
        .map((it) => {
          const qty = Math.max(1, it.lowStockThreshold * 2 - it.stockQty)
          return { it, qty, cost: qty * it.costPrice }
        })
        .sort((a, b) => b.cost - a.cost)
      if (need.length === 0) {
        return [{ kind: 'kv', title: 'ورقة الطلب', rows: [{ label: 'النتيجة', value: 'مفيش صنف محتاج طلب دلوقتي — كله فوق حد التنبيه' }] }]
      }
      const total = need.reduce((s, r) => s + r.cost, 0)
      return [
        {
          kind: 'table',
          title: 'ورقة الطلب — اشتري إيه',
          columns: [
            { key: 'name', label: 'الصنف' },
            { key: 'stock', label: 'الرصيد' },
            { key: 'qty', label: 'اطلب' },
            { key: 'cost', label: 'التكلفة التقديرية' },
          ],
          rows: need.slice(0, 12).map(({ it, qty, cost }) => ({
            name: it.name,
            stock: fmtQty(it.stockQty, arUnit(it.unit)),
            qty: fmtQty(qty, arUnit(it.unit)),
            cost: cost > 0 ? egp(cost) : '—',
          })),
          footer: [
            { label: 'الإجمالي التقديري', value: egp(total) },
            { label: 'عدد الأصناف', value: fmtQty(need.length) },
          ],
        },
      ]
    }

    case 'get_profit_by_item': {
      // Revenue per item is nice; PROFIT per item is the decision.
      const days = Math.max(1, Math.min(365, Number(args.days ?? 30) || 30))
      const since = days === 1 ? startOfCairoDay(0) : new Date(Date.now() - days * 86400000)
      const [ops, items] = await Promise.all([
        db.operation.findMany({ where: { businessId, status: 'SUCCEEDED', type: 'sale', createdAt: { gte: since } }, select: { payload: true } }),
        db.item.findMany({ where: { businessId }, select: { name: true, costPrice: true } }),
      ])
      const costOf = new Map(items.map((i) => [i.name, i.costPrice]))
      const book = new Map<string, { qty: number; revenue: number }>()
      for (const o of ops) {
        for (const l of linesOf(readPayload(o.payload))) {
          const cur = book.get(l.name) ?? { qty: 0, revenue: 0 }
          book.set(l.name, { qty: cur.qty + l.qty, revenue: cur.revenue + l.money })
        }
      }
      const rows = [...book.entries()]
        .map(([name, v]) => {
          const cost = (costOf.get(name) ?? 0) * v.qty
          const profit = v.revenue - cost
          return { name, qty: v.qty, revenue: v.revenue, cost, profit, pct: v.revenue > 0 ? (profit / v.revenue) * 100 : 0 }
        })
        .sort((a, b) => b.profit - a.profit)
        .slice(0, 10)
      const period = days === 1 ? 'النهارده' : days === 7 ? 'آخر ٧ أيام' : `آخر ${fmtQty(days)} يوم`
      if (rows.length === 0) {
        return [{ kind: 'kv', title: `الربح من كل صنف · ${period}`, rows: [{ label: 'النتيجة', value: 'مفيش مبيعات في الفترة دي' }] }]
      }
      const totalProfit = rows.reduce((s, r) => s + r.profit, 0)
      return [
        {
          kind: 'table',
          title: `الربح من كل صنف · ${period}`,
          columns: [
            { key: 'name', label: 'الصنف' },
            { key: 'qty', label: 'اتباع' },
            { key: 'revenue', label: 'الإيراد' },
            { key: 'profit', label: 'الربح' },
            { key: 'pct', label: 'الهامش' },
          ],
          rows: rows.map((r) => ({
            name: r.name,
            qty: fmtQty(r.qty),
            revenue: egp(r.revenue),
            profit: egp(r.profit),
            pct: `${fmtQty(Math.round(r.pct))}٪`,
          })),
          footer: [{ label: 'إجمالي ربح أعلى ١٠', value: egp(totalProfit) }],
        },
      ]
    }

    case 'get_price_check': {
      // Selling below cost is silent, permanent loss. The owner never sees it
      // in a sales report — only in the cash drawer at the end of the month.
      const items = await db.item.findMany({ where: { businessId, stockQty: { gt: 0 }, costPrice: { gt: 0 } } })
      const bad = items
        .map((it) => ({ it, margin: it.sellPrice - it.costPrice, pct: it.costPrice > 0 ? ((it.sellPrice - it.costPrice) / it.costPrice) * 100 : 0 }))
        .filter((x) => x.pct < 15)
        .sort((a, b) => a.pct - b.pct)
      if (bad.length === 0) {
        return [
          {
            kind: 'kv',
            title: 'فحص الأسعار',
            rows: [{ label: 'النتيجة', value: 'كل الأصناف هامشها ١٥٪ أو أكتر — مفيش بيع بخسارة' }],
          },
        ]
      }
      const losing = bad.filter((x) => x.margin <= 0).length
      return [
        {
          kind: 'table',
          title: 'أصناف هامشها ضعيف أو بتتبيع بخسارة',
          columns: [
            { key: 'name', label: 'الصنف' },
            { key: 'cost', label: 'التكلفة' },
            { key: 'sell', label: 'البيع' },
            { key: 'margin', label: 'الهامش' },
          ],
          rows: bad.slice(0, 12).map(({ it, margin, pct }) => ({
            name: it.name,
            cost: egp(it.costPrice),
            sell: egp(it.sellPrice),
            margin: margin <= 0 ? `${egp(margin)} (خسارة)` : `${egp(margin)} · ${fmtQty(Math.round(pct))}٪`,
          })),
          footer: [
            { label: 'أصناف بخسارة', value: fmtQty(losing) },
            { label: 'تحت ١٥٪', value: fmtQty(bad.length) },
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
          title: 'المديونيات — العملاء اللي لسه ليه فلوس عندنا',
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
      const query = String(args.query ?? args.name ?? '').trim()
      const items = await db.item.findMany({ where: { businessId }, orderBy: { name: 'asc' } })
      // «بكام الزيت؟» must find «زيت عافية 800 مل». A raw `includes` missed it:
      // the owner says the material (زيت) with the definite article, the catalog
      // stores it inside a brand + size name. Match token-by-token after Arabic
      // normalization, drop «ال», and rank by how much of the query matched.
      const stripAl = (w: string) => (w.length > 3 && w.startsWith('ال') ? w.slice(2) : w)
      const tokens = (x: string) =>
        normalizeAr(x)
          .split(/[^0-9a-z\u0600-\u06ff]+/)
          .map(stripAl)
          .filter((w) => w.length >= 2)
      const q = normalizeAr(query)
      const qTokens = query ? tokens(query) : []
      const scored = query
        ? items
            .map((it) => {
              const hay = normalizeAr(`${it.name} ${it.aliases}`)
              const hayTokens = tokens(`${it.name} ${it.aliases}`)
              if (hay.includes(q) || q.includes(normalizeAr(it.name))) return { it, score: 1000 }
              let score = 0
              for (const t of qTokens) {
                const hit = hayTokens.some((h) => h.includes(t) || t.includes(h))
                if (hit) score += t.length
              }
              return { it, score }
            })
            .filter((x) => x.score > 0)
            .sort((a, b) => b.score - a.score || a.it.name.localeCompare(b.it.name))
            .slice(0, 12)
            .map((x) => x.it)
        : items.slice(0, 8)
      const matched = scored
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
      // «الفاتورة WKL 1032 دي كانت فيها إيه؟» — ref normalization first:
      // Arabic digits, spaces, underscores, missing dash, all tolerated.
      const rawRef = String(args.ref ?? '')
      const clean = toWesternDigits(rawRef).replace(/[\s_-]+/g, '').toUpperCase()
      let op: Operation | null = null
      if (clean) {
        op = await db.operation.findFirst({ where: { businessId, ref: clean } })
        if (!op) {
          // Digit-by-digit match, the same contract as /api/search:
          // «1032» or «WKL1032» finds WKL-1032. Prefer the exact WKL-<digits>.
          const digits = clean.replace(/\D/g, '')
          if (digits.length >= 3) {
            const cands = await db.operation.findMany({
              where: { businessId, ref: { contains: digits } },
              orderBy: { createdAt: 'desc' },
              take: 5,
            })
            const exact = cands.find((c) => c.ref === `WKL-${digits}`)
            if (exact) op = exact
            else if (cands.length === 1) op = cands[0]
            else if (cands.length > 1) {
              const list = cands.slice(0, 3).map((c) => `${c.ref} (${TYPE_AR[c.type] ?? c.type})`).join(' · ')
              return [
                {
                  kind: 'kv',
                  title: `الرقم ${digits}`,
                  rows: [{ label: 'النتيجة', value: `أكتر من عملية فيها الأرقام دي: ${list} — قولّي الرقم كله (زي WKL-1032)` }],
                },
              ]
            }
          }
        }
      }
      if (!op) {
        return [
          {
            kind: 'kv',
            title: `العملية ${rawRef}`,
            rows: [{ label: 'النتيجة', value: `ملقيتش عملية بالرقم ${rawRef || 'ده'}` }],
          },
        ]
      }
      const cards: ResultCardDTO[] = []
      // The real receipt: line items + total, straight from the payload.
      const lines = opLines(op.payload)
      if (lines.length > 0) {
        const items = await db.item.findMany({ where: { businessId } })
        const nameOf = new Map(items.map((i) => [i.id, i.name]))
        const total = lines.reduce((s, l) => s + l.total, 0)
        cards.push({
          kind: 'table',
          title: `فيها إيه — ${op.ref}`,
          columns: [
            { key: 'name', label: 'الصنف' },
            { key: 'qty', label: 'الكمية', align: 'end' },
            { key: 'total', label: 'المبلغ', align: 'end' },
          ],
          rows: lines.map((l) => ({ name: nameOf.get(l.itemId) ?? 'صنف', qty: fmtQty(l.qty), total: egp(l.total) })),
          footer: [{ label: 'الإجمالي', value: egp(total) }],
        })
      }
      const p = readPayload(op.payload)
      cards.push({
        kind: 'kv',
        title: `العملية ${op.ref}`,
        rows: [
          { label: 'النوع', value: TYPE_AR[op.type] ?? op.type },
          { label: 'الحالة', value: STATUS_AR[op.status] ?? op.status },
          ...(String(p.customerName ?? p.supplierName ?? '') ? [{ label: 'المعاملة مع', value: String(p.customerName ?? p.supplierName) }] : []),
          { label: 'الإجمالي', value: egp(Number(p.total ?? p.amount ?? 0) || lines.reduce((s, l) => s + l.total, 0)) },
          { label: 'الملخص', value: op.summary },
          { label: 'وقت التنفيذ', value: op.executedAt ? arTime(op.executedAt) : 'لسه' },
        ],
      })
      return cards
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
    case 'get_supplier_history': {
      // R52 — the payables mirror of get_customer_history: «كام علينا لمحمد
      // تاجر الجملة؟» must answer with THAT supplier's account, not the whole
      // list and not the generic «النت تقيل» dead-end.
      const name = String(args.name ?? '').trim()
      const suppliers = await db.supplier.findMany({ where: { businessId } })
      const flat = (x: string) => normalizeAr(x).replace(/\s+/g, ' ').trim()
      const wordCount = (x: string) => flat(x).split(' ').filter(Boolean).length
      // Same disambiguation contract as the customer file: an exact name wins,
      // a lone shared first word never silently lands on someone else's debt.
      const exact = suppliers.find((s) => flat(s.name) === flat(name))
      const strong = suppliers
        .filter((s) => flat(s.name).includes(flat(name)) && (wordCount(name) >= 2 || flat(name).length >= 6))
        .filter((s) => !isQuestionWord(name))
      const partial = exact ?? (strong.length === 1 ? strong[0] : undefined)
      if (!partial) {
        const near = suppliers.filter((s) => flat(s.name).includes(flat(name))).slice(0, 3)
        return [
          {
            kind: 'kv',
            title: 'ملف المورد',
            rows: [
              { label: 'النتيجة', value: `ملقيتش مورد بالاسم «${name}» — مفيش مورد بالاسم ده في السجل` },
              ...(near.length > 0
                ? [{ label: 'قصدت؟', value: `${near.map((s) => `${s.name} (علينا ${egp(s.balance)})`).join(' · ')} — اكتب الاسم زي ما هو في السجل` }]
                : [{ label: 'الخطوة', value: `قولّي «جبت من ${name}» وأنا أسجله في السجل` }]),
            ],
          },
        ]
      }
      const found = partial
      const ops = await db.operation.findMany({
        where: { businessId, status: 'SUCCEEDED', OR: [{ summary: { contains: found.name } }, { type: { in: ['payment', 'purchase'] } }] },
        orderBy: { createdAt: 'desc' },
        take: 60,
      })
      const mine = ops.filter((op) => op.summary.includes(found.name) || opLines(op.payload).length > 0)
      const payments = mine.filter((op) => op.type === 'payment')
      const avgPayment =
        payments.length > 0 ? Math.round(payments.reduce((s2, o) => s2 + opAmount(o.payload), 0) / payments.length) : 0
      const addOp = mine.find((op) => op.type === 'supplier_add')
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
        payments.length >= 2
          ? Math.round((payments[0].createdAt.getTime() - payments[payments.length - 1].createdAt.getTime()) / 86400000 / (payments.length - 1))
          : null
      return [
        {
          kind: 'kv',
          title: `ملف ${found.name}`,
          rows: [
            { label: 'المستحق له (رصيدنا عليه)', value: egp(found.balance) },
            { label: 'آخر سداد', value: payments[0] ? `${egp(opAmount(payments[0].payload))} — ${arDate(payments[0].createdAt)}` : 'مفيش' },
            { label: 'متوسط السداد', value: avgPayment > 0 ? egp(avgPayment) : '—' },
            { label: 'بنسدد كل', value: gapDays != null ? `${gapDays} يوم تقريبًا` : 'مفيش بيانات كفاية' },
            ...(sinceLabel ? [{ label: 'الحساب اتفتح من', value: sinceLabel }] : []),
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

    case 'get_contact_info': {
      // R54 — «رقم تليفون أم حسن؟» / «اتصل بـ محمد تاجر الجملة». One number,
      // plus the balance as context (a call is usually to collect or to order).
      // Customers first, suppliers second; the same exact > strong-partial
      // contract as the two history files — never one person's number for
      // another person.
      const name = String(args.name ?? '').trim()
      const flat = (x: string) => normalizeAr(x).replace(/\s+/g, ' ').trim()
      const wordCount = (x: string) => flat(x).split(' ').filter(Boolean).length
      const [customers, suppliers] = await Promise.all([
        db.customer.findMany({ where: { businessId } }),
        db.supplier.findMany({ where: { businessId } }),
      ])
      const pick = <T extends { name: string }>(list: T[]): T | undefined => {
        const exact = list.find((c) => flat(c.name) === flat(name))
        if (exact) return exact
        if (!name || isQuestionWord(name)) return undefined
        const strong = list.filter(
          (c) => flat(c.name).includes(flat(name)) && (wordCount(name) >= 2 || flat(name).length >= 6),
        )
        return strong.length === 1 ? strong[0] : undefined
      }
      const cust = pick(customers)
      const sup = cust ? undefined : pick(suppliers)
      const found = (cust ?? sup) as (Customer & { phone: string | null; balance: number }) | undefined
      if (!found) {
        const near = [...customers.map((c) => c.name), ...suppliers.map((s2) => s2.name)]
          .filter((n) => flat(n).includes(flat(name)))
          .slice(0, 3)
        return [
          {
            kind: 'kv',
            title: 'رقم التليفون',
            rows: [
              { label: 'النتيجة', value: `ملقيتش «${name}» في سجل العملاء ولا الموردين` },
              ...(near.length > 0
                ? [{ label: 'قصدت؟', value: near.join(' · ') }]
                : [{ label: 'الخطوة', value: `قولّي «ضيف ${name}» وبرضه رقم تليفونه وأنا أسجله` }]),
            ],
          },
        ]
      }
      const isCust = cust != null
      return [
        {
          kind: 'kv',
          title: `تليفون ${found.name}`,
          rows: [
            { label: 'النوع', value: isCust ? 'عميل' : 'مورد' },
            ...(found.phone
              ? [{ label: 'التليفون', value: found.phone }]
              : [{ label: 'التليفون', value: 'مش مسجل في السجل — قولّي رقمه وأنا أضيفة' }]),
            { label: 'الرصيد', value: isCust ? `عليه ${egp(found.balance)}` : `رصيدنا عليه ${egp(found.balance)}` },
          ],
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

    case 'cli_inspect_app': {
      const appName = String(args.appName ?? args.name ?? args.query ?? 'برنامج الحسابات')
      const res = await inspectDesktopApplication(appName, businessId)
      return res.cards
    }

    case 'cli_sync_desktop_data': {
      const appName = String(args.appName ?? args.name ?? 'البرنامج الخارجي')
      const res = await inspectDesktopApplication(appName, businessId)
      return res.cards
    }

    case 'cli_harness_install': {
      // R46 Mode 2 — the REAL CLI-Anything (github.com/HKUDS/CLI-Anything) integrated —
      // not copied, not imitated: with the owner's EXPLICIT permission we run the real
      // tooling on the owner's machine (CLI-Hub prebuilt or the 7-phase generation
      // pipeline), parse the produced SKILL.md, and register the executable surface
      // so cli_control_app drives the owner's actual program from then on.
      const harnessApp = String(args.app ?? '').trim()
      if (!harnessApp) {
        return [{ kind: 'text', title: 'بنى هارنس CLI', body: 'قل ما تقولي بسم البرنامج (مثل: daftra أو excel).' }]
      }
      const confirmed = args.confirmed === true
      const py = await pythonProbe()
      if (!confirmed) {
        const hub = py.ok ? await cliHubProbe() : null
        return [{ kind: 'kv', title: `إذن البنى: هارنس «${harnessApp}»`, rows: [
          { label: 'الأداة', value: 'CLI-Anything الحقيقي (مش نسخة منه)' },
          { label: 'البيئة', value: py.ok ? py.detail : 'مفيش بيئان على الجهاز', tone: py.ok ? 'good' : 'bad' },
          { label: 'CLI-Hub', value: hub ? hub.detail : 'لم يتثتتت', tone: hub?.ok ? 'good' : 'neutral' },
          { label: 'الخطوات', value: 'إثبات CLI-Anything على جهازك → حرك هارنس تنفذ أوامر برنامجك → تسجيله في الدب → أنا أشغله مباشرة' },
        ] }]
      }
      if (!py.ok) {
        return [{ kind: 'text', title: 'بنى هارنس CLI', body: `مش قدر اتشغل: ${py.detail}.\nCLI-Anything بيعمل من Python — ثبّته أول في جهاز المستشري وبعدك \u0623رجع.` }]
      }
      const owner = (await db.user.findFirst({ where: { businessId, role: 'owner' } })) ?? (await db.user.findFirst({ where: { businessId } }))
      const ownerUserId = owner?.id ?? businessId
      const sourcePath = args.source ? String(args.source) : undefined
      if (sourcePath) {
        const r = await generatePipeline(harnessApp, sourcePath)
        if (!r.ok) {
          return [{ kind: 'text', title: `بنى هارنس «${harnessApp}»`, body: r.detail }]
        }
        const skillMd = locateSkillMd(`cli-anything-${harnessApp}`)
        if (!skillMd) {
          return [{ kind: 'text', title: `بنى هارنس «${harnessApp}»`, body: `\u0627لتنفيز كامل \u0628نجاح \u0645باشرة \u0645ا \u0644قيت \u0644دي \u0645لف SKILL.md \u2014 \u0639ري \u0627لنتائج: ${r.detail.slice(0, 400)}` }]
        }
        const rawSkill = await readFileBounded(skillMd)
        const skill = parseSkillMd(rawSkill, harnessApp)
        const reg = await registerHarness({ businessId, userId: ownerUserId, app: harnessApp, display: harnessApp, source: 'generated', skill })
        return [{ kind: 'text', title: `مبي: هارنس «${harnessApp}» اتبنى من \u0627لمصدر`, body: `${reg.detail}\n\u0627ل\u0623وامر \u0627لمتحددة: ${skill.commands.map((c) => c.command).join(' \u00b7 ') || '\u2014'}` }]
      }
      const search = await hubSearch(harnessApp)
      if (!search.ok) {
        return [{ kind: 'text', title: `بنى هارنس «${harnessApp}»`, body: `${search.detail}.\n\u0627لحل: \u0645ش \u0641ي CLI-Hub \u0647ارنس \u062cاهز \u0644ه \u2014 \u064aمكن \u0627لبنى \u0645ن \u0627لمصدر \u0628استخدام \u0627ل\u200b pipeline \u0627ل\u200b 7-phases: \u0627قرب \u0645سار \u0643ود \u0627لبرنامج (source) \u0648\u0623عيد \u0628\u060c confirmed=true.` }]
      }
      const inst = await hubInstall(search.slug ?? `cli-anything-${harnessApp}`)
      if (!inst.ok || !inst.skillMdPath) {
        return [{ kind: 'text', title: `بنى \u0647ارنس \u00ab${harnessApp}\u00bb`, body: `\u0627لتثقيق \u0645ن \u0627ل\u200b hub \u0641شل: ${inst.detail}` }]
      }
      const rawSkill2 = await readFileBounded(inst.skillMdPath)
      const skill2 = parseSkillMd(rawSkill2, harnessApp)
      const reg2 = await registerHarness({ businessId, userId: ownerUserId, app: harnessApp, display: harnessApp, source: 'prebuilt', skill: skill2 })
      return [{ kind: 'text', title: `\u0645بي: \u0647ارنس \u00ab${harnessApp}\u00bb \u0645ن \u0627ل\u200b CLI-Hub \u0627ل\u062d\u0642ي\u0642ي`, body: `${reg2.detail}\n\u0627ل\u0623\u0648\u0627\u0645\u0631 \u0627لم\u062a\u062d\u062f\u062f\u0629: ${skill2.commands.map((c) => c.command).join(' \u00b7 ') || '\u2014'}\n\u0627نت \u062fي \u0623\u0634\u0648\u0641 \u0623\u0648\u0627\u0645\u0631 \u0627ل\u0628\u0631\u0646\u0627\u0645\u062c \u0645\u0628\u0627\u0634\u0631\u0629 \u0639\u0628\u0631 cli_control_app.` }]
    }

        case 'cli_control_app': {
      // R45 (CLI-Anything merge): drive an app through its CLI surface.
      // Excel is a REAL engine (COM on Windows / CSV anywhere); other apps
      // stay fail-closed with an honest status — never synthetic data.
      const appName = String(args.app ?? args.appName ?? 'excel')
      const res = await executeBridgedTool({
        businessId,
        appName,
        command: String(args.command ?? 'list-recent'),
        args: {
          file: args.file ?? args.path,
          sheet: args.sheet,
          range: args.range,
          value: args.value ?? args.text,
          maxRows: args.maxRows,
        },
      })
      return res.cards
    }

    case 'cli_list_desktop_apps': {
      const apps = await scanRunningApplications()
      return [
        {
          kind: 'table',
          title: 'تشخيص بيئة السيرفر فقط — ليس جهاز العميل',
          columns: [
            { key: 'name', label: 'البرنامج' },
            { key: 'category', label: 'النوع' },
            { key: 'status', label: 'حالة التسخير والربط' },
            { key: 'memory', label: 'استهلاك الذاكرة' },
          ],
          rows: apps.slice(0, 10).map((a) => ({
            name: a.name,
            category: a.category === 'accounting' ? 'برنامج محاسبة' : a.category === 'pos' ? 'نظام كاشير ومبيعات' : a.category === 'spreadsheet' ? 'جداول إكسل' : a.category === 'database' ? 'قاعدة بيانات' : 'تطبيق سطح مكتب',
            status: a.hasCliHarness ? 'موصل موثّق' : 'غير متصل — ملف تعريفي فقط',
            memory: a.memoryUsage || '—',
          })),
          footer: [{ label: 'إجمالي التطبيقات المرصودة', value: `${apps.length} برامج` }],
        },
      ]
    }

    default:
      return []
  }
}
