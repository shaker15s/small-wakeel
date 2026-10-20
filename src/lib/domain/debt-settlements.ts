import type { Prisma } from '@prisma/client'
import { cairoIsoDay } from '@/app/api/_lib/dates'
import type { OpType } from '@/lib/types'
import { OperationValidationError } from './errors'

/** One allocation policy for cashbook and legacy approved collections/payments. */
export async function allocateDebtSettlement(tx: Prisma.TransactionClient, businessId: string, partyId: string, customer: boolean, amount: number) {
  const lots = await tx.cashbookEntry.findMany({ where: { businessId, ...(customer ? { customerId: partyId } : { supplierId: partyId }), openAmount: { gt: 0 }, operation: { status: 'SUCCEEDED', reversedByRef: null } }, orderBy: [{ occurredOn: 'asc' }, { recordedAt: 'asc' }, { id: 'asc' }] })
  const allocations: { id: string; amount: number }[] = []
  let left = amount
  for (const lot of lots) {
    const allocated = Math.min(left, lot.openAmount)
    if (!allocated) break
    await tx.cashbookEntry.update({ where: { id: lot.id }, data: { openAmount: { decrement: allocated } } })
    allocations.push({ id: lot.id, amount: allocated }); left -= allocated
  }
  return allocations
}

/** Mirror only debt metadata, never repeat the existing executor's cash/balance effects. */
export async function recordLegacyDebtEffects(tx: Prisma.TransactionClient, businessId: string, ref: string, type: OpType, p: Record<string, unknown>) {
  if (!['sale', 'purchase', 'collection', 'payment'].includes(type)) return
  const settlement = type === 'collection' || type === 'payment'
  const customer = type === 'sale' || type === 'collection'
  const amount = settlement ? Number(p.amount) : Number(p.total) - Number(p.paid)
  if (amount <= 0) return
  // R50: a credit draft may carry a TYPED NAME only (customer_add / new
  // supplier born at approval) — resolve it before mirroring the debt lot,
  // and skip quietly when there is genuinely no counterparty to mirror.
  let partyId = customer ? (p.customerId ? String(p.customerId) : null) : (p.supplierId ? String(p.supplierId) : null)
  if (!partyId) {
    const name = customer ? String(p.customerName ?? '') : String(p.supplierName ?? '')
    if (name.trim()) {
      const found = customer
        ? await tx.customer.findFirst({ where: { businessId, name: name.trim() } })
        : await tx.supplier.findFirst({ where: { businessId, name: name.trim() } })
      if (found) partyId = found.id
    }
  }
  if (!partyId) return
  const party = customer ? await tx.customer.findFirstOrThrow({ where: { businessId, id: partyId } }) : await tx.supplier.findFirstOrThrow({ where: { businessId, id: partyId } })
  const op = await tx.operation.findFirstOrThrow({ where: { businessId, ref } })
  const allocations = settlement ? await allocateDebtSettlement(tx, businessId, partyId, customer, amount) : []
  const cashDelta = settlement ? (customer ? amount : -amount) : 0
  await tx.cashbookEntry.create({ data: { businessId, operationRef: ref, userId: op.userId, kind: settlement ? (customer ? 'receive' : 'pay') : (customer ? 'credit_sale' : 'credit_purchase'), amount, partyName: party.name, customerId: customer ? partyId : null, supplierId: customer ? null : partyId, occurredOn: cairoIsoDay(new Date()), dateSource: 'recorded_day', note: `${op.summary}\nاليوم هو يوم التسجيل؛ المسار القديم لم يحدد يوم الواقعة.`, openAmount: settlement ? 0 : amount, cashDelta, settlements: JSON.stringify(allocations) } })
}

export async function prepareLegacyDebtReversal(tx: Prisma.TransactionClient, businessId: string, originalRef: string) {
  const lot = await tx.cashbookEntry.findFirst({ where: { businessId, operationRef: originalRef } })
  if (!lot || !['credit_sale', 'credit_purchase'].includes(lot.kind)) return
  if (lot.openAmount !== lot.amount) throw new OperationValidationError('الدين عليه سداد مسجل؛ اعكس السداد المرتبط الأول قبل عكس البيع أو الشرا')
  await tx.cashbookEntry.update({ where: { id: lot.id }, data: { openAmount: 0 } })
}

/** Snapshot allocations independently BEFORE effects; inspect every lot afterward. */
export async function prepareSettlementVerification(tx: Prisma.TransactionClient, businessId: string, ref: string, partyId: string, customer: boolean, amount: number) {
  const before = await tx.cashbookEntry.findMany({ where: { businessId, ...(customer ? { customerId: partyId } : { supplierId: partyId }), openAmount: { gt: 0 }, operation: { status: 'SUCCEEDED', reversedByRef: null } }, orderBy: [{ occurredOn: 'asc' }, { recordedAt: 'asc' }, { id: 'asc' }] })
  let left = amount
  const expected = before.map(lot => { const allocated = Math.min(left, lot.openAmount); left -= allocated; return { id: lot.id, before: lot.openAmount, allocated } })
  return async () => {
    const recorded = await tx.cashbookEntry.findFirst({ where: { businessId, operationRef: ref } })
    const after = await tx.cashbookEntry.findMany({ where: { businessId, id: { in: expected.map(lot => lot.id) } } })
    const desired = expected.filter(lot => lot.allocated > 0).map(lot => ({ id: lot.id, amount: lot.allocated }))
    const pass = !!recorded && recorded.amount === amount && recorded.settlements === JSON.stringify(desired) && expected.every(lot => after.find(a => a.id === lot.id)?.openAmount === lot.before - lot.allocated)
    return [{ label: 'السداد موزع على أصول الدين مرة واحدة وبالمبلغ الصحيح', expected: String(amount - left), actual: String(recorded ? (JSON.parse(recorded.settlements) as { amount: number }[]).reduce((s, a) => s + a.amount, 0) : 'سجل غير موجود'), pass }]
  }
}
