import { prepareSettlementVerification } from './debt-settlements'
import { preparePromiseVerification } from './debt-promises'
import type { Prisma } from '@prisma/client'
import type { OpType } from '@/lib/types'
import type { ExecOutcome } from './executors'
import { egp } from '@/lib/format'

/** Independent accounting read-back, in the SAME transaction as the effects.
 * Per-type stock/expiry checks alone cannot detect a missing debt/cash movement.
 */
export async function prepareAccountingVerification(
  tx: Prisma.TransactionClient, businessId: string, ref: string, type: OpType, p: Record<string, unknown>,
): Promise<() => Promise<ExecOutcome['checks']>> {
  if (type === 'debt_promise') return preparePromiseVerification(tx, businessId, ref, p)
  if (type === 'cashbook') return prepareCashbookVerification(tx, businessId, ref, p)
  const total = Number(p.total ?? 0)
  const paid = Number(p.paid ?? total)
  const amount = Number(p.amount ?? 0)
  const cashDelta = type === 'sale' || type === 'membership' ? paid
    : type === 'purchase' ? -paid : type === 'expense' ? -total
      : type === 'collection' ? amount : type === 'payment' ? -amount : null
  if (cashDelta === null) return async () => []

  const cashNet = async () => (await tx.cashEntry.findMany({
    where: { businessId }, select: { direction: true, amount: true },
  })).reduce((sum, entry) => sum + (entry.direction === 'in' ? entry.amount : -entry.amount), 0)
  const beforeCash = await cashNet()
  const verifySettlement = type === 'collection' || type === 'payment' ? await prepareSettlementVerification(tx, businessId, ref, String(type === 'collection' ? p.customerId : p.supplierId), type === 'collection', amount) : null
  // R50: a credit draft may carry a TYPED NAME only (customer_add / new
  // supplier born at approval) — resolve the counterparty by name too, so the
  // read-back verifies the REAL account the money landed on.
  const customer = (type === 'sale' || type === 'collection' || type === 'membership')
    ? p.customerId
      ? await tx.customer.findFirst({ where: { id: String(p.customerId), businessId } })
      : await tx.customer.findFirst({ where: { businessId, name: String(p.customerName ?? '').trim() } })
    : null
  const supplier = (type === 'purchase' || type === 'payment')
    ? p.supplierId
      ? await tx.supplier.findFirst({ where: { id: String(p.supplierId), businessId } })
      : await tx.supplier.findFirst({ where: { businessId, name: String(p.supplierName ?? '').trim() } })
    : null

  return async () => {
    const afterCash = await cashNet()
    const refEntries = await tx.cashEntry.findMany({ where: { businessId, ref } })
    const refNet = refEntries.reduce((sum, entry) => sum + (entry.direction === 'in' ? entry.amount : -entry.amount), 0)
    const checks: ExecOutcome['checks'] = [
      { label: 'الأثر الصافي على الخزنة', expected: egp(beforeCash + cashDelta), actual: egp(afterCash), pass: afterCash === beforeCash + cashDelta },
      { label: 'حركة الخزنة مرتبطة بالمرجع الصحيح', expected: egp(cashDelta), actual: egp(refNet), pass: refEntries.length === 1 && refNet === cashDelta },
    ]
    if (customer || type === 'membership') {
      const after = customer ? await tx.customer.findUnique({ where: { id: customer.id } })
        : await tx.customer.findFirst({ where: { businessId, name: String(p.customerName) } })
      const delta = type === 'collection' ? -amount : total - paid
      const expected = (customer?.balance ?? 0) + delta
      checks.push({ label: 'الأثر على رصيد العميل', expected: egp(expected), actual: after ? egp(after.balance) : 'غير موجود', pass: !!after && after.balance === expected })
    }
    if (supplier) {
      const after = await tx.supplier.findUniqueOrThrow({ where: { id: supplier.id } })
      const expected = supplier.balance + (type === 'payment' ? -amount : total - paid)
      checks.push({ label: 'الأثر على رصيد المورد', expected: egp(expected), actual: egp(after.balance), pass: after.balance === expected })
    }
    if (type === 'sale' || type === 'purchase') {
      const meta = await tx.cashbookEntry.findFirst({ where: { businessId, operationRef: ref } })
      const credit = total - paid
      // R50: name-only drafts resolve their counterparty at approval — compare
      // the lot against the RESOLVED id, not the (absent) payload id.
      const pass = credit > 0 ? !!meta && meta.amount === credit && meta.openAmount === credit && meta.kind === (type === 'sale' ? 'credit_sale' : 'credit_purchase') && (type === 'sale' ? meta.customerId === (p.customerId ? String(p.customerId) : customer?.id ?? null) : meta.supplierId === (p.supplierId ? String(p.supplierId) : supplier?.id ?? null)) && meta.cashDelta === 0 && meta.dateSource === 'recorded_day' : !meta
      checks.push({ label: 'أصل الدين مرتبط بالبيع أو الشرا دون تكرار الفلوس', expected: String(credit), actual: String(meta?.openAmount ?? 0), pass })
    }
    if (verifySettlement) checks.push(...await verifySettlement())
    return checks
  }
}

