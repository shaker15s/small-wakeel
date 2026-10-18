import { cashbookDueQuery } from './cashbook-due'
import { parseFinancialCorrection, pendingCashbookCorrection } from './cashbook-corrections'
import { parseCashbook, startsCashbookRequest, type CashbookIntent } from './cashbook-parser'
import { cashbookAccountTurn } from './cashbook-accounts'
import { financialDialogue } from './cashbook-dialogue'
import { setWorkflow } from '@/lib/domain/workflow'
import type { Business, User } from '@prisma/client'
import { db } from '@/lib/db'
import { createDraft } from '@/lib/domain/executors'
import { cashbookCash, CASHBOOK_LABELS, type CashbookKind } from '@/lib/domain/cashbook'
import { computeRisk } from '@/lib/domain/risk'
import { restockTurn } from './shop-restock'
import { normalizeAr } from './arabic'
import { egp } from '@/lib/format'
import type { TurnEmit, TurnResult } from './harness'

export { cashbookDay } from './cashbook-dates'
export { parseCashbook, type CashbookIntent } from './cashbook-parser'

export async function cashbookTurn(ctx: { business: Business; user: User; text: string; conversationId: string; turnId?: string; history?: { role: string; text: string }[] }, emit: TurnEmit): Promise<TurnResult | null> {
  const { business, user, text } = ctx
  const t = normalizeAr(text)
  const finish = (replyText: string, rest: Partial<TurnResult> = {}): TurnResult => { emit({ event: 'delta', text: replyText }); return { replyText, modelLabel: 'دفتر المحل · من السجل مباشرة', thinking: [], ...rest } }
  if (/^(?:شغل|فعل) (?:دفتر الكاش|دفتر المحل)$/.test(t.trim())) {
    await setWorkflow(business.id, user.id, 'cashbook')
    return finish('شغلت دفتر الكاش والآجل. مش محتاج تسجل كل بيعة ولا QR. قولّي عدّ الخزنة، الديون والمصاريف؛ أي فلوس لازم تعتمد تسجيلها الأول.')
  }
  if (business.workflowMode === 'cashbook') {
    const restock = await restockTurn(ctx)
    if (restock?.replyText) {
      if (restock.actions?.length) emit({ event: 'actions', actions: restock.actions })
      return finish(restock.replyText, { actions: restock.actions })
    }
  }
  const due = await cashbookDueQuery(ctx)
  if (due) { emit({ event: 'cards', cards: due.cards }); return finish(due.replyText, { cards: due.cards }) }
  if (/^(?:دفتر المحل|وريني الدفتر|مين عليه فلوس|انا عليا كام)$/.test(t.trim())) {
    const [customers, suppliers, entries] = await Promise.all([
      db.customer.findMany({ where: { businessId: business.id, balance: { gt: 0 } }, orderBy: { balance: 'desc' }, take: 30 }),
      db.supplier.findMany({ where: { businessId: business.id, balance: { gt: 0 } }, orderBy: { balance: 'desc' }, take: 30 }),
      db.cashbookEntry.findMany({ where: { businessId: business.id, operation: { reversedByRef: null } }, orderBy: { recordedAt: 'desc' }, take: 30 }),
    ])
    const cards: NonNullable<TurnResult['cards']> = [{ kind: 'text', title: 'لينا وعَلينا حسب المسجل', body: `لينا: ${customers.map(c => `${c.name}: ${egp(c.balance)}`).join('، ') || 'مفيش ديون مسجلة'}\nعلينا: ${suppliers.map(s => `${s.name}: ${egp(s.balance)}`).join('، ') || 'مفيش ديون مسجلة'}` }, { kind: 'table', title: 'آخر ٣٠ حركة · يوم الحركة مش وقت إدخالها', columns: [{ key: 'day', label: 'يوم الحركة' }, { key: 'party', label: 'الحساب' }, { key: 'kind', label: 'الحركة' }, { key: 'amount', label: 'المبلغ' }, { key: 'due', label: 'ميعاد السداد' }, { key: 'ref', label: 'المرجع' }], rows: entries.map(e => ({ day: e.occurredOn, party: e.partyName || 'الخزنة', kind: CASHBOOK_LABELS[e.kind as CashbookKind] ?? e.kind, amount: egp(e.amount), due: e.dueOn ?? 'مش متحدد', ref: e.operationRef })) }]
    emit({ event: 'cards', cards })
    return finish('ده المسجل فعلًا، مش تأكيد إن حد لسه ما دفعش. لو حصل سداد ولسه ما اتسجلش قولّي نسجله بعد مراجعتك.', { cards })
  }
  if (business.workflowMode !== 'cashbook') return null
  let parsed = parseCashbook(text)
  const correction = parseFinancialCorrection(text)
  if (correction) {
    const edited = await pendingCashbookCorrection(ctx, correction)
    if (edited?.replyText) return finish(edited.replyText)
    if (edited?.intent) parsed = edited.intent
  }
  if (!correction && !startsCashbookRequest(text, parsed)) {
    const account = await cashbookAccountTurn(ctx, emit)
    if (account) return account
  }
  const dialogue = await financialDialogue(ctx, parsed)
  if (dialogue?.replyText) {
    if (dialogue.actions?.length) emit({ event: 'actions', actions: dialogue.actions })
    return finish(dialogue.replyText, { actions: dialogue.actions })
  }
  if (dialogue?.intent) parsed = dialogue.intent
  if (!parsed) return /^اختيار [a-z0-9-]+ رقم \d+$/.test(t) ? finish('الاختيار ده مش مرتبط بسؤال نشط دلوقتي. اطلب الحساب أو الحركة من جديد؛ مفيش فلوس اتغيرت.') : null
  if (parsed === 'ambiguous') return finish('عشان أسجل صح: دي بضاعة على الحساب، ولا سلفة، ولا سداد، ولا مصروف أو سحب شخصي؟ ولمين وبكام؟ مثلًا «سلفت أحمد ٥٠٠» أو «جبت بضاعة من حسن بـ٨٠٠ على الحساب». هسجل حركة واحدة واضحة كل مرة، ومفيش فلوس اتغيرت.')
  if (!parsed.occurredOn || parsed.dueOn === null) return finish('حدد التاريخ كامل بصيغة سنة-شهر-يوم، أو قول النهارده/امبارح للحركة وبكرة للسداد. مش هخمن يوم أو شهر؛ ومش هخترع ساعة لحدث قلتلي يومه بس.')
  const payload: Record<string, unknown> = { ...parsed, note: dialogue?.intent || correction ? parsed.note : text }
  if (parsed.dueOn === undefined) delete payload.dueOn
  try {
    if (parsed.kind === 'cash_count') payload.expectedCash = await db.$transaction(tx => cashbookCash(tx, business.id))
    const op = await createDraft({ businessId: business.id, userId: user.id, type: 'cashbook', summary: `${CASHBOOK_LABELS[parsed.kind]}${parsed.partyName ? ` · ${parsed.partyName}` : ''} · ${egp(parsed.amount)}`, payload, conversationId: ctx.conversationId, risk: computeRisk('cashbook', parsed.amount), idempotencyKey: `cashbook:${ctx.conversationId}:${ctx.turnId ?? crypto.randomUUID()}`, ...(parsed.supersedesRef ? { replaceDraftRef: parsed.supersedesRef } : {}) })
    if (op.status !== 'AWAITING_APPROVAL') return finish(`الحركة ${op.ref} حالتها ${op.status}؛ مش هكرر تسجيلها.`, { opId: op.id })
    const canonical = JSON.parse(op.payload) as CashbookIntent & { expectedCash?: number }
    Object.assign(parsed, canonical)
    if (canonical.expectedCash != null) payload.expectedCash = canonical.expectedCash
    const card: NonNullable<TurnResult['card']> = { kind: 'draft', opId: op.id, ref: op.ref, type: 'cashbook', risk: op.risk as 'R2' | 'R3', title: CASHBOOK_LABELS[parsed.kind], summary: op.summary, status: op.status as 'AWAITING_APPROVAL', ...(parsed.supersedesRef ? { supersedesRef: parsed.supersedesRef } : {}), fields: [
      { label: 'المبلغ', value: egp(parsed.amount) }, ...(parsed.partyName ? [{ label: 'صاحب الحساب', value: parsed.partyName }] : []),
      { label: 'يوم الحركة', value: parsed.occurredOn, hint: parsed.dateSource === 'assumed_today' ? 'اعتبرناها النهارده لأن اليوم ما اتقالش؛ راجعه قبل الاعتماد' : 'الساعة غير محددة؛ وقت الإدخال محفوظ لوحده' },
      ...(parsed.dueOn ? [{ label: 'ميعاد السداد', value: parsed.dueOn }] : []),
      ...(parsed.reason ? [{ label: 'بند المصروف', value: parsed.reason }] : []),
    ], effects: [], ...(parsed.kind === 'cash_count' ? { dangerNote: `المسجل قبل العد ${egp(Number(payload.expectedCash))}؛ الفرق ${egp(parsed.amount - Number(payload.expectedCash))} هيفضل «فرق عدّ غير مصنف»، مش مبيعات ولا أرباح.` } : {}) }
    emit({ event: 'card', card })
    return finish(`${parsed.supersedesRef ? `لغيت المسودة ${parsed.supersedesRef} واستبدلتها بالتفاصيل المصححة؛ مفيش فلوس اتغيرت. ` : ''}جهزت تسجيل ${CASHBOOK_LABELS[parsed.kind]}؛ راجع الاسم والمبلغ واليوم واعتمد. لسه مفيش رصيد اتغير.${parsed.dueOn ? ' بعد الاعتماد هتابع الميعاد وأسألك لو حصل سداد ولسه ما اتسجلش؛ مش هفترض إنه حصل.' : ''}`, { card, opId: op.id })
  } catch (error) {
    return finish(`${error instanceof Error ? error.message : 'تعذر تجهيز الحركة'} — مفيش فلوس اتغيرت.`)
  }
}
