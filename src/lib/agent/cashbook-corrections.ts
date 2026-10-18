import { db } from '@/lib/db'
import { requireBusinessUser, AuthorizationError } from '@/lib/security/permissions'
import { containsMemorySecret } from './memory-policy'
import { normalizeAr, toWesternDigits } from './arabic'
import { originalName, type CashbookIntent } from './cashbook-parser'
import { cashbookAnswerDay, cashbookDay } from './cashbook-dates'
import { parseSpokenMoney } from './cashbook-money'

export interface FinancialCorrection { field: 'amount' | 'partyName' | 'occurredOn' | 'dueOn' | 'reason'; value: string; expected?: string; ref?: string }
/** A bounded field edit, not an instruction to execute or overwrite approved history. */
export function parseFinancialCorrection(text: string): FinancialCorrection | null {
  const t = normalizeAr(toWesternDigits(text))
  if (containsMemorySecret(text) || /[؟?«»“”"]|^(?:لو|افترض|مثال|قال)\s/.test(t)) return null
  const m = t.match(/^(?:لا[،,]?\s+)?(?:(?:عدل|صحح)\s+(?:(wkl-\d+)\s+)?)?(المبلغ|الاسم|يوم الحركه|ميعاد السداد|بند المصروف)\s+(?:(?:الصح|الجديد)\s+)?(?:(?:الي|هو|هي)\s+)?(.+)$/)
  if (!m) return null
  const contrasted = m[3].match(/^مش\s+(.+?)\s+(?:هو|هي|والصح)\s+(.+)$/)
  const value = contrasted ? contrasted[2] : m[3]
  const field = ({ المبلغ: 'amount', الاسم: 'partyName', 'يوم الحركه': 'occurredOn', 'ميعاد السداد': 'dueOn', 'بند المصروف': 'reason' } as const)[m[2] as 'المبلغ']
  return { field, value: originalName(text, value), ...(contrasted ? { expected: contrasted[1] } : {}), ...(m[1] ? { ref: m[1].toUpperCase() } : {}) }
}
function noPromise(text: string) { return /^(?:مش متحدد|مش محدد|بدون ميعاد|من غير ميعاد|مفيش)$/.test(normalizeAr(text)) }
export function applyFinancialCorrection(intent: CashbookIntent, correction: FinancialCorrection): CashbookIntent | string {
  const c = correction, p = { ...intent }
  if (c.expected != null) {
    const previous = c.field === 'amount' ? parseSpokenMoney(c.expected) : c.field === 'occurredOn' || c.field === 'dueOn' ? noPromise(c.expected) ? undefined : cashbookAnswerDay(c.expected) : normalizeAr(c.expected)
    const saved = c.field === 'partyName' || c.field === 'reason' ? normalizeAr(String(p[c.field] ?? '')) : p[c.field]
    if (previous !== saved) return 'القيمة القديمة اللي قلتها مش مطابقة للمسودة. حدد المرجع وراجع البطاقة؛ مش هعدل حركة غلط.'
  }
  if (c.field === 'amount') {
    const amount = parseSpokenMoney(c.value)
    if (amount == null || amount < (p.kind === 'cash_count' ? 0 : 1)) return 'قول مبلغ واحد صحيح بالجنيه؛ مش هختار أول رقم من كذا مبلغ.'
    p.amount = amount
  } else if (c.field === 'partyName') {
    if (!['credit_sale', 'credit_purchase', 'cash_purchase', 'lend', 'borrow', 'receive', 'pay'].includes(p.kind)) return 'الحركة دي مش على حساب شخص؛ راجع نوع الحركة بدل إضافة اسم وهمي.'
    if (!/^[\p{L}\p{N} .'-]{1,100}$/u.test(c.value)) return 'قول اسم الحساب فقط وباختصار.'
    p.partyName = c.value; delete p.customerId; delete p.supplierId
  } else if (c.field === 'reason') {
    if (p.kind !== 'expense' || c.value.length < 2 || c.value.length > 160) return 'بند المصروف يخص حركة مصروف وبوصف مختصر.'
    p.reason = c.value
  } else if (c.field === 'occurredOn') {
    const day = cashbookAnswerDay(c.value)
    if (!day || day > cashbookDay('النهارده')!) return 'حدد يوم حركة صحيح مش في المستقبل؛ مش هخمن يوم أو شهر.'
    p.occurredOn = day; p.dateSource = 'user_day'
  } else {
    if (!['credit_sale', 'credit_purchase', 'lend', 'borrow'].includes(p.kind)) return 'ميعاد السداد يخص أصل دين، مش تحصيل أو مصروف.'
    if (noPromise(c.value)) delete p.dueOn
    else { const day = cashbookAnswerDay(c.value); if (!day) return 'قول ميعاد كامل أو «مش متحدد».'; p.dueOn = day }
  }
  if (p.dueOn && p.occurredOn && p.dueOn < p.occurredOn) return 'الوعد هيبقى قبل يوم الحركة. راجع اليومين؛ ما غيرتش المسودة.'
  return p
}

export async function pendingCashbookCorrection(ctx: { business: { id: string }; user: { id: string }; conversationId: string; turnId?: string; text: string }, correction: FinancialCorrection): Promise<{ intent?: CashbookIntent; replyText?: string } | null> {
  return db.$transaction(async tx => {
    await requireBusinessUser(ctx.business.id, ctx.user.id, tx)
    if (!await tx.conversation.findFirst({ where: { id: ctx.conversationId, businessId: ctx.business.id, userId: ctx.user.id } })) throw new AuthorizationError()
    // Durable retry still finds the replacement after the old draft is canceled/approved.
    const replay = ctx.turnId ? await tx.operation.findUnique({ where: { idempotencyKey: `cashbook:${ctx.conversationId}:${ctx.turnId}` } }) : null
    if (replay && replay.businessId === ctx.business.id && replay.userId === ctx.user.id && replay.type === 'cashbook') return { intent: JSON.parse(replay.payload) as CashbookIntent }
    if (!correction.ref) {
      const row = await tx.cashbookDialogue.findUnique({ where: { conversationId: ctx.conversationId } })
      if (row && row.expiresAt > new Date()) { const state = JSON.parse(row.state); if (state.flow === 'financial' && state.stage !== 'complete') return null }
    }
    const candidates = await tx.operation.findMany({ where: { businessId: ctx.business.id, userId: ctx.user.id, conversationId: ctx.conversationId, type: 'cashbook', status: 'AWAITING_APPROVAL', ...(correction.ref ? { ref: correction.ref } : {}) }, orderBy: { createdAt: 'desc' }, take: 6 })
    if (!candidates.length) {
      // An unfinished slot dialogue can consume this correction without pretending a draft exists.
      const row = await tx.cashbookDialogue.findUnique({ where: { conversationId: ctx.conversationId } })
      if (!correction.ref && row && row.expiresAt > new Date()) { const state = JSON.parse(row.state); if (state.flow === 'financial' && state.stage !== 'complete') return null }
      return { replyText: 'مفيش مسودة منتظرة بالمقصود في المحادثة دي. الحركة المعتمدة تتصحح بعكس معتمد، مش بتغيير تاريخها أو مبلغها من ورا السجل.' }
    }
    if (candidates.length !== 1) return { replyText: `في أكتر من مسودة منتظرة. حدد المرجع، مثلًا «عدل ${candidates[0].ref} المبلغ 550». المراجع: ${candidates.map(p => p.ref).join('، ')}. مش هختار أحدث واحدة من نفسي.` }
    const old = candidates[0]
    const updated = applyFinancialCorrection(JSON.parse(old.payload) as CashbookIntent, correction)
    if (typeof updated === 'string') return { replyText: `${updated} مفيش فلوس اتغيرت.` }
    return { intent: { ...updated, supersedesRef: old.ref, note: `${updated.note}\nتصحيح المستخدم: ${ctx.text}`.slice(-1000) } }
  })
}
