import { allocateDebtSettlement } from './debt-settlements'
import { normalizeAr } from '@/lib/agent/arabic'
import type { Prisma } from '@prisma/client'
import { AuthorizationError } from '@/lib/security/permissions'
import { canDraft } from './risk'
import { OperationValidationError } from './errors'
import { cairoIsoDay as cairoDateKey } from '@/app/api/_lib/dates'

export const CASHBOOK_KINDS = ['credit_sale', 'credit_purchase', 'cash_purchase', 'lend', 'borrow', 'receive', 'pay', 'expense', 'withdrawal', 'deposit', 'cash_count'] as const
export type CashbookKind = typeof CASHBOOK_KINDS[number]
export const CASHBOOK_LABELS: Record<CashbookKind, string> = {
  cash_purchase: 'شراء بضاعة كاش',
  credit_sale: 'بضاعة للعميل على الحساب', credit_purchase: 'بضاعة من المورد على الحساب',
  lend: 'سلفة خرجت من الخزنة', borrow: 'سلفة دخلت الخزنة', receive: 'تحصيل من عميل', pay: 'سداد لمورد',
  expense: 'مصروف من الخزنة', withdrawal: 'سحب شخصي', deposit: 'إيداع من صاحب المحل', cash_count: 'عدّ الخزنة الفعلي',
}
const receivable = (kind: string) => ['credit_sale', 'lend', 'receive'].includes(kind)
const payable = (kind: string) => ['credit_purchase', 'cash_purchase', 'borrow', 'pay'].includes(kind)
const debt = (kind: string) => ['credit_sale', 'credit_purchase', 'lend', 'borrow'].includes(kind)
function validDay(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v
}
function fail(message: string): never { throw new OperationValidationError(message) }
export async function cashbookCash(tx: Prisma.TransactionClient, businessId: string) {
  const biz = await tx.business.findUniqueOrThrow({ where: { id: businessId } })
  const entries = await tx.cashEntry.findMany({ where: { businessId } })
  return entries.reduce((n, e) => n + (e.direction === 'in' ? e.amount : -e.amount), biz.openingCash)
}

export interface CashPositionEvidence {
  /** Owner-verifiable current balance; null until an opening figure or count establishes it. */
  cash: number | null
  /** Arithmetic ledger value, for internal reconciliation only. */
  ledgerCash: number
  openingCashKnown: boolean
  currentCashKnown: boolean
  cashIn: number
  cashOut: number
  /** Net discrepancy from counts performed against an already-known balance. */
  cashCountAdjustment: number
}

