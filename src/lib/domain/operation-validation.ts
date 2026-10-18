import { validateDebtPromise } from './debt-promises'
import { validateCashbook, cashbookCash } from './cashbook'
import type { Prisma } from '@prisma/client'
import type { OpType } from '@/lib/types'
import { OperationValidationError } from './errors'

const MAX_INT = 2_147_483_647
function integer(value: unknown, field: string, min = 0, max = MAX_INT): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new OperationValidationError(`قيمة ${field} غير صالحة`)
  }
  return value
}

/** Validate every referenced row BEFORE effects, within the executor transaction.
 * Also materialize defaults into the persisted payload so reversals undo the
 * actual approved amounts, not today's prices or an omitted paid field.
 */
export async function validateOperationPayload(
  tx: Prisma.TransactionClient, businessId: string, type: OpType, p: Record<string, unknown>, phase: 'forward' | 'reversal' = 'forward',
): Promise<void> {
  if (type === 'debt_promise') { await validateDebtPromise(tx, businessId, p); return }
  if (type === 'cashbook') { await validateCashbook(tx, businessId, p); return }
  for (const field of ['total', 'paid', 'amount', 'newPrice']) {
    if (p[field] != null) integer(p[field], field)
  }
  if (p.balance != null) integer(p.balance, 'balance', -MAX_INT)
  if (p.delta != null) integer(p.delta, 'delta', -MAX_INT)
  if (p.months != null) integer(p.months, 'months', type === 'membership' ? 1 : 0, 120)
  for (const field of ['itemId', 'customerId', 'supplierId']) {
    if (p[field] == null) continue
    const id = p[field]
    if (typeof id !== 'string' || !id) throw new OperationValidationError('معرّف غير صالح')
    const row = field === 'itemId' ? await tx.item.findFirst({ where: { id, businessId } })
      : field === 'customerId' ? await tx.customer.findFirst({ where: { id, businessId } })
      : await tx.supplier.findFirst({ where: { id, businessId } })
    if (!row) throw new OperationValidationError('المرجع غير موجود في النشاط الحالي')
  }
  if (type === 'sale' || type === 'purchase') {
    if (p.lines != null) {
      if (!Array.isArray(p.lines) || !p.lines.length || p.lines.length > 100) throw new OperationValidationError('بنود غير صالحة')
      const seen = new Set<string>()
      let total = 0
      for (const line of p.lines) {
        if (!line || typeof line !== 'object' || Array.isArray(line)) throw new OperationValidationError('بند غير صالح')
        const l = line as Record<string, unknown>
        if (typeof l.itemId !== 'string' || seen.has(l.itemId)) throw new OperationValidationError('صنف غير صالح أو مكرر')
        seen.add(l.itemId)
        const item = await tx.item.findFirst({ where: { id: l.itemId, businessId } })
        if (!item) throw new OperationValidationError('الصنف غير موجود في النشاط الحالي')
        const qty = integer(l.qty, 'qty', 1)
        const unitPrice = integer(l.unitPrice ?? (type === 'sale' ? item.sellPrice : item.costPrice), 'unitPrice', 1)
        const lineTotal = integer(qty * unitPrice, 'line.total', 1)
        if (l.total != null && integer(l.total, 'line.total', 1) !== lineTotal) throw new OperationValidationError('إجمالي البند لا يطابق الكمية والسعر')
        l.unitPrice = unitPrice
        l.total = lineTotal
        total += lineTotal
      }
      integer(total, 'total', 1)
      if (p.total != null && p.total !== total) throw new OperationValidationError('الإجمالي لا يطابق البنود')
      p.total = total
    } else {
      if (!p.itemId) throw new OperationValidationError('الصنف مطلوب')
      integer(p.qty, 'qty', 1)
      integer(p.total, 'total', 1)
    }
    p.paid = integer(p.paid ?? p.total, 'paid')
    if (Number(p.paid) > Number(p.total)) throw new OperationValidationError('المدفوع أكبر من الإجمالي')
    if (Number(p.paid) < Number(p.total) && !(type === 'sale' ? p.customerId : p.supplierId)) {
      throw new OperationValidationError('الحركة الآجلة محتاجة عميل أو مورد من النشاط الحالي')
    }
  }
  if (type === 'membership') {
    integer(p.total, 'total', 1)
    p.paid = integer(p.paid ?? p.total, 'paid')
    if (Number(p.paid) > Number(p.total)) throw new OperationValidationError('المدفوع أكبر من الإجمالي')
    if (!p.customerId && !String(p.customerName ?? '').trim()) throw new OperationValidationError('اسم العضو مطلوب')
  }
  if (type === 'expense') integer(p.total, 'total', 1)
  if (type === 'collection' || type === 'payment') {
    integer(p.amount, 'amount', 1)
    if (!(type === 'collection' ? p.customerId : p.supplierId)) throw new OperationValidationError('العميل أو المورد مطلوب')
  }
  if ((type === 'price_change' || type === 'stock_adjustment') && !p.itemId) throw new OperationValidationError('الصنف مطلوب')
  if (type === 'attendance' && !p.customerId) throw new OperationValidationError('العضو مطلوب')
  const business = await tx.business.findUniqueOrThrow({ where: { id: businessId } })
  if (business.workflowMode === 'cashbook' && phase === 'forward') {
    const out = type === 'purchase' ? Number(p.paid) : type === 'expense' ? Number(p.total) : type === 'payment' ? Number(p.amount) : 0
    if (out > 0 && await cashbookCash(tx, businessId) < out) throw new OperationValidationError('الخزنة لا تكفي؛ مش هنسجل رصيد بالسالب. عدّها أو سجّل مصدر الفلوس الأول')
  }
}
