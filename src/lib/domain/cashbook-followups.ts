import { requireBusinessUser } from '@/lib/security/permissions'
import { db } from '@/lib/db'
import { cairoIsoDay } from '@/app/api/_lib/dates'
import { egp } from '@/lib/format'

/** In-app followups only. Re-read ledger under the same write transaction;
 * no payment assumptions, money writes, external sends, or LLM calls. */
export async function runCashbookFollowups(now = new Date(), limit = 20) {
  const day = cairoIsoDay(now)
  return db.$transaction(async tx => {
    const due = await tx.cashbookEntry.findMany({
      where: { dueOn: { lt: day }, openAmount: { gt: 0 }, OR: [{ lastNudgedOn: null }, { lastNudgedOn: { lt: day } }], operation: { status: 'SUCCEEDED', reversedByRef: null } },
      orderBy: [{ dueOn: 'asc' }, { id: 'asc' }], take: Math.max(1, Math.min(limit, 100)),
    })
    let sent = 0
    for (const entry of due) {
      const actor = await requireBusinessUser(entry.businessId, entry.followupUserId ?? entry.userId, tx).catch(() => null)
      if (!actor || !['owner', 'supervisor', 'cashier'].includes(actor.role)) continue
      const party = entry.customerId ? await tx.customer.findFirst({ where: { id: entry.customerId, businessId: entry.businessId } }) : await tx.supplier.findFirst({ where: { id: entry.supplierId ?? '', businessId: entry.businessId } })
      if (!party || party.balance <= 0) continue // no nudge against a settled account
      const claimed = await tx.cashbookEntry.updateMany({ where: { id: entry.id, businessId: entry.businessId, openAmount: { gt: 0 }, OR: [{ lastNudgedOn: null }, { lastNudgedOn: { lt: day } }] }, data: { lastNudgedOn: day } })
      if (!claimed.count) continue
      let conv = await tx.conversation.findFirst({ where: { businessId: entry.businessId, userId: actor.id }, orderBy: { updatedAt: 'desc' } })
      if (!conv) conv = await tx.conversation.create({ data: { businessId: entry.businessId, userId: actor.id, title: 'متابعة دفتر المحل' } })
      await tx.message.create({ data: { conversationId: conv.id, role: 'assistant', modelLabel: 'متابعة دفتر المحل · من السجل', text: `فات ميعاد ${entry.dueOn} لحساب «${entry.partyName}» (${entry.operationRef}، حركة يوم ${entry.occurredOn}). حسب المسجل باقي من الحركة حتى ${egp(Math.min(entry.openAmount, party.balance))}${entry.supplierId ? ' علينا' : ' لينا'}. حصل سداد ولسه ما قلتليش؟ لو حصل قولّي المبلغ ويومه نسجله بعد مراجعتك؛ مش هعتبره اتدفع من غيرك.` } })
      await tx.conversation.update({ where: { id: conv.id }, data: { updatedAt: now } })
      sent++
    }
    return sent
  })
}
