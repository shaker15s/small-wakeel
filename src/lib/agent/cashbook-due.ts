import { db } from '@/lib/db'
import { requireBusinessUser, AuthorizationError } from '@/lib/security/permissions'
import { cashbookAnswerDay } from './cashbook-dates'
import { normalizeAr } from './arabic'
import { egp } from '@/lib/format'
import type { DialogueContext } from './cashbook-dialogue'
import type { ResultCardDTO } from '@/lib/types'

/** A deadline query is not a balance query and never an inference of payment. */
export async function cashbookDueQuery(ctx: DialogueContext): Promise<{ replyText: string; cards: ResultCardDTO[] } | null> {
  const t = normalizeAr(ctx.text)
  if (!/^(?:مين هيسدد(?: النهارده| بكره)?|الديون المتاخره|مواعيد السداد)$/.test(t)) return null
  const today = cashbookAnswerDay('النهارده')!
  const exact = t.endsWith('النهارده') ? today : t.endsWith('بكره') ? cashbookAnswerDay('بكرة')! : null
  const overdue = t === 'الديون المتاخره'
  return db.$transaction(async tx => {
    await requireBusinessUser(ctx.business.id, ctx.user.id, tx)
    if (!await tx.conversation.findFirst({ where: { id: ctx.conversationId, businessId: ctx.business.id, userId: ctx.user.id } })) throw new AuthorizationError()
    const customers = await tx.customer.findMany({ where: { businessId: ctx.business.id, balance: { gt: 0 } }, select: { id: true, balance: true } })
    const suppliers = await tx.supplier.findMany({ where: { businessId: ctx.business.id, balance: { gt: 0 } }, select: { id: true, balance: true } })
    const balances = new Map([...customers, ...suppliers].map(p => [p.id, p.balance]))
    const lots = await tx.cashbookEntry.findMany({ where: { businessId: ctx.business.id, openAmount: { gt: 0 }, dueOn: exact ?? (overdue ? { lt: today } : { not: null }), kind: { in: ['credit_sale', 'credit_purchase', 'lend', 'borrow'] }, operation: { status: 'SUCCEEDED', reversedByRef: null }, OR: [{ customerId: { in: customers.map(p => p.id) } }, { supplierId: { in: suppliers.map(p => p.id) } }] }, orderBy: [{ dueOn: 'asc' }, { occurredOn: 'asc' }, { id: 'asc' }], take: 40 })
    const title = overdue ? 'مواعيد فاتت حسب المسجل' : exact ? `الوعود يوم ${exact}` : 'أقرب الوعود المفتوحة حسب المسجل'
    return {
      replyText: lots.length ? 'دي المواعيد على أصول الدين المفتوحة حسب السجل، مش إثبات إن حد دفع أو امتنع عن الدفع. حصل سداد ولسه ما اتسجلش؟ قول الاسم والمبلغ ويومه نراجع حركة مستقلة.' : 'مفيش وعد مفتوح محدد في الفترة دي حسب المسجل. ده مش معناه إن كل الديون اتسددت؛ فيه حسابات ممكن ميعادها مش متحدد.',
      cards: [{ kind: 'table', title, columns: [{ key: 'party', label: 'الحساب' }, { key: 'direction', label: 'الاتجاه' }, { key: 'due', label: 'الوعد الحالي' }, { key: 'remaining', label: 'المتبقي على الأصل المسجل' }, { key: 'balance', label: 'رصيد الحساب الكلي' }, { key: 'ref', label: 'مرجع الأصل' }], rows: lots.map(lot => ({ party: lot.partyName, direction: lot.customerId ? 'لينا' : 'علينا', due: lot.dueOn!, remaining: egp(lot.openAmount), balance: egp(balances.get(lot.customerId ?? lot.supplierId ?? '') ?? 0), ref: lot.operationRef })), footer: [{ label: 'نطاق العرض', value: 'آخرها ٤٠ أصل دين معروف؛ لا نفترض مواعيد للأرصدة غير المفصّلة ولا سدادًا غير مسجل' }] }],
    }
  })
}
