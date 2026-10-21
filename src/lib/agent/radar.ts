// وكيل — FRAUD & BUSINESS PULSE RADAR (رادار الأمانة واليقظة) — owner-only insights
// computed from REAL operations + audit + usage + inventory velocity. Six detectors:
//   1. Reversals of SUCCEEDED sales created ≥5 minutes after the original,
//      especially still-AWAITING ones («عملية معكوسة بعد ما الزبون مشي»).
//   2. Repeated price queries (search_catalog/get_item_stock UsageEvents) for
//      the same item with ZERO sales of it in the same day ≥3 times
//      («استعلام متكرر من غير بيع»).
//   3. FAILED_SAFE / OUTCOME_UNKNOWN counts per day (info).
//   4. Draft-then-cancel patterns (CANCELLED ops over the last 7 days).
//   5. Margin erosion / below-cost sales («بيع بأقل من التكلفة أو هامش ضعيف»).
//   6. High-velocity imminent stockout («سحب سريع يهدد بنفاد وشيك»).

import { db } from '@/lib/db'
import type { RadarInsightDTO } from '@/lib/types'
import { egpPlain } from '@/lib/format'
import { normalizeAr } from './arabic'
import { startOfCairoDay } from '@/app/api/_lib/dates'

/** Was there any SUCCEEDED sale of this item today? (payload contains it) */
async function soldToday(businessId: string, itemQuery: string): Promise<boolean> {
  if (!itemQuery.trim()) return true // no item name → detector doesn't apply
  const today = startOfCairoDay(0)
  const sales = await db.operation.findMany({
    where: { businessId, type: 'sale', status: 'SUCCEEDED', createdAt: { gte: today } },
    select: { payload: true },
  })
  const q = normalizeAr(itemQuery)
  return sales.some((s) => normalizeAr(s.payload).includes(q))
}

