// وكيل — DYNAMIC SUGGESTIONS ENGINE.
// Chips under the composer are NEVER static: they are ranked from LIVE data
// (alerts) + REAL usage history (frequent) + the owner's memories + the
// vertical's demos + the time of day. The list MUST change as the shop works.

import { db } from '@/lib/db'
import type { SuggestionDTO } from '@/lib/types'
import { getSnapshot } from './memory'

/** Natural prompts per read tool (used by the FREQUENT source). */
const TOOL_PROMPT_AR: Record<string, string> = {
  get_daily_summary: 'ملخص اليوم',
  get_cash_position: 'ايه وضع الخزنة؟',
  list_low_stock: 'ايه الناقص في المخزون؟',
  list_receivables: 'مين عليها فلوس؟',
  list_payables: 'اللي علينا للموردين',
  list_expiring: 'الأصناف اللي صلاحيتها قربت تخلص',
  search_catalog: 'ايه اللي عندنا في الكتالوج؟',
  get_item_stock: 'ايه اللي عندنا في الكتالوج؟',
  get_activity_history: 'آخر الحركات',
  get_supplier_balance: 'اللي علينا للموردين',
  get_member_status: 'مين عليها فلوس؟',
  get_transaction_status: 'آخر الحركات',
}

/** Arabic labels per tool for the frequent chips. */
const TOOL_SUGGEST_LABEL: Record<string, string> = {
  get_daily_summary: 'ملخص اليوم',
  get_cash_position: 'وضع الخزنة',
  list_low_stock: 'النواقص',
  list_receivables: 'مين عليها فلوس',
  list_payables: 'مستحقات الموردين',
  list_expiring: 'الصلاحيات القريبة',
  search_catalog: 'بحث في الكتالوج',
  get_item_stock: 'بحث في الكتالوج',
  get_activity_history: 'آخر الحركات',
  get_member_status: 'مين عليها فلوس',
  get_transaction_status: 'آخر الحركات',
}

/** Arabic labels per write opType (frequent write chips — «بيع — ٤ مرة» never «sale — ٤ مرة»). */
const OP_SUGGEST_LABEL: Record<string, string> = {
  sale: 'بيع',
  purchase: 'شرا',
  expense: 'مصروف',
  collection: 'تحصيل',
  payment: 'سداد',
  stock_adjustment: 'تسوية مخزون',
  membership: 'اشتراك جيم',
  attendance: 'حضور',
  reversal: 'عكس عملية',
}

/** Demo prompt per write opType (frequent writes). */
const OP_PROMPT_AR: Record<string, string> = {
  sale: 'بعت 10 جرام عود كمبودي',
  purchase: 'اشتريت كيلو مسك من المورد',
  expense: 'سجل مصروف كهربا 200 ج',
  collection: 'تحصيل 100 من الحاج رجب',
  payment: 'سدد 500 للمورد',
  stock_adjustment: 'عدل مخزون الكركديه يبقى 30 كيلو',
  membership: 'تجديد اشتراك عضو',
  attendance: 'حضور عضو النهاردة',
  reversal: 'عكس عملية',
}

/** One demo per vertical — shows what وكيل understands here. */
const VERTICAL_DEMO: Record<string, { label: string; prompt: string }> = {
  attar: { label: 'بيع بالجرام', prompt: 'بعت 10 جرام عود كمبودي' },
  supermarket: { label: 'طلب بيتي', prompt: 'ابن مدام منى خد طلبات بـ85 ج' },
  pharmacy: { label: 'بيع دواء', prompt: 'بعت شريطين أوجمنتين' },
  gym: { label: 'حصة تدريب', prompt: 'كابتن طارق لعب حصة PT' },
}

function toolIcon(tool: string): SuggestionDTO['icon'] {
  if (tool === 'get_daily_summary') return 'today'
  if (tool === 'get_cash_position') return 'wallet'
  if (tool === 'list_low_stock' || tool === 'search_catalog' || tool === 'get_item_stock') return 'boxes'
  if (tool === 'list_receivables' || tool === 'list_payables' || tool === 'get_member_status' || tool === 'get_supplier_balance') return 'users'
  if (tool === 'get_activity_history' || tool === 'get_transaction_status') return 'chart'
  return 'spark'
}

/** Cairo hour right now (0-23). */
function cairoHour(): number {
  try {
    return Number(new Intl.DateTimeFormat('en-EG', { timeZone: 'Africa/Cairo', hour: 'numeric', hour12: false }).format(new Date()))
  } catch {
    return new Date().getHours()
  }
}

/** 3 → «٣» — chips are READ, so Arabic numerals. */
const arNum = (n: number) => String(n).replace(/[0-9]/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)])

/**
 * Ranked suggestions (max 8): alert > frequent > memory > vertical > time.
 * Everything is computed from the LIVE database — zero static chips.
 */
