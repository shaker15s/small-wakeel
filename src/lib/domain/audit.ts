// وكيل — «تأمل وكيل»: a deterministic self-critique pass over every draft.
//
// WHY this exists (and why it is NOT a model call): an LLM that checks its own
// work is still the same system that made the mistake. The audits that actually
// catch shop-floor errors are arithmetic and historical:
//   • «بعت ٢ علبة لبن بـ٩٥» — is 4 500 piastres per box really this item's price?
//     The last five sales of the same item answer that from the ledger, not from
//     vibes.
//   • selling 5 boxes when 3 are on the shelf (oversell) — the stock row knows.
//   • the same draft entered twice by accident — the previous 10 minutes know.
//   • collecting more than the customer owes — the balance row knows.
//   • an expense 3× the usual daily spend — the trailing 30 days know.
//
// Findings ride along with the draft card (so the owner SEES the doubt before
// approving), land in the audit trail, and lower the reported confidence. A
// dangerous finding never disappears silently and never blocks the owner: the
// human stays the decision-maker, the agent just refuses to be confidently
// wrong.
import { db } from '@/lib/db'
import { egp } from '@/lib/format'
import type { AuditFindingDTO } from '@/lib/types'
import type { OpType } from '@/lib/types'

export type AuditCode = AuditFindingDTO['code']
export type AuditFinding = AuditFindingDTO

export interface AuditResult {
  findings: AuditFinding[]
  /** 0..100 — how much the arithmetic backs this draft. Shown on the card. */
  confidence: number
  /** Wall-clock cost of the audit (ms) — surfaced in the thinking trail. */
  ms: number
}

/** Deviation above this fraction of the historical price is worth a warning. */
const PRICE_WARN = 0.2
const PRICE_DANGER = 0.5
/** Same type + same summary inside this window looks like a double entry. */
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000
/** An expense this many times the trailing daily median is a spike. */
const EXPENSE_SPIKE_FACTOR = 3

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid]
}

/** Lines of a multi-item draft (single-item drafts carry `itemId` directly). */
interface PayloadLine {
  itemId?: string
  qty?: number
  unitPrice?: number
  unit?: string
}

interface AuditInput {
  businessId: string
  type: OpType
  summary: string
  payload: Record<string, unknown>
}

/**
 * Confidence the agent is willing to claim, given what the audit found.
 * Deterministic on purpose: the number is auditable, not model-generated.
 */
export function scoreAudit(findings: AuditFinding[]): number {
  let score = 100
  for (const f of findings) {
    if (f.severity === 'danger') score -= 30
    else if (f.severity === 'warn') score -= 12
    else score -= 3
  }
  return Math.max(20, Math.min(100, score))
}

