// وكيل — «ابدأ يومك» (Morning Brief).
//
// The owner's complaint was «مش مساعد كفايه»: the agent answered questions but
// never STARTED one. This builds the three things worth doing right now from
// the ledger itself — deterministic, no model call, no tokens, no waiting:
//
//   1. money already owed to the shop (the biggest receivable)
//   2. goods about to rot or about to run out (real piastres at risk)
//   3. paperwork the owner forgot (drafts older than a day)
//
// Every item carries a ready-to-send Arabic prompt, so the button does not
// merely navigate — it asks the agent the exact question that fixes the item.
import { db } from '@/lib/db'
import { egp } from '@/lib/format'
import { cairoIsoDay } from '@/app/api/_lib/dates'
import { requireBusinessReader } from '@/lib/security/permissions'

export type BriefTone = 'money' | 'stock' | 'time' | 'risk'

export interface BriefItem {
  id: string
  tone: BriefTone
  title: string
  why: string
  /** piastres at stake — used for ranking and shown as the reason */
  impact: number
  cta: { label: string; prompt?: string; view?: string }
}

export interface MorningBrief {
  headline: string
  items: BriefItem[]
}

/** «١٢٥» — a bare number the Arabic parser accepts inside a chat prompt. */
function plain(n: number): string {
  return new Intl.NumberFormat('ar-EG', { maximumFractionDigits: 0 }).format(n)
}

/** Arabic counted noun: 3–10 take the plural («٣ مسودات»), 1/2 and 11+ don't. */
function count(n: number, one: string, few: string): string {
  return `${plain(n)} ${n >= 3 && n <= 10 ? few : one}`
}