export async function buildSuggestions(businessId: string, userId: string): Promise<SuggestionDTO[]> {
  const business = await db.business.findUnique({ where: { id: businessId } })
  if (!business) return []

  const since14d = new Date(Date.now() - 14 * 86400000)
  const [snapshot, memories, usage] = await Promise.all([
    getSnapshot(business),
    db.agentMemory.findMany({ where: { businessId, userId, active: true }, orderBy: [{ confidence: 'desc' }, { createdAt: 'desc' }], take: 8 }),
    db.usageEvent.findMany({ where: { businessId, userId, createdAt: { gte: since14d } }, select: { kind: true, label: true } }),
  ])

  const out: SuggestionDTO[] = []
  const seenPrompts = new Set<string>()
  const push = (s: SuggestionDTO) => {
    if (seenPrompts.has(s.prompt) || out.length >= 8) return
    seenPrompts.add(s.prompt)
    out.push(s)
  }

  // (a) ALERT-driven — real live data first
  if (snapshot.pendingCount > 0) {
    push({ id: 'sg-alert-pending', label: 'اعتمد العمليات المستنية', prompt: 'ايه العمليات المستنية اعتماد؟', reason: 'alert', reasonLabel: 'فيه تنبيه', icon: 'alert', tone: 'primary' })
  }
  if (snapshot.lowStockCount > 0) {
    push({ id: 'sg-alert-lowstock', label: `شوف النواقص (${arNum(snapshot.lowStockCount)})`, prompt: 'ايه الناقص في المخزون؟', reason: 'alert', reasonLabel: 'فيه تنبيه', icon: 'boxes' })
  }
  if (snapshot.expiringCount > 0) {
    push({ id: 'sg-alert-expiring', label: 'صلاحيات قربت تخلص', prompt: 'الأصناف اللي صلاحيتها قربت تخلص', reason: 'alert', reasonLabel: 'فيه تنبيه', icon: 'alert' })
  }
  if (business.type === 'gym' && snapshot.expiringMembers.length > 0) {
    push({ id: 'sg-alert-gymexp', label: `اشتراكات بتخلص (${arNum(snapshot.expiringMembers.length)})`, prompt: 'قولي مين الأعضاء اللي اشتراكهم بيخلص قريب وعليهم فلوس', reason: 'alert', reasonLabel: 'فيه تنبيه', icon: 'users' })
  }
  if (snapshot.receivablesTotal > 0) {
    push({ id: 'sg-alert-receivables', label: 'مين عليها فلوس؟', prompt: 'مين عليها فلوس؟', reason: 'alert', reasonLabel: 'فيه تنبيه', icon: 'users' })
  }

  // (b) FREQUENT — UsageEvent kind tool/command grouped by base label (tool
  // name before the ':query' suffix), top 3, threshold ≥3 uses in 14 days
  const counts = new Map<string, number>()
  for (const u of usage) {
    if (u.kind !== 'tool' && u.kind !== 'command') continue
    const base = u.label.split(':')[0]
    counts.set(base, (counts.get(base) ?? 0) + 1)
  }
  const frequent = [...counts.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
  for (const [label, n] of frequent) {
    const prompt = TOOL_PROMPT_AR[label] ?? OP_PROMPT_AR[label]
    if (!prompt) continue
    const nice = TOOL_SUGGEST_LABEL[label] ?? OP_SUGGEST_LABEL[label] ?? label
    push({ id: `sg-freq-${label}`, label: `${nice} — ${arNum(n)} مرة`, prompt, reason: 'frequent', reasonLabel: 'بتستخدمه كتير', icon: toolIcon(label) })
  }

  // (c) MEMORY — top active rule/preference
  const topMemory = memories.find((m) => m.kind === 'rule' || m.kind === 'preference')
  if (topMemory) {
    push({ id: `sg-mem-${topMemory.id.slice(0, 8)}`, label: topMemory.kind === 'rule' ? 'قوانينك المحفوظة' : 'اللي فاكره عنك', prompt: 'قولي اللي انت فاكره عني وعن الشغل', reason: 'memory', reasonLabel: 'خاص بشغلك', icon: 'book' })
  }

  // (d) VERTICAL demo
  const demo = VERTICAL_DEMO[business.type] ?? VERTICAL_DEMO.supermarket
  if (demo) {
    push({ id: 'sg-vertical-demo', label: demo.label, prompt: demo.prompt, reason: 'vertical', reasonLabel: 'جرّب ده', icon: 'spark' })
  }

  // (e) TIME-based — Cairo morning < 11 opens the day; evening ≥ 20 closes it
  const hour = cairoHour()
  if (hour < 11) {
    push({ id: 'sg-time-morning', label: 'افتح يومك', prompt: 'ملخص اليوم', reason: 'time', reasonLabel: 'صباح الخير — الوقت مناسب', icon: 'today' })
  } else if (hour >= 20) {
    push({ id: 'sg-time-evening', label: 'اقفل الوردية', prompt: 'اقفل الوردية — عايز ملخص اليوم', reason: 'time', reasonLabel: 'آخر اليوم', icon: 'today' })
  }

  return out.slice(0, 8)
}
