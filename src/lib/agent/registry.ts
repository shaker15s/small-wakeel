// وكيل — AGENT TOOL REGISTRY (العيون والأيدي اللي العقل بيشوف ويمسك بيها الشغل).
//
// This is the «4 ERP systems as tools» layer from the research PDF: the whole
// domain (finance / inventory / parties / operations / memory) is exposed to
// the MODEL as typed tools the model itself chooses between — DeepSeek-style
// tool calling, emulated in JSON so it works on ANY provider (builtin z-ai or
// external OpenAI-compatible).
//
// Split output contract (PDF: Structured Split Tool Results):
//   - `details` (ResultCardDTO[]) → goes straight to the UI (cards/tables).
//   - `output` (compact text)     → goes back to the MODEL to keep thinking.

import type { ResultCardDTO } from '@/lib/types'

export interface AgentToolCall {
  tool: string
  args: Record<string, unknown>
}

/** Write tools the model can call — mapped to OpType by the harness resolver. */
export const WRITE_TOOL_MAP: Record<string, string> = {
  record_sale: 'sale',
  record_purchase: 'purchase',
  record_collection: 'collection',
  record_payment: 'payment',
  record_expense: 'expense',
  register_member: 'membership',
  record_attendance: 'attendance',
}

export const MEMORY_TOOLS: ReadonlySet<string> = new Set(['memory_save', 'memory_forget'])

export const AGENT_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  'get_activity_history',
  'get_cash_position',
  'get_daily_summary',
  'get_item_stock',
  'get_member_status',
  'get_supplier_balance',
  'get_transaction_status',
  'list_expiring',
  'list_low_stock',
  'list_payables',
  'list_receivables',
  'search_catalog',
  // R28 superpowers (read-only, deterministic SQL)
  'get_profit_margin',
  'forecast_stockout',
  'get_customer_history',
  'compare_periods',
  'expense_breakdown',
  // «بعت كام لبن الشهر ده؟ / حصلت كام من أم حسن؟» — period aggregates
  'get_period_totals',
  // R36: the ledger questions an owner asks every week, answered without a model
  'get_stock_value',
  'get_top_items',
  'get_dead_stock',
  'get_customer_ranking',
  'get_staff_performance',
  'get_price_check',
  'get_reorder_list',
  'get_profit_by_item',
  // R29 (chat→world): the agent can look OUTSIDE the ledger and ADVISE
  'search_web',
  'business_advice',
  // R28 orchestration: one call that runs a whole read-only plan (PTC-lite)
  'run_plan',
  'deep_dive',
  'record_sale',
  'record_purchase',
  'record_collection',
  'record_payment',
  'record_expense',
  'register_member',
  'record_attendance',
  'memory_save',
  'memory_forget',
  // R18 brain tools
  'calculate',
  'schedule_task',
  'set_persona',
])

/** Arabic label shown in thinking steps for each tool. */
export const TOOL_STEP_LABEL: Record<string, string> = {
  get_activity_history: 'آخر الحركات',
  get_cash_position: 'وضع الخزنة',
  get_daily_summary: 'ملخص اليوم',
  get_item_stock: 'رصيد صنف',
  get_member_status: 'حالة عضو',
  get_supplier_balance: 'رصيد مورد',
  get_transaction_status: 'حالة عملية',
  list_expiring: 'الصلاحيات القريبة',
  list_low_stock: 'النواقص',
  list_payables: 'مستحقات الموردين',
  list_receivables: 'المديونيات',
  search_catalog: 'بحث في الكتالوج',
  record_sale: 'مسودة بيع',
  record_purchase: 'مسودة شرا',
  record_collection: 'مسودة تحصيل',
  record_payment: 'مسودة سداد',
  record_expense: 'مسودة مصروف',
  register_member: 'مسودة اشتراك',
  record_attendance: 'تسجيل حضور',
  memory_save: 'حفظ في الذاكرة',
  memory_forget: 'مسح من الذاكرة',
  get_profit_margin: 'حساب الربح',
  forecast_stockout: 'توقّع النقص',
  get_customer_history: 'ملف العميل',
  compare_periods: 'مقارنة الفترات',
  expense_breakdown: 'تفصيل المصروفات',
  search_web: 'بحث في الويب',
  business_advice: 'قراءة شغلك',
  run_plan: 'خطة متعددة الخطوات',
  deep_dive: 'تحقيق عميق',
  calculate: 'الحاسبة',
  schedule_task: 'مهمة مجدولة',
  set_persona: 'ضبط النبرة',
}

/**
 * Parse the model's JSON tool-call response (emulation protocol).
 * Returns null when the response is NOT a tool call (i.e. it is the final
 * free-text reply). Tolerant to surrounding prose/code fences: only a payload
 * that contains at least one KNOWN tool passes as a tool call.
 */
export function parseToolCalls(raw: string): AgentToolCall[] | null {
  const t = (raw ?? '').trim()
  if (!t) return null
  if (!t.startsWith('{') && !t.startsWith('[') && !t.includes('"tool_calls"') && !t.includes("'tool_calls'")) return null
  const s = t.indexOf('{')
  const e = t.lastIndexOf('}')
  if (s < 0 || e <= s) return null
  try {
    const obj = JSON.parse(t.slice(s, e + 1)) as unknown
    const list = Array.isArray(obj)
      ? obj
      : Array.isArray((obj as { tool_calls?: unknown }).tool_calls)
        ? ((obj as { tool_calls: unknown[] }).tool_calls)
        : null
    if (!list) return null
    const calls: AgentToolCall[] = []
    for (const c of list) {
      if (!c || typeof c !== 'object') continue
      const name = (c as { tool?: unknown }).tool
      if (typeof name !== 'string' || !AGENT_TOOL_NAMES.has(name)) continue
      const args = (c as { args?: unknown }).args
      calls.push({ tool: name, args: args && typeof args === 'object' ? (args as Record<string, unknown>) : {} })
    }
    return calls.length > 0 ? calls : null
  } catch {
    return null
  }
}

/** Compact Arabic summary of result cards — the `output` side that goes back to the model. */
export function compactCardsSummary(cards: ResultCardDTO[]): string {
  return cards
    .map((c) => {
      if (c.kind === 'kv') {
        return `${c.title}: ${c.rows.map((r) => `${r.label} ${r.value}`).join('؛ ')}`
      }
      if (c.kind === 'table') {
        const rows = c.rows
          .slice(0, 6)
          .map((r) => Object.values(r).slice(0, 3).join(' — '))
          .join('؛ ')
        const more = c.rows.length > 6 ? ` (+${c.rows.length - 6} تانيين)` : ''
        const footer = c.footer?.map((f) => `${f.label}: ${f.value}`).join('، ') ?? ''
        return `${c.title} (${c.rows.length} صف): ${rows}${more}${footer ? `. ${footer}` : ''}`
      }
      if (c.kind === 'sources') {
        return `${c.title}: ${c.sources.map((s) => s.title).join('؛ ')}`
      }
      return `${c.title}: ${c.body}`
    })
    .join('\n')
    .slice(0, 1200)
}