async function prepareCashbookVerification(tx: Prisma.TransactionClient, businessId: string, ref: string, p: Record<string, unknown>): Promise<() => Promise<ExecOutcome['checks']>> {
  const amount = Number(p.amount)
  const beforeEntries = await tx.cashEntry.findMany({ where: { businessId } })
  const opening = (await tx.business.findUniqueOrThrow({ where: { id: businessId } })).openingCash
  const beforeCash = beforeEntries.reduce((s, e) => s + (e.direction === 'in' ? e.amount : -e.amount), opening)
  const kind = String(p.kind)
  const delta = ['receive', 'borrow', 'deposit'].includes(kind) ? amount : ['cash_purchase', 'pay', 'expense', 'withdrawal', 'lend'].includes(kind) ? -amount : kind === 'cash_count' ? amount - beforeCash : 0
  const customer = ['credit_sale', 'lend', 'receive'].includes(kind)
  const supplier = ['credit_purchase', 'cash_purchase', 'borrow', 'pay'].includes(kind)
  const before = customer ? await tx.customer.findFirst({ where: { businessId, ...(p.customerId ? { id: String(p.customerId) } : { name: String(p.partyName) }) } })
    : supplier ? await tx.supplier.findFirst({ where: { businessId, ...(p.supplierId ? { id: String(p.supplierId) } : { name: String(p.partyName) }) } }) : null
  const verifySettlement = ['receive', 'pay'].includes(kind) ? await prepareSettlementVerification(tx, businessId, ref, String(customer ? p.customerId : p.supplierId), customer, amount) : null
  return async () => {
    const entries = await tx.cashEntry.findMany({ where: { businessId, ref } })
    const net = entries.reduce((s, e) => s + (e.direction === 'in' ? e.amount : -e.amount), 0)
    const record = await tx.cashbookEntry.findFirst({ where: { businessId, operationRef: ref } })
    const checks: ExecOutcome['checks'] = [
      { label: 'دفتر الكاش مرتبط بنفس المرجع والأثر', expected: String(delta), actual: String(net), pass: entries.length === (delta === 0 ? 0 : 1) && net === delta && record?.cashDelta === delta },
      { label: 'المبلغ والتاريخ كما اعتمدتهم', expected: String(amount), actual: String(record?.amount), pass: record?.amount === amount && record?.kind === kind && record?.occurredOn === p.occurredOn && record?.dueOn === (p.dueOn ?? null) && record?.dateSource === (p.dateSource ?? 'user_day') },
    ]
    if (customer || supplier) {
      const party = customer ? await tx.customer.findFirst({ where: { businessId, id: record?.customerId ?? '' } }) : await tx.supplier.findFirst({ where: { businessId, id: record?.supplierId ?? '' } })
      const expected = (before?.balance ?? 0) + (['receive', 'pay'].includes(kind) ? -amount : kind === 'cash_purchase' ? 0 : amount)
      checks.push({ label: 'رصيد الدين مستقل عن الخزنة', expected: String(expected), actual: String(party?.balance), pass: party?.balance === expected })
    }
    if (verifySettlement) checks.push(...await verifySettlement())
    return checks
  }
}
