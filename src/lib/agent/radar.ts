// وكيل — FRAUD RADAR (رادار الأمانة) — owner-only honesty insights computed
// from REAL operations + audit + usage. Four detectors:
//   1. Reversals of SUCCEEDED sales created ≥5 minutes after the original,
//      especially still-AWAITING ones («عملية معكوسة بعد ما الزبون مشي»).
//   2. Repeated price queries (search_catalog/get_item_stock UsageEvents) for
//      the same item with ZERO sales of it in the same day ≥3 times
//      («استعلام متكرر من غير بيع»).
//   3. FAILED_SAFE / OUTCOME_UNKNOWN counts per day (info).
//   4. Draft-then-cancel patterns (CANCELLED ops over the last 7 days).
// Empty [] is a perfectly good result for clean data.

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
      title: 'عملية معكوسة بعد ما الزبون مشي',
      detail: `عكس ${rev.ref} لعملية بيع ${original.ref}${saleTotal > 0 ? ` (${egpPlain(saleTotal)} ج)` : ''} بعد ${Math.round(minutesLate)} دقيقة من تنفيذها${stillPending ? ' — والعكس لسه مستني اعتماد' : ''}. دي عادة بتتحقق قبل الاعتماد.`,
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
    if (count < 3) continue
    if (await soldToday(businessId, item)) continue
    out.push({
      id: `radar-query-${normalizeAr(item).slice(0, 12).replace(/\s/g, '-')}`,
      level: 'warning',
      title: 'استعلام متكرر من غير بيع',
      detail: `«${item}» اتطلب ${count} مرات النهاردة ومفيش أي عملية بيع ليه — ممكن حد بيتسعّر لأطراف بره. راجع سجل العمليات.`,
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
    select: { ref: true, type: true, summary: true },
    orderBy: { createdAt: 'desc' },
  })
  if (cancelled.length >= 2) {
    out.push({
      id: 'radar-cancel-pattern',
      level: 'info',
      title: 'مسودات بتتلغي كتير',
      detail: `${cancelled.length} مسودة اتعملت واتلغت خلال أسبوع — لو ده نمط متكرر من نفس الموظف يبقى فيه لخبطة في الإدخال أو حد بيجرب من غير قصد.`,
      evidence: cancelled.slice(0, 3).map((c) => ({ label: `${c.ref} — ${c.summary.slice(0, 40)}`, ref: c.ref, view: 'journal' as const })),
    })
  }

  return out
}
