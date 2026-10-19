import { db } from '@/lib/db'
import type { SuggestionDTO } from '@/lib/types'
import { getSnapshot } from './memory'
import { getWorkspacePreferences } from '@/lib/workspace-preferences'
import { WORKSPACE_GOALS } from '@/lib/workspace-options'
import { canDraft } from '@/lib/domain/risk'
import { canUsePermission } from '@/lib/security/permissions'
import type { OpType } from '@/lib/types'

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

/** Incomplete drafts by design: never replay old names, prices or quantities. */
const OP_PROMPT_AR: Record<string, string> = {
  sale: 'عايز أسجل بيع جديد؛ اسألني عن الصنف والكمية وطريقة الدفع قبل أي تسجيل.',
  purchase: 'عايز أسجل شراء جديد؛ اسألني عن المورد والصنف والكمية والسعر.',
  expense: 'عايز أسجل مصروف جديد؛ اسألني عن المبلغ والوصف.',
  collection: 'عايز أسجل تحصيل جديد؛ اسألني عن العميل والمبلغ.',
  payment: 'عايز أسجل سداد جديد؛ اسألني عن المورد والمبلغ.',
  stock_adjustment: 'عايز أراجع تسوية مخزون؛ اسألني عن الصنف والكمية والسبب.',
  membership: 'عايز أجدد اشتراك؛ اسألني عن العضو والخطة والدفع.',
  attendance: 'عايز أسجل حضور؛ اسألني عن العضو.',
  reversal: 'عايز أراجع عكس عملية؛ اسألني عن رقمها والسبب.',
}

function toolIcon(tool: string): SuggestionDTO['icon'] {
  if (tool === 'get_daily_summary') return 'today'
  if (tool === 'get_cash_position') return 'wallet'
  if (tool === 'list_low_stock' || tool === 'search_catalog' || tool === 'get_item_stock') return 'boxes'
  if (tool === 'list_receivables' || tool === 'list_payables' || tool === 'get_member_status' || tool === 'get_supplier_balance') return 'users'
  if (tool === 'get_activity_history' || tool === 'get_transaction_status') return 'chart'
  return 'spark'
}

/** 3 → «٣» — chips are READ, so Arabic numerals. */
const arNum = (n: number) => String(n).replace(/[0-9]/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)])

/**
 * Ranked actor-scoped suggestions: live alerts, actual usage, declared goals, memory.
 * No demo prompts after setup; recurring reports are proposals, never automatic writes.
 */
export async function buildSuggestions(businessId: string, userId: string): Promise<SuggestionDTO[]> {
  const business = await db.business.findUnique({ where: { id: businessId } })
  const user = await db.user.findFirst({ where: { id: userId, businessId } })
  if (!business || !user) return []

  const since14d = new Date(Date.now() - 14 * 86400000)
  const [snapshot, memories, usage, profile] = await Promise.all([
    getSnapshot(business),
    db.agentMemory.findMany({ where: { businessId, userId, active: true }, orderBy: [{ confidence: 'desc' }, { createdAt: 'desc' }], take: 8 }),
    db.usageEvent.findMany({ where: { businessId, userId, createdAt: { gte: since14d } }, select: { kind: true, label: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 2000 }),
    getWorkspacePreferences(businessId, userId),
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
    if (!prompt || (OP_PROMPT_AR[label] && !canDraft(user.role, label as OpType))) continue
    const nice = TOOL_SUGGEST_LABEL[label] ?? OP_SUGGEST_LABEL[label] ?? label
    push({ id: `sg-freq-${label}`, label: `${nice} — ${arNum(n)} مرة`, prompt, reason: 'frequent', reasonLabel: 'بتستخدمه كتير', icon: toolIcon(label) })
  }

  // (c) MEMORY — top active rule/preference
  const topMemory = memories.find((m) => m.kind === 'rule' || m.kind === 'preference')
  if (topMemory) {
    push({ id: `sg-mem-${topMemory.id.slice(0, 8)}`, label: topMemory.kind === 'rule' ? 'قوانينك المحفوظة' : 'اللي فاكره عنك', prompt: 'قولي اللي انت فاكره عني وعن الشغل', reason: 'memory', reasonLabel: 'خاص بشغلك', icon: 'book' })
  }

  // Only recurring READ queries, after >=5 uses on >=3 distinct Cairo days.
  // No financial automation and no task is created by the suggestions endpoint.
  if (canUsePermission(user.role, 'automation.manage')) {
    const candidate = frequent.find(([label, count]) => count >= 5 && !!TOOL_PROMPT_AR[label] && new Set(usage.filter((u) => u.label.split(':')[0] === label).map((u) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(u.createdAt))).size >= 3)
    if (candidate) {
      const label = candidate[0]
      push({ id: `sg-schedule-${label}`, label: 'تحب التقرير يبقى دوري؟', prompt: `اقترح عليّ جدولة تقرير قراءة فقط: ${TOOL_PROMPT_AR[label]}. اسألني عن الموعد والتكرار بتوقيت القاهرة وموافقتي الصريحة؛ لا تنشئ مهمة دلوقتي.`, reason: 'frequent', reasonLabel: 'اقتراح فقط — محتاج موافقتك', icon: 'today' })
    }
  }
  // R46 Mode 2: the entry point to «arbeli programi» — if no real harness is
  // registered yet, offer the chip. The prompt is deliberately permission-first:
  // the brain must explain + ask for the owner's explicit consent (confirmed=false
  // on cli_harness_install) BEFORE anything runs on the owner's machine.
  const hasHarness = (await db.appHarness.findFirst({ where: { businessId }, select: { id: true } })) !== null
  if (!hasHarness && user.role === 'owner') {
    push({ id: 'sg-harness-connect', label: 'اربطلي برنامج الشغل عندي', prompt: 'عايزك توصل ببرنامج الشغل اللي شغال عندي دلوقتي — قولي الأول هتعمل إيه بالظبط على الجهاز، ومش هتحرك حاجة غير بإذني', reason: 'custom', reasonLabel: 'هتسألني الإذن قبل أي حاجة', icon: 'spark' })
  }
  for (const goal of profile.goals) {
    if (goal === 'members' && business.type !== 'gym') continue
    push({ id: `sg-goal-${goal}`, label: WORKSPACE_GOALS[goal].label, prompt: WORKSPACE_GOALS[goal].prompt, reason: 'custom', reasonLabel: 'من أولوياتك', icon: 'spark' })
  }
  return out.slice(0, 8)
}