export async function buildMorningBrief(businessId: string, userId?: string): Promise<MorningBrief> {
  if (userId) await requireBusinessReader(businessId, userId)
  const now = Date.now()
  const today = cairoIsoDay(new Date(now))
  const [business, customers, suppliers, items, pending, reminders] = await Promise.all([
    db.business.findUniqueOrThrow({ where: { id: businessId }, select: { type: true, openingCash: true, workflowMode: true } }),
    db.customer.findMany({
      where: { businessId },
      select: { id: true, name: true, balance: true, expiresAt: true },
    }),
    db.supplier.findMany({ where: { businessId, balance: { gt: 0 } }, select: { id: true } }),
    db.item.findMany({
      where: { businessId },
      select: { id: true, name: true, stockQty: true, lowStockThreshold: true, costPrice: true, expiresAt: true },
    }),
    db.operation.findMany({
      where: { businessId, status: 'AWAITING_APPROVAL' },
      select: { id: true, ref: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: 50,
    }),
    userId ? db.shopReminder.findMany({ where: { businessId, userId, active: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 11 }) : [],
  ])

  const out: BriefItem[] = []
  const manual = business.workflowMode === 'cashbook'
  // Original promises, not a guessed deadline on a balance. A settled account,
  // reversed origin, future promise or unapproved draft must never be chased.
  const promised = manual ? await db.cashbookEntry.findMany({ where: {
    businessId, openAmount: { gt: 0 }, dueOn: { lte: today },
    kind: { in: ['credit_sale', 'credit_purchase', 'lend', 'borrow'] },
    operation: { status: 'SUCCEEDED', reversedByRef: null },
    OR: [{ customerId: { in: customers.filter(c => c.balance > 0).map(c => c.id) } }, { supplierId: { in: suppliers.map(s => s.id) } }],
  }, select: { dueOn: true, openAmount: true } }) : []
  for (const overdue of [true, false]) {
    const lots = promised.filter(p => overdue ? p.dueOn! < today : p.dueOn === today)
    if (lots.length) out.push({
      id: overdue ? 'promises-overdue' : 'promises-today', tone: 'time',
      title: `${count(lots.length, 'وعد سداد', 'وعود سداد')} ${overdue ? 'ميعاده فات حسب المسجل' : 'ميعاده النهارده'}`,
      why: 'راجع اللي لينا واللي علينا. الميعاد مش إثبات تأخير أو دفع؛ ممكن حصل سداد ولسه ما اتسجلش.',
      impact: lots.reduce((sum, lot) => sum + lot.openAmount, 0),
      cta: { label: overdue ? 'راجع المواعيد اللي فاتت' : 'راجع وعود النهارده', prompt: overdue ? 'الديون المتأخرة' : 'مين هيسدد النهارده' },
    })
  }
  if (manual && reminders.length) out.push({
    id: 'restock', tone: 'stock', title: 'افتكر النواقص مع البضاعة الجاية',
    why: `${reminders.slice(0, 3).map(r => r.subject).join('، ')}${reminders.length > 3 ? ' وغيرها' : ''} — قائمة طلبك، مش رصيد مخزون مؤكد.`,
    impact: 0, cta: { label: 'راجع قائمة النواقص', prompt: 'قائمة النواقص' },
  })

  // ---- 1) the money already on the street --------------------------------
  const debtors = customers.filter((c) => c.balance > 0).sort((a, b) => b.balance - a.balance)
  if (debtors.length > 0) {
    const top = debtors[0]
    const total = debtors.reduce((s, c) => s + c.balance, 0)
    out.push({
      id: `collect:${top.id}`,
      tone: 'money',
      title: `راجع ${egp(top.balance)} المسجلة على ${top.name}`,
      why:
        debtors.length > 1
          ? `إجمالي اللي عند العملاء ${egp(total)} — ${top.name} أكبر جزء فيه`
          : `ده رصيد الحساب حسب المسجل، مش إثبات إن التحصيل حصل أو مستحق النهارده`,
      impact: top.balance,
      cta: { label: 'راجع الحساب', prompt: manual ? `حساب العميل ${top.name}` : 'مين عليه فلوس' },
    })
  }

  // ---- 2) goods that will be lost (expiry) -------------------------------
  const expiring = items
    .filter((i) => i.expiresAt && i.stockQty > 0)
    .map((i) => ({
      ...i,
      days: Math.ceil(((i.expiresAt as Date).getTime() - now) / 86_400_000),
    }))
    .filter((i) => i.days <= 10)
    .sort((a, b) => a.days - b.days)
  if (expiring.length > 0) {
    const risk = expiring.reduce((s, i) => s + Math.max(0, i.stockQty) * i.costPrice, 0)
    const worst = expiring[0]
    out.push({
      id: 'expiring',
      tone: 'time',
      title: `${count(expiring.length, 'صنف', 'أصناف')} صلاحيته قربت — اتحرك قبل الخسارة`,
      why: `${worst.name} بيفضل ${worst.days < 0 ? 'منتهي بالفعل' : `${plain(worst.days)} يوم`} — حوالي ${egp(risk)} بضاعة معرّضة`,
      impact: risk,
      cta: { label: 'شوف الصلاحيات', prompt: 'ايه اللي هيخلص صلاحيته قريب؟' },
    })
  }

  // ---- 3) stock about to run out ----------------------------------------
  const low = items.filter((i) => i.stockQty <= i.lowStockThreshold)
  if (!manual && low.length > 0) {
    const refill = low.reduce((s, i) => s + Math.max(0, i.lowStockThreshold - i.stockQty) * i.costPrice, 0)
    out.push({
      id: 'low-stock',
      tone: 'risk',
      title: `${count(low.length, 'صنف', 'أصناف')} خلص أو قرّب يخلص`,
      why: low.length === 1 ? `${low[0].name} محتاج طلب` : `أولهم ${low[0].name} — والطلب كله حوالي ${egp(refill)}`,
      impact: refill,
      cta: { label: 'شوف النواقص', prompt: 'ايه اللي ناقص عندي؟' },
    })
  }

  // ---- 4) memberships about to lapse (gyms) ------------------------------
  const lapsing = customers
    .filter((c) => c.expiresAt)
    .map((c) => ({ ...c, days: Math.ceil(((c.expiresAt as Date).getTime() - now) / 86_400_000) }))
    .filter((c) => c.days <= 7)
    .sort((a, b) => a.days - b.days)
  if (business.type === 'gym' && lapsing.length > 0) {
    const worst = lapsing[0]
    out.push({
      id: 'lapsing',
      tone: 'time',
      title: `${count(lapsing.length, 'عضوية', 'عضويات')} محتاجة تجديد`,
      why: `${worst.name} — ${worst.days < 0 ? 'منتهية' : `فاضل ${plain(worst.days)} يوم`}`,
      impact: 0,
      cta: { label: 'شوف العضويات', prompt: 'مين اللي عضويته قربت تخلص؟' },
    })
  }

  // ---- 5) paperwork left hanging ----------------------------------------
  const stale = pending.filter((p) => now - p.createdAt.getTime() > 86_400_000)
  const fresh = pending.length - stale.length
  if (stale.length > 0 || fresh > 0) {
    out.push({
      id: 'pending',
      tone: 'risk',
      title: stale.length > 0 ? `${count(stale.length, 'مسودة', 'مسودات')} قديمة مستنية قرارك` : `${count(fresh, 'مسودة', 'مسودات')} مستنية اعتمادك`,
      why: stale.length > 0 ? `أقدمها ${stale[0].ref} من ${plain(Math.floor((now - stale[0].createdAt.getTime()) / 86_400_000))} يوم` : 'اتأكد إن كل حاجة مسجلة صح قبل ما تقفل اليوم',
      impact: 0,
      cta: { label: 'راجع المسودات', view: 'journal' },
    })
  }

  // Rank by money at stake, then by the order above (money → expiry → stock).
  const priority = (id: string) => id === 'promises-overdue' ? 5 : id === 'promises-today' ? 4 : id === 'restock' ? 3 : id === 'pending' ? 2 : 0
  out.sort((a, b) => (manual ? priority(b.id) - priority(a.id) : 0) || b.impact - a.impact)
  const items3 = out.slice(0, 3)

  const headline =
    items3.length === 0
      ? 'مفيش متابعة مستعجلة ظاهرة من المسجل؛ لو حاجة لسه ما اتسجلتش قولّي'
      : items3.length === 1
        ? 'حاجة واحدة بس محتاجة منك النهاردة'
        : `${plain(items3.length)} حاجات تستحق المراجعة — حسب المسجل`

  return { headline, items: items3 }
}