function countPayload(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function signedCash(entry: { direction: string; amount: number }): number {
  return entry.direction === 'in' ? entry.amount : -entry.amount
}

/**
 * The database's zero default is a storage detail, not an owner-stated fact.
 * Only an explicit onboarding answer or an approved, unreversed cash count can
 * make the current balance user-facing truth. Cash-count movements are kept
 * out of normal receipt/payment totals because they are reconciliation deltas,
 * never sales, receipts, or payments.
 */
export async function cashPositionEvidence(
  tx: Prisma.TransactionClient,
  businessId: string,
): Promise<CashPositionEvidence> {
  const [business, profile, cashEntries, countEntries] = await Promise.all([
    tx.business.findUniqueOrThrow({ where: { id: businessId }, select: { openingCash: true } }),
    tx.businessProfile.findUnique({ where: { businessId }, select: { openingCashStatedAt: true } }),
    tx.cashEntry.findMany({ where: { businessId }, select: { direction: true, amount: true, ref: true } }),
    tx.cashbookEntry.findMany({
      where: { businessId, kind: 'cash_count' },
      select: {
        operationRef: true,
        operation: { select: { reversedByRef: true, payload: true } },
      },
    }),
  ])

  // If a profile exists and its opening-cash marker is null, that explicit
  // unknown state overrides a leftover legacy numeric value in Business.
  const openingCashKnown = profile
    ? profile.openingCashStatedAt !== null
    : business.openingCash !== 0
  const activeCounts = countEntries.filter((entry) => entry.operation.reversedByRef === null)
  const currentCashKnown = openingCashKnown || activeCounts.length > 0
  const allCountRefs = countEntries.map((entry) => entry.operationRef)
  const reversals = allCountRefs.length
    ? await tx.operation.findMany({
        where: { businessId, reversalOfRef: { in: allCountRefs } },
        select: { ref: true, reversalOfRef: true },
      })
    : []
  const countFlowRefs = new Set<string>([
    ...allCountRefs,
    ...reversals.map((operation) => operation.ref),
  ])
  const knownCountRefs = new Set<string>()
  for (const entry of countEntries) {
    const payload = countPayload(entry.operation.payload)
    // Older entries without the new flag can be treated as a reconciliation
    // only when the business currently has a documented opening balance.
    if (payload.expectedCashKnown === true ||
        (payload.expectedCashKnown === undefined && openingCashKnown)) {
      knownCountRefs.add(entry.operationRef)
    }
  }
  const knownCountFlowRefs = new Set<string>([
    ...knownCountRefs,
    ...reversals
      .filter((operation) => operation.reversalOfRef != null && knownCountRefs.has(operation.reversalOfRef))
      .map((operation) => operation.ref),
  ])
  const ledgerCash = cashEntries.reduce((balance, entry) => balance + signedCash(entry), business.openingCash)
  const cashIn = cashEntries
    .filter((entry) => entry.direction === 'in' && !countFlowRefs.has(entry.ref ?? ''))
    .reduce((sum, entry) => sum + entry.amount, 0)
  const cashOut = cashEntries
    .filter((entry) => entry.direction === 'out' && !countFlowRefs.has(entry.ref ?? ''))
    .reduce((sum, entry) => sum + entry.amount, 0)
  const cashCountAdjustment = cashEntries
    .filter((entry) => knownCountFlowRefs.has(entry.ref ?? ''))
    .reduce((sum, entry) => sum + signedCash(entry), 0)

  return {
    cash: currentCashKnown ? ledgerCash : null,
    ledgerCash,
    openingCashKnown,
    currentCashKnown,
    cashIn,
    cashOut,
    cashCountAdjustment,
  }
}

/** Runs both at draft and approval. No floats, implicit party matching, or backdated drawer overwrite. */
export async function validateCashbook(tx: Prisma.TransactionClient, businessId: string, p: Record<string, unknown>) {
  const kind = String(p.kind)
  if (!CASHBOOK_KINDS.includes(kind as CashbookKind)) fail('نوع حركة دفتر الكاش غير معروف')
  if (typeof p.amount !== 'number' || !Number.isSafeInteger(p.amount) || p.amount < (kind === 'cash_count' ? 0 : 1) || p.amount > 2_147_483_647) fail('المبلغ لازم يكون رقم صحيح بالقروش ومش بالسالب')
  if (!validDay(p.occurredOn) || p.occurredOn > cairoDateKey(new Date())) fail('حدد يوم الحركة الصحيح؛ ما نسجلش حركة مالية في المستقبل')
  if (kind === 'cash_count' && p.occurredOn !== cairoDateKey(new Date())) fail('عدّ الخزنة بيظبط رصيد دلوقتي؛ العد القديم ملاحظة تاريخية مش تغيير للرصيد الحالي')
  if (p.dueOn != null && (!validDay(p.dueOn) || p.dueOn < p.occurredOn)) fail('ميعاد السداد لازم يكون تاريخ صحيح بعد يوم الحركة أو في نفس اليوم')
  if (p.dueOn != null && !debt(kind)) fail('ميعاد السداد يخص المديونية بس')
  if (p.dateSource != null && !['user_day', 'assumed_today'].includes(String(p.dateSource))) fail('مصدر يوم الحركة غير صالح')
  if (p.dateSource === 'assumed_today' && p.occurredOn !== cairoDateKey(new Date())) fail('اليوم المفترض بقى قديم؛ حدد يوم الحركة وراجعها من جديد')
  if (p.reason != null && (typeof p.reason !== 'string' || !p.reason.trim() || p.reason.length > 160)) fail('بند المصروف غير صالح')
  if (typeof p.note !== 'string' || p.note.length > 1000) fail('وصف الحركة طويل أو غير صالح')
  if (receivable(kind) || payable(kind)) {
    if (typeof p.partyName !== 'string' || !p.partyName.trim() || p.partyName.length > 100) fail('اسم صاحب الحساب مطلوب')
    if (receivable(kind) && p.supplierId || payable(kind) && p.customerId) fail('نوع صاحب الحساب لا يطابق اتجاه الدين')
    const field = receivable(kind) ? 'customerId' : 'supplierId'
    const candidates = receivable(kind)
      ? await tx.customer.findMany({ where: { businessId, ...(p[field] ? { id: String(p[field]) } : {}) } })
      : await tx.supplier.findMany({ where: { businessId, ...(p[field] ? { id: String(p[field]) } : {}) } })
    const rows = candidates.filter(row => p[field] || normalizeAr(row.name) === normalizeAr(String(p.partyName)))
    if (rows.length > 1) fail('في أكتر من حساب بنفس الاسم؛ حدد الشخص المقصود')
    if (p[field] && (!rows.length || normalizeAr(rows[0].name) !== normalizeAr(p.partyName.trim()))) fail('الحساب لا يطابق الاسم أو النشاط الحالي')
    if (rows[0]) { p[field] = rows[0].id; p.partyName = rows[0].name }
    if (kind === 'receive' || kind === 'pay') {
      if (!rows[0] || rows[0].balance < p.amount) fail('المبلغ أكبر من الدين المسجل؛ مش هسجل زيادة أو أعتبرها سداد تلقائي')
    }
  } else if (p.customerId || p.supplierId || p.partyName) fail('الحركة دي مش محتاجة حساب عميل أو مورد')
  const cash = await cashbookCash(tx, businessId)
  if (kind === 'cash_count') {
    if (typeof p.expectedCash !== 'number' || !Number.isSafeInteger(p.expectedCash)) fail('رصيد المقارنة مطلوب لعدّ الخزنة')
    if (cash !== p.expectedCash) fail('الخزنة اتحركت بعد تجهيز العد؛ اعمل عدّ جديد بدل ما نكتب فوق حركة أحدث')
  }
  if (['cash_purchase', 'pay', 'expense', 'withdrawal', 'lend'].includes(kind) && p.amount > cash) fail(`الخزنة المسجلة لا تكفي: ${cash / 100} جنيه. عدّ الفلوس أو سجّل مصدرها الأول؛ مش هسيب الرصيد بالسالب`)
}

type Check = { label: string; expected: string; actual: string; pass: boolean }
export async function executeCashbook(tx: Prisma.TransactionClient, businessId: string, ref: string, p: Record<string, unknown>) {
  const kind = p.kind as CashbookKind
  const amount = Number(p.amount)
  const cashBefore = await cashbookCash(tx, businessId)
  const delta = ['borrow', 'receive', 'deposit'].includes(kind) ? amount
    : ['cash_purchase', 'lend', 'pay', 'expense', 'withdrawal'].includes(kind) ? -amount
    : kind === 'cash_count' ? amount - cashBefore : 0
  const customer = receivable(kind)
  const supplier = payable(kind)
  let partyId: string | undefined
  let balanceBefore = 0
  if (customer || supplier) {
    const name = String(p.partyName).trim()
    if (customer) {
      const row = p.customerId ? await tx.customer.findFirstOrThrow({ where: { businessId, id: String(p.customerId) } }) : await tx.customer.create({ data: { businessId, name } })
      partyId = row.id; balanceBefore = row.balance; p.customerId = row.id
      await tx.customer.update({ where: { id: row.id }, data: { balance: { increment: debt(kind) ? amount : ['receive', 'pay'].includes(kind) ? -amount : 0 } } })
    } else {
      const row = p.supplierId ? await tx.supplier.findFirstOrThrow({ where: { businessId, id: String(p.supplierId) } }) : await tx.supplier.create({ data: { businessId, name } })
      partyId = row.id; balanceBefore = row.balance; p.supplierId = row.id
      await tx.supplier.update({ where: { id: row.id }, data: { balance: { increment: debt(kind) ? amount : ['receive', 'pay'].includes(kind) ? -amount : 0 } } })
    }
  }
  const settlements = kind === 'receive' || kind === 'pay' ? await allocateDebtSettlement(tx, businessId, partyId!, customer, amount) : []
  if (delta !== 0) await tx.cashEntry.create({ data: { businessId, ref, direction: delta > 0 ? 'in' : 'out', amount: Math.abs(delta), reason: kind === 'cash_count' ? 'فرق عدّ غير مصنّف — ليس مبيعات أو أرباح' : CASHBOOK_LABELS[kind] } })
  const operation = await tx.operation.findUniqueOrThrow({ where: { ref } })
  const entry = await tx.cashbookEntry.create({ data: {
    businessId, operationRef: ref, userId: operation.userId, kind, amount,
    partyName: String(p.partyName ?? ''), customerId: customer ? partyId : null, supplierId: supplier ? partyId : null,
    occurredOn: String(p.occurredOn), dateSource: String(p.dateSource ?? 'user_day'), dueOn: p.dueOn ? String(p.dueOn) : null, note: String(p.note),
    openAmount: debt(kind) ? amount : 0, cashDelta: delta, settlements: JSON.stringify(settlements),
  } })
  // Persist actual created party IDs for later reversal and evidence.
  await tx.operation.update({ where: { ref }, data: { payload: JSON.stringify(p) } })
  const cashAfter = await cashbookCash(tx, businessId)
  const check: Check[] = [{ label: 'الخزنة بعد الحركة', expected: String(cashBefore + delta), actual: String(cashAfter), pass: cashAfter === cashBefore + delta && cashAfter >= 0 }]
  if (partyId) {
    const row = customer ? await tx.customer.findUniqueOrThrow({ where: { id: partyId } }) : await tx.supplier.findUniqueOrThrow({ where: { id: partyId } })
    const expected = balanceBefore + (debt(kind) ? amount : ['receive', 'pay'].includes(kind) ? -amount : 0)
    check.push({ label: 'رصيد صاحب الحساب', expected: String(expected), actual: String(row.balance), pass: row.balance === expected })
  }
  check.push({ label: 'تاريخ الحركة ومرجعها محفوظين', expected: String(p.occurredOn), actual: entry.occurredOn, pass: entry.operationRef === ref && entry.occurredOn === p.occurredOn })
  return { ok: check.every(c => c.pass), checks: check, effects: [
    { label: CASHBOOK_LABELS[kind], value: `${amount / 100} جنيه`, tone: 'neutral' as const },
    { label: 'رصيد الخزنة المسجل', value: `${cashAfter / 100} جنيه`, tone: 'good' as const },
    ...(kind === 'cash_count' ? [{ label: 'فرق عدّ غير مصنّف (مش مبيعات)', value: `${delta / 100} جنيه`, tone: 'neutral' as const }] : []),
  ] }
}

/** Append an inverse; never delete or silently rewrite the original history. */
export async function reverseCashbook(tx: Prisma.TransactionClient, businessId: string, ref: string, originalRef: string) {
  const e = await tx.cashbookEntry.findFirstOrThrow({ where: { businessId, operationRef: originalRef } })
  if (debt(e.kind) && e.openAmount !== e.amount) fail('الدين عليه سداد؛ اعكس حركات السداد المرتبطة الأول')
  const cashBefore = await cashbookCash(tx, businessId)
  const original = await tx.operation.findFirstOrThrow({ where: { businessId, ref: originalRef } })
  const manual = original.type === 'cashbook' || (await tx.business.findUniqueOrThrow({ where: { id: businessId } })).workflowMode === 'cashbook'
  if (manual && cashBefore - e.cashDelta < 0) fail('عكس الحركة هيخلي الخزنة بالسالب؛ راجع الفلوس الأول')
  const adjustments = JSON.parse(e.settlements) as { id: string; amount: number }[]
  for (const a of adjustments) {
    const lot = await tx.cashbookEntry.findFirstOrThrow({ where: { id: a.id, businessId } })
    if (lot.openAmount + a.amount > lot.amount) fail('أرصدة السداد اتغيرت؛ راجع الحركة قبل العكس')
    await tx.cashbookEntry.update({ where: { id: lot.id }, data: { openAmount: { increment: a.amount } } })
  }
  const change = debt(e.kind) ? -e.amount : ['receive', 'pay'].includes(e.kind) ? e.amount : 0
  if (debt(e.kind)) {
    const party = e.customerId ? await tx.customer.findFirst({ where: { id: e.customerId, businessId } }) : await tx.supplier.findFirst({ where: { id: e.supplierId ?? '', businessId } })
    if (!party || party.balance < e.amount) fail('الرصيد اتغير أو حصل سداد من مسار تاني؛ راجع السداد الأول قبل عكس الدين')
  }
  const partyBefore = e.customerId ? await tx.customer.findFirstOrThrow({ where: { businessId, id: e.customerId } }) : e.supplierId ? await tx.supplier.findFirstOrThrow({ where: { businessId, id: e.supplierId } }) : null
  if (e.customerId) await tx.customer.update({ where: { id: e.customerId, businessId }, data: { balance: { increment: change } } })
  if (e.supplierId) await tx.supplier.update({ where: { id: e.supplierId, businessId }, data: { balance: { increment: change } } })
  await tx.cashbookEntry.update({ where: { id: e.id }, data: { openAmount: 0 } })
  if (e.cashDelta) await tx.cashEntry.create({ data: { businessId, ref, direction: e.cashDelta > 0 ? 'out' : 'in', amount: Math.abs(e.cashDelta), reason: `عكس ${originalRef}` } })
  await tx.operation.update({ where: { ref: originalRef }, data: { reversedByRef: ref } })
  await tx.operation.update({ where: { ref }, data: { reversalOfRef: originalRef } })
  const after = await cashbookCash(tx, businessId)
  const partyAfter = e.customerId ? await tx.customer.findFirstOrThrow({ where: { businessId, id: e.customerId } }) : e.supplierId ? await tx.supplier.findFirstOrThrow({ where: { businessId, id: e.supplierId } }) : null
  const partyCheck = { label: 'رصيد الحساب بعد عكس السداد أو الدين', expected: String((partyBefore?.balance ?? 0) + change), actual: String(partyAfter?.balance ?? 0), pass: !partyBefore || partyAfter?.balance === partyBefore.balance + change }
  return { ok: after === cashBefore - e.cashDelta && partyCheck.pass, checks: [partyCheck, ... [{ label: 'أثر عكس دفتر الكاش', expected: String(cashBefore - e.cashDelta), actual: String(after), pass: after === cashBefore - e.cashDelta }]], effects: [{ label: `عكس ${originalRef} بدون مسح التاريخ`, value: `${e.amount / 100} جنيه`, tone: 'neutral' as const }] }
}

export function assertCashbookRole(role: string, kind: unknown) {
  const operation = kind === 'credit_sale' ? 'sale' : kind === 'receive' ? 'collection' : kind === 'cash_count' ? 'sale'
    : ['credit_purchase', 'cash_purchase'].includes(String(kind)) ? 'purchase' : kind === 'pay' ? 'payment' : 'expense'
  if (!canDraft(role, operation)) throw new AuthorizationError()
}