export async function buildRadar(businessId: string): Promise<RadarInsightDTO[]> {
  const business = await db.business.findUniqueOrThrow({ where: { id: businessId }, select: { workflowMode: true } })
  const manual = business.workflowMode === 'cashbook'
  const out: RadarInsightDTO[] = []
  const today = startOfCairoDay(0)
  const weekAgo = new Date(Date.now() - 7 * 86400000)

  // ---- Detector 1: late reversals of succeeded sales ----
  const reversals = await db.operation.findMany({
    where: { businessId, type: 'reversal', createdAt: { gte: weekAgo } },
    orderBy: { createdAt: 'desc' },
    take: 20,
  })
  for (const rev of reversals) {
    let originalRef = rev.reversalOfRef
    if (!originalRef) {
      try {
        originalRef = (JSON.parse(rev.payload) as Record<string, unknown>).originalRef as string | undefined ?? null
      } catch {
        originalRef = null
      }
    }
    if (!originalRef) continue
    const original = await db.operation.findFirst({ where: { businessId, ref: originalRef } })
    if (!original || original.type !== 'sale' || original.status !== 'SUCCEEDED') continue
    const minutesLate = (rev.createdAt.getTime() - original.createdAt.getTime()) / 60000
    if (minutesLate < 5) continue // instant corrections are normal
    let saleTotal = 0
    try {
      const p = JSON.parse(original.payload) as Record<string, unknown>
      if (typeof p.total === 'number') saleTotal = p.total
    } catch {
      /* summary still tells the story */
    }
    const stillPending = rev.status === 'AWAITING_APPROVAL'
    out.push({
      id: `radar-rev-${rev.id.slice(0, 8)}`,
      level: 'danger',
      title: 'عكس متأخر يستحق مراجعة السجل',
      detail: `عكس ${rev.ref} لعملية بيع ${original.ref}${saleTotal > 0 ? ` (${egpPlain(saleTotal)} ج)` : ''} بعد ${Math.round(minutesLate)} دقيقة من تنفيذها${stillPending ? ' — والعكس لسه مستني اعتماد' : ''}. التوقيت لوحده مش دليل خطأ أو سوء تصرف.`,
      evidence: [
        { label: `${original.ref} — ${original.summary.slice(0, 40)}`, ref: original.ref, view: 'journal' },
        { label: `${rev.ref} — العكس`, ref: rev.ref, view: 'journal' },
      ],
    })
  }

  // ---- Detector 2: repeated price queries with zero sale of the item ----
  const usage = await db.usageEvent.findMany({
    where: { businessId, kind: 'tool', createdAt: { gte: today } },
    select: { label: true },
  })
  const queryCounts = new Map<string, number>()
  for (const u of usage) {
    const m = u.label.match(/^(search_catalog|get_item_stock):(.+)$/)
    if (!m) continue
    const item = m[2].trim()
    if (item.length < 2) continue
    queryCounts.set(item, (queryCounts.get(item) ?? 0) + 1)
  }
  for (const [item, count] of queryCounts) {
    if (manual || count < 3) continue
    if (await soldToday(businessId, item)) continue
    out.push({
      id: `radar-query-${normalizeAr(item).slice(0, 12).replace(/\s/g, '-')}`,
      level: 'warning',
      title: 'بحث متكرر من غير بيع مسجل',
      detail: `«${item}» اتطلب ${count} مرات النهاردة ومفيش بيع ظاهر ليه في السجل؛ راجع السياق، ده مش إثبات إن مفيش بيع فعلي أو اتهام لحد.`,
      evidence: [{ label: `استعلامات عن ${item}`, view: 'journal' }],
    })
  }

  // ---- Detector 3: FAILED_SAFE / OUTCOME_UNKNOWN today (info) ----
  const failedToday = await db.operation.count({ where: { businessId, status: 'FAILED_SAFE', createdAt: { gte: today } } })
  const unknownToday = await db.operation.count({ where: { businessId, status: 'OUTCOME_UNKNOWN', createdAt: { gte: today } } })
  if (failedToday > 0) {
    out.push({
      id: 'radar-failed-safe',
      level: 'info',
      title: 'عمليات فشلت بأمان',
      detail: `${failedToday} عملية النهاردة قفلت FAILED_SAFE — مفيش حاجة اتحركت من مكانها، بس راجع السبب.`,
      evidence: [{ label: `عمليات فشلت النهاردة (${failedToday})`, view: 'journal' }],
    })
  }
  if (unknownToday > 0) {
    out.push({
      id: 'radar-outcome-unknown',
      level: 'info',
      title: 'نتايج غير محسومة',
      detail: `${unknownToday} عملية نتيجتها مش متأكدة (OUTCOME_UNKNOWN) — محتاجة مراجعة يدوية عشان نعرف اتنفذت فعلاً ولا لأ.`,
      evidence: [{ label: `نتايج غير محسومة (${unknownToday})`, view: 'journal' }],
    })
  }

  // ---- Detector 4: draft-then-cancel pattern (last 7 days) ----
  const cancelled = await db.operation.findMany({
    where: { businessId, status: 'CANCELLED', createdAt: { gte: weekAgo } },
    select: { ref: true, type: true, summary: true, reason: true },
    orderBy: { createdAt: 'desc' },
  })
  const unexplained = cancelled.filter(c => !c.reason?.startsWith('استُبدلت بمسودة '))
  if (unexplained.length >= 2) {
    out.push({
      id: 'radar-cancel-pattern',
      level: 'info',
      title: 'مسودات بتتلغي كتير',
      detail: `${unexplained.length} مسودة اتلغت خلال أسبوع، باستثناء المسودات المستبدلة بتصحيح موثق. الإلغاء لوحده مش دليل خطأ؛ راجع الأسباب لو محتاج.`,
      evidence: unexplained.slice(0, 3).map((c) => ({ label: `${c.ref} — ${c.summary.slice(0, 40)}`, ref: c.ref, view: 'journal' as const })),
    })
  }

  // ---- Detector 5: Margin erosion / below-cost sales in the last 7 days ----
  const [items, recentSales] = await Promise.all([
    db.item.findMany({ where: { businessId } }),
    db.operation.findMany({
      where: { businessId, type: 'sale', createdAt: { gte: weekAgo } },
      orderBy: { createdAt: 'desc' },
      take: 30,
    }),
  ])
  const itemById = new Map(items.map((it) => [it.id, it]))
  for (const sale of manual ? [] : recentSales) {
    try {
      const p = JSON.parse(sale.payload) as Record<string, unknown>
      if (!p.priceOverride) continue
      const it = itemById.get(String(p.itemId ?? ''))
      const unitPrice = Number(p.unitPrice ?? 0)
      // R70 / PR-001: below-cost needs a RECORDED cost to compare against.
      if (it && unitPrice > 0 && it.costPrice != null && unitPrice < it.costPrice) {
        out.push({
          id: `radar-margin-${sale.id.slice(0, 8)}`,
          level: 'warning',
          title: 'بيع بأقل من سعر التكلفة',
          detail: `العملية ${sale.ref} اتسجلت بسعر مخصص (${egpPlain(unitPrice)} ج للوحدة) أقل من تكلفة «${it.name}» المسجلة (${egpPlain(it.costPrice as number)} ج).`,
          evidence: [{ label: `${sale.ref} — ${it.name}`, ref: sale.ref, view: 'journal' }],
        })
      }
    } catch {
      // ignore
    }
  }

  // ---- Detector 6: Imminent stockout on fast-moving items ----
  const soldQty = new Map<string, number>()
  for (const sale of manual ? [] : recentSales) {
    if (sale.status !== 'SUCCEEDED' || sale.reversedByRef) continue
    try {
      const p = JSON.parse(sale.payload) as Record<string, unknown>
      if (Array.isArray(p.lines)) {
        for (const l of p.lines as Record<string, unknown>[]) {
          const id = String(l.itemId ?? '')
          const q = Number(l.qty ?? 0)
          if (id && q > 0) soldQty.set(id, (soldQty.get(id) ?? 0) + q)
        }
      } else {
        const id = String(p.itemId ?? '')
        const q = Number(p.qty ?? 0)
        if (id && q > 0) soldQty.set(id, (soldQty.get(id) ?? 0) + q)
      }
    } catch {
      // ignore
    }
  }
  const fastRunningOut = items.filter((it) => {
    const sold7 = soldQty.get(it.id) ?? 0
    if (sold7 <= 0) return false
    // R70 / PR-001: an uncounted shelf can't be "running out" — we don't know.
    if (it.stockQty == null) return false
    const daily = sold7 / 7
    const daysLeft = it.stockQty / daily
    return daysLeft <= 3 && it.stockQty > 0
  })
  if (fastRunningOut.length > 0) {
    out.push({
      id: 'radar-fast-stockout',
      level: 'warning',
      title: 'سحب سريع يهدد بنفاد وشيك خلال ٧٢ ساعة',
      detail: `الأصناف (${fastRunningOut.slice(0, 3).map((i) => i.name).join('، ')}) بتتسحب بسرعة ورصيدها الحالي يكفي أقل من ٣ أيام بناءً على مبيعات الأسبوع.`,
      evidence: fastRunningOut.slice(0, 3).map((i) => ({ label: `مخزون ${i.name}`, view: 'inventory' as const })),
    })
  }

  return out
}
