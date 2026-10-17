// وكيل — data hygiene that keeps the demo (and a real shop) honest.
//
// Drafts are the safety rail: nothing moves until the owner approves. But an
// un-approved draft from three days ago is not a pending decision any more — it
// is clutter that makes «مستنيات اعتماد» grow forever (the owner-day QA runs
// alone left 30+ of them). This module retires them, WITH an audit trail, so
// «معنديش عمليات معلّقة» stays true.
//
//   WAKIL_STALE_DRAFT_HOURS=0   disable (default 72)
import { db } from '@/lib/db'

export interface ExpireResult {
  expired: number
  scanned: number
}

/**
 * Cancel drafts that waited longer than `hours` (default 72). Explicitly the
 * owner's drafts are NOT silently executed — they are cancelled and the reason
 * is written on the row + in the audit log.
 */
export async function expireStaleDrafts(opts: { hours?: number; limit?: number } = {}): Promise<ExpireResult> {
  const envHours = Number(process.env.WAKIL_STALE_DRAFT_HOURS)
  const hours = opts.hours ?? (Number.isFinite(envHours) ? envHours : 72)
  if (!(hours > 0)) return { expired: 0, scanned: 0 }
  const limit = opts.limit ?? 50
  const before = new Date(Date.now() - hours * 3600_000)
  const stale = await db.operation.findMany({
    where: { status: 'AWAITING_APPROVAL', createdAt: { lt: before } },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: { id: true, ref: true, businessId: true, userId: true, createdAt: true },
  })
  let expired = 0
  for (const op of stale) {
    // Conditional update = the same atomic claim the rest of the write path uses:
    // if a human approved it a millisecond ago, we must not cancel it.
    const res = await db.operation.updateMany({
      where: { id: op.id, status: 'AWAITING_APPROVAL' },
      data: {
        status: 'CANCELLED',
        reason: `مسودة قديمة — اتلغت تلقائيًا بعد ${hours} ساعة من غير اعتماد`,
        decidedAt: new Date(),
      },
    })
    if (res.count === 0) continue
    expired += 1
    await db.auditEvent.create({
      data: {
        businessId: op.businessId,
        actor: op.userId,
        action: 'operation.cancelled',
        ref: op.ref,
        detail: JSON.stringify({ reason: 'stale_draft', hours, createdAt: op.createdAt.toISOString() }),
      },
    })
  }
  return { expired, scanned: stale.length }
}