export async function auditDraft(input: AuditInput): Promise<AuditResult> {
  const started = Date.now()
  const findings: AuditFinding[] = []
  try {
    const payload = input.payload
    const lines: PayloadLine[] = Array.isArray(payload.lines)
      ? (payload.lines as PayloadLine[])
      : payload.itemId
        ? [{ itemId: String(payload.itemId), qty: Number(payload.qty ?? 0), unitPrice: Number(payload.unitPrice ?? 0) }]
        : []

    if ((input.type === 'sale' || input.type === 'purchase') && lines.length === 0) {
      findings.push({
        code: 'unknown_entity',
        severity: 'info',
        message: 'العملية من غير سطور أصناف — راجعها قبل الاعتماد.',
      })
    }

    if (lines.length > 0 && (input.type === 'sale' || input.type === 'purchase')) {
      const itemIds = lines.map((l) => l.itemId).filter((id): id is string => Boolean(id))
      const items = await db.item.findMany({ where: { id: { in: itemIds }, businessId: input.businessId } })
      const byId = new Map(items.map((i) => [i.id, i]))

      // — historical prices for the same items, same operation type
      const history = await db.operation.findMany({
        where: {
          businessId: input.businessId,
          type: input.type,
          status: 'SUCCEEDED',
          createdAt: { gte: new Date(Date.now() - 90 * 86_400_000) },
        },
        select: { payload: true },
        orderBy: { createdAt: 'desc' },
        take: 200,
      })
      const pricesByItem = new Map<string, number[]>()
      for (const row of history) {
        try {
          const p = JSON.parse(row.payload) as { itemId?: string; unitPrice?: number; lines?: PayloadLine[] }
          const past: PayloadLine[] = Array.isArray(p.lines)
            ? p.lines
            : p.itemId
              ? [{ itemId: p.itemId, unitPrice: p.unitPrice }]
              : []
          for (const l of past) {
            if (!l.itemId || typeof l.unitPrice !== 'number' || l.unitPrice <= 0) continue
            const list = pricesByItem.get(l.itemId) ?? []
            list.push(l.unitPrice)
            pricesByItem.set(l.itemId, list)
          }
        } catch {
          // a malformed historical payload must never break a new draft
        }
      }

      for (const line of lines) {
        const item = line.itemId ? byId.get(line.itemId) : undefined
        const qty = Number(line.qty ?? 0)
        const unitPrice = Number(line.unitPrice ?? 0)

        // — oversell (stock is in the item's base unit; qty is already converted)
        if (item && input.type === 'sale' && qty > item.stockQty) {
          findings.push({
            code: 'oversell',
            severity: item.stockQty <= 0 ? 'danger' : 'warn',
            message: `الكمية أكبر من المتاح في المخزون لـ«${item.name}».`,
            detail: `المطلوب ${qty} والمتاح ${item.stockQty}`,
          })
        }

        // — price sanity against the ledger (last 5 priced sales of this item)
        if (item && unitPrice > 0) {
          const past = (pricesByItem.get(item.id) ?? []).slice(0, 5)
          const reference = median(past) ?? (input.type === 'sale' ? item.sellPrice : item.costPrice)
          if (reference > 0) {
            const deviation = Math.abs(unitPrice - reference) / reference
            if (deviation >= PRICE_WARN) {
              findings.push({
                code: 'price_anomaly',
                severity: deviation >= PRICE_DANGER ? 'danger' : 'warn',
                message: `سعر «${item.name}» بعيد عن المعتاد.`,
                detail: `اللي بعتها بيه: ${egp(unitPrice)} · المعتاد: ${egp(reference)}${past.length > 1 ? ` (آخر ${past.length})` : ''}`,
              })
            }
          }
        }
      }
    }

    // — collections / payments larger than the outstanding balance
    if (input.type === 'collection' || input.type === 'payment') {
      const amount = Number(payload.amount ?? 0)
      const partyId = String((input.type === 'collection' ? payload.customerId : payload.supplierId) ?? '')
      if (amount > 0 && partyId) {
        const party =
          input.type === 'collection'
            ? await db.customer.findUnique({ where: { id: partyId } })
            : await db.supplier.findUnique({ where: { id: partyId } })
        const balance = party?.balance ?? 0
        if (balance > 0 && amount > balance) {
          findings.push({
            code: 'overpay',
            severity: 'warn',
            message: `${input.type === 'collection' ? 'التحصيل' : 'السداد'} أكبر من المديونية المسجّلة.`,
            detail: `المبلغ ${egp(amount)} · المسجّل ${egp(balance)}`,
          })
        }
      }
    }

    // — duplicate protection (the user pressed send twice, or the same entry
    //   was typed in two chats)
    const since = new Date(Date.now() - DUPLICATE_WINDOW_MS)
    const twin = await db.operation.findFirst({
      where: {
        businessId: input.businessId,
        type: input.type,
        summary: input.summary,
        createdAt: { gte: since },
        status: { in: ['AWAITING_APPROVAL', 'SUCCEEDED'] },
      },
      orderBy: { createdAt: 'desc' },
      select: { ref: true, createdAt: true },
    })
    if (twin) {
      const minutes = Math.max(1, Math.round((Date.now() - twin.createdAt.getTime()) / 60_000))
      findings.push({
        code: 'duplicate',
        severity: 'warn',
        message: 'فيه عملية بنفس الوصف اتسجلت قريب — اتأكد إنها مش مكررة.',
        detail: `${twin.ref} قبل ${minutes} دقيقة`,
      })
    }

    // — expense spike vs the trailing 30-day daily median
    if (input.type === 'expense') {
      const total = Number(payload.total ?? payload.amount ?? 0)
      if (total > 0) {
        const expenses = await db.operation.findMany({
          where: {
            businessId: input.businessId,
            type: 'expense',
            status: 'SUCCEEDED',
            createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) },
          },
          select: { payload: true },
          take: 300,
        })
        const amounts = expenses
          .map((row) => {
            try {
              const p = JSON.parse(row.payload) as { total?: number; amount?: number }
              return Number(p.total ?? p.amount ?? 0)
            } catch {
              return 0
            }
          })
          .filter((n) => n > 0)
        const usual = median(amounts)
        if (usual != null && total > usual * EXPENSE_SPIKE_FACTOR) {
          findings.push({
            code: 'expense_spike',
            severity: 'warn',
            message: 'المصروف ده أكبر بكتير من مصروفاتك المعتادة.',
            detail: `الطلب ${egp(total)} · المعتاد ${egp(usual)}`,
          })
        }
      }
    }
  } catch (err) {
    // An audit failure must NEVER block a draft: the owner is the decision-maker,
    // and a missing warning is better than a stuck shop.
    console.error('[audit] draft audit failed:', err)
    return { findings, confidence: 80, ms: Date.now() - started }
  }

  return { findings, confidence: scoreAudit(findings), ms: Date.now() - started }
}
