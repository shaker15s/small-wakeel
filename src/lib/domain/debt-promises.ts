import type { Prisma } from '@prisma/client'
import { AuthorizationError } from '@/lib/security/permissions'
import { canDraft } from './risk'
import { OperationValidationError } from './errors'
import { cashbookCash } from './cashbook'

export async function promiseTarget(tx: Prisma.TransactionClient, businessId: string, p: Record<string, unknown>) {
  if (typeof p.debtRef !== 'string') throw new OperationValidationError('حدد مرجع الدين المقصود')
  const entry = await tx.cashbookEntry.findFirst({ where: { businessId, operationRef: p.debtRef }, include: { operation: true } })
  if (!entry || !['credit_sale', 'credit_purchase', 'lend', 'borrow'].includes(entry.kind)) throw new OperationValidationError('الدين غير موجود في النشاط الحالي')
  return entry
}
export async function assertPromiseRole(tx: Prisma.TransactionClient, businessId: string, role: string, p: Record<string, unknown>) {
  const entry = await promiseTarget(tx, businessId, p)
  if (!canDraft(role, entry.supplierId ? 'payment' : 'collection')) throw new AuthorizationError()
}
export async function validateDebtPromise(tx: Prisma.TransactionClient, businessId: string, p: Record<string, unknown>) {
  const entry = await promiseTarget(tx, businessId, p)
  const party = entry.customerId ? await tx.customer.findFirst({ where: { id: entry.customerId, businessId } }) : await tx.supplier.findFirst({ where: { id: entry.supplierId ?? '', businessId } })
  if (entry.operation.status !== 'SUCCEEDED' || entry.operation.reversedByRef || entry.openAmount <= 0 || !party || party.balance <= 0) throw new OperationValidationError('الدين اتسدد أو اتعكس؛ راجع الحساب قبل تحديد وعد جديد')
  const day = p.dueOn
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day || day < entry.occurredOn) throw new OperationValidationError('ميعاد السداد غير صالح أو قبل يوم الدين')
  if (typeof p.note !== 'string' || !p.note.trim() || p.note.length > 1000) throw new OperationValidationError('وصف الوعد مطلوب')
  if (p.expectedRevision == null) {
    p.expectedRevision = entry.promiseRevision
    p.previousDueOn = entry.dueOn
    p.previousPromiseRef = entry.promiseRef
    p.previousFollowupUserId = entry.followupUserId
    p.partyName = entry.partyName
  }
  if (p.expectedRevision !== entry.promiseRevision || p.previousDueOn !== entry.dueOn || p.previousPromiseRef !== entry.promiseRef || p.previousFollowupUserId !== entry.followupUserId || p.partyName !== entry.partyName) throw new OperationValidationError('ميعاد الحساب اتغير بعد تجهيز المسودة؛ راجعه وجهز وعد جديد')
}
export async function executeDebtPromise(tx: Prisma.TransactionClient, businessId: string, ref: string, p: Record<string, unknown>) {
  const entry = await promiseTarget(tx, businessId, p)
  const actor = await tx.operation.findFirstOrThrow({ where: { ref, businessId } })
  await tx.cashbookEntry.update({ where: { id: entry.id }, data: { dueOn: String(p.dueOn), promiseRevision: { increment: 1 }, promiseRef: ref, followupUserId: actor.userId, lastNudgedOn: null } })
  const after = await tx.cashbookEntry.findUniqueOrThrow({ where: { id: entry.id } })
  const pass = after.dueOn === p.dueOn && after.promiseRevision === entry.promiseRevision + 1 && after.promiseRef === ref
  return { ok: pass, checks: [{ label: 'ميعاد الوعد اتحدث على أصل الدين', expected: String(p.dueOn), actual: after.dueOn ?? '', pass }], effects: [{ label: `وعد سداد ${entry.partyName} · ${entry.operationRef}`, value: String(p.dueOn), tone: 'neutral' as const }] }
}
/** Separate read-back proves a promise edit did not masquerade as a payment. */
export async function preparePromiseVerification(tx: Prisma.TransactionClient, businessId: string, ref: string, p: Record<string, unknown>) {
  const before = await promiseTarget(tx, businessId, p)
  const cash = await cashbookCash(tx, businessId)
  const party = before.customerId ? await tx.customer.findFirstOrThrow({ where: { businessId, id: before.customerId } }) : await tx.supplier.findFirstOrThrow({ where: { businessId, id: before.supplierId ?? '' } })
  return async () => {
    const after = await promiseTarget(tx, businessId, p)
    const balance = before.customerId ? (await tx.customer.findUniqueOrThrow({ where: { id: party.id } })).balance : (await tx.supplier.findUniqueOrThrow({ where: { id: party.id } })).balance
    return [
      { label: 'الوعد لا يحرك الخزنة أو رصيد الدين', expected: 'بلا أثر مالي', actual: 'قراءة مستقلة للأرصدة', pass: cash === await cashbookCash(tx, businessId) && balance === party.balance && after.openAmount === before.openAmount && await tx.cashEntry.count({ where: { businessId, ref } }) === 0 },
      { label: 'الوعد المعتمد مرتبط بالمرجع والمراجعة الصحيحة', expected: String(p.dueOn), actual: after.dueOn ?? '', pass: after.dueOn === p.dueOn && after.promiseRevision === before.promiseRevision + 1 && after.promiseRef === ref },
    ]
  }
}
export async function reverseDebtPromise(tx: Prisma.TransactionClient, businessId: string, ref: string, originalRef: string, p: Record<string, unknown>) {
  const entry = await promiseTarget(tx, businessId, p)
  if (entry.promiseRef !== originalRef || entry.dueOn !== p.dueOn) throw new OperationValidationError('الوعد اتغير بعد كده؛ اعكس آخر تعديل للميعاد الأول')
  const cashBefore = await cashbookCash(tx, businessId)
  const partyBefore = entry.customerId ? await tx.customer.findUniqueOrThrow({ where: { id: entry.customerId } }) : await tx.supplier.findUniqueOrThrow({ where: { id: entry.supplierId! } })
  await tx.cashbookEntry.update({ where: { id: entry.id }, data: { dueOn: p.previousDueOn == null ? null : String(p.previousDueOn), promiseRef: p.previousPromiseRef == null ? null : String(p.previousPromiseRef), followupUserId: p.previousFollowupUserId == null ? null : String(p.previousFollowupUserId), promiseRevision: { increment: 1 }, lastNudgedOn: null } })
  await tx.operation.update({ where: { ref: originalRef }, data: { reversedByRef: ref } })
  await tx.operation.update({ where: { ref }, data: { reversalOfRef: originalRef } })
  const after = await promiseTarget(tx, businessId, p)
  const partyAfter = entry.customerId ? await tx.customer.findUniqueOrThrow({ where: { id: entry.customerId } }) : await tx.supplier.findUniqueOrThrow({ where: { id: entry.supplierId! } })
  const pass = partyBefore.balance === partyAfter.balance && after.promiseRevision === entry.promiseRevision + 1 && after.followupUserId === (p.previousFollowupUserId ?? null) && await tx.cashEntry.count({ where: { businessId, ref } }) === 0 && after.dueOn === p.previousDueOn && after.promiseRef === p.previousPromiseRef && after.openAmount === entry.openAmount && cashBefore === await cashbookCash(tx, businessId)
  return { ok: pass, checks: [{ label: 'عكس الوعد مع الاحتفاظ بتاريخ التعديلات وبلا تحصيل', expected: String(p.previousDueOn ?? 'مش متحدد'), actual: after.dueOn ?? 'مش متحدد', pass }], effects: [{ label: 'استرجاع ميعاد السداد السابق', value: after.dueOn ?? 'مش متحدد', tone: 'neutral' as const }] }
}
