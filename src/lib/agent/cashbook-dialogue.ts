import { parseFinancialCorrection, applyFinancialCorrection } from './cashbook-corrections'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireBusinessUser, AuthorizationError } from '@/lib/security/permissions'
import { containsMemorySecret } from './memory-policy'
import { normalizeAr, toWesternDigits } from './arabic'
import { cashbookDay, cashbookAnswerDay } from './cashbook-dates'
import { parseSpokenMoney } from './cashbook-money'
import type { CashbookIntent } from './cashbook-parser'
import { matchingParties, partySide, answerChoice, choiceActions, describeParties, reloadParty, type PartyChoice } from './cashbook-parties'
import type { CashbookKind } from '@/lib/domain/cashbook'
import type { ResultCardDTO, ChatActionDTO } from '@/lib/types'

export interface DialogueContext { business: { id: string }; user: { id: string }; conversationId: string; text: string; turnId?: string }
export interface DialogueState {
  flow: 'financial' | 'promise' | 'account' | 'restock'; stage: string; kind?: CashbookKind; partyName?: string; amount?: number; occurredOn?: string; dueOn?: string; reason?: string; source: string[]
  supersedesRef?: string;
  partyOptions?: PartyChoice[]; choiceToken?: string; customerId?: string; supplierId?: string; dateSource?: 'user_day' | 'assumed_today';
  reminderOptions?: { id: string; subject: string; revision: number }[];
  debtRef?: string; candidates?: string[]
}
export interface DialogueStep { replyText?: string; intent?: CashbookIntent; promise?: { debtRef: string; dueOn: string; note: string }; cards?: ResultCardDTO[]; actions?: ChatActionDTO[]; account?: PartyChoice }
interface Advance { state: DialogueState; step: DialogueStep }
/** Server-owned, actor/conversation-scoped state. No prompt markers or inferred assistant text are trusted. */
export async function withCashbookDialogue(ctx: DialogueContext, advance: (tx: Prisma.TransactionClient, state: DialogueState | null) => Promise<Advance | null>): Promise<DialogueStep | null> {
  return db.$transaction(async tx => {
    await requireBusinessUser(ctx.business.id, ctx.user.id, tx)
    if (!await tx.conversation.findFirst({ where: { id: ctx.conversationId, businessId: ctx.business.id, userId: ctx.user.id } })) throw new AuthorizationError()
    const row = await tx.cashbookDialogue.findUnique({ where: { conversationId: ctx.conversationId } })
    const live = !!row && row.expiresAt > new Date()
    if (live && ctx.turnId && row.lastTurnId === ctx.turnId) {
      if (row.lastInput !== ctx.text) throw new Error('نفس الرسالة اتبعتت بمحتوى مختلف؛ ابعتها كطلب جديد')
      return row.resolved ? JSON.parse(row.resolved) as DialogueStep : { replyText: row.lastReply }
    }
    let state: DialogueState | null = null
    if (live) { try { const value = JSON.parse(row.state) as DialogueState; if (['financial', 'promise', 'account', 'restock'].includes(value.flow) && Array.isArray(value.source)) state = value } catch { /* corrupt temporary state is never a financial instruction */ } }
    const result = await advance(tx, state)
    if (!result) return null
    if (result.step.replyText && !result.step.actions?.length) {
      const s = result.state
      const labels = s.flow === 'financial' ? s.stage === 'choose_party' ? (s.partyOptions ?? []).map((p, i) => `${i + 1}. ${p.name} · ${p.phone ?? p.id.slice(-6)}`) : slotOptions(s.stage)
        : s.flow === 'account' && s.stage === 'choose' ? (s.partyOptions ?? []).map((p, i) => `${i + 1}. ${p.side === 'customer' ? 'عميل' : 'مورد'} · ${p.phone ?? p.id.slice(-6)}`)
          : s.flow === 'promise' && s.stage === 'choose' ? (s.candidates ?? []).map((ref, i) => `${i + 1}. ${ref}`)
            : s.flow === 'promise' && s.stage === 'day' ? ['بكرة', 'بعد بكرة', 'الخميس الجاي'] : []
      if (labels.length) { s.choiceToken = crypto.randomUUID(); result.step.actions = choiceActions(s.choiceToken, labels) }
    }
    const data = { state: JSON.stringify(result.state), lastTurnId: ctx.turnId ?? null, lastInput: ctx.text, lastReply: result.step.replyText ?? '', resolved: JSON.stringify(result.step), expiresAt: new Date(Date.now() + 20 * 60_000) }
    await tx.cashbookDialogue.upsert({ where: { conversationId: ctx.conversationId }, create: { conversationId: ctx.conversationId, ...data }, update: { ...data, version: { increment: 1 } } })
    return result.step
  }, { maxWait: 10_000, timeout: 15_000 })
}
export function dialogueCanceled(text: string) { return /^(?:الغ|الغي|الغاء|خلاص بلاش|بلاش|سيبك|ابدا من جديد|مش عايز اسجل|لا تسجل)[.!\s]*$/.test(normalizeAr(text)) }
function partyNeeded(kind: CashbookKind) { return ['credit_sale', 'credit_purchase', 'cash_purchase', 'lend', 'borrow', 'receive', 'pay'].includes(kind) }
const debtKind = (kind: CashbookKind) => ['credit_sale', 'credit_purchase', 'lend', 'borrow'].includes(kind)
function next(s: DialogueState): DialogueStep {
  if (!s.kind) { s.stage = 'purpose'; return { replyText: 'الفلوس دي سلفة، ولا سداد، ولا مصروف، ولا سحب شخصي؟ هكمل معاك الاسم والمبلغ واليوم، ومفيش حاجة هتتسجل من غير مراجعتك.' } }
  if (partyNeeded(s.kind) && !s.partyName) { s.stage = 'party'; return { replyText: s.kind === 'credit_purchase' ? 'شراء آجل: اسم المورد إيه؟' : s.kind === 'credit_sale' ? 'بيع آجل: اسم العميل إيه؟' : s.kind === 'pay' || s.kind === 'cash_purchase' || s.kind === 'borrow' ? 'اسم المورد أو الشخص اللي علينا له إيه؟' : 'اسم العميل أو الشخص اللي لينا عنده إيه؟' } }
  if (s.amount == null) { s.stage = 'amount'; return { replyText: 'المبلغ كام جنيه؟ ممكن تكتبه أرقام أو تقول مثلًا «خمسمية وخمسين جنيه».' } }
  if (s.kind === 'expense' && !s.reason) { s.stage = 'reason'; return { replyText: 'المصروف كان مقابل إيه؟ قول بند واضح زي «إيجار المحل» أو «صيانة».' } }
  if (!s.occurredOn) { s.stage = 'day'; return { replyText: 'الحركة حصلت إمتى؟ النهارده، امبارح، أو تاريخ كامل يوم/شهر/سنة. يوم الحركة غير وقت دخوله في الدفتر.' } }
  if (debtKind(s.kind) && s.dueOn === undefined) { s.stage = 'due'; return { replyText: 'اتحدد ميعاد للسداد؟ قول التاريخ أو «مش متحدد». ما تحتاجش تعمل تذكير لوحدك؛ هتابع الميعاد بعد اعتماد الدين.' } }
  s.stage = 'complete'
  return { intent: { kind: s.kind, amount: s.amount, ...(partyNeeded(s.kind) ? { partyName: s.partyName } : {}), occurredOn: s.occurredOn, ...(s.dueOn ? { dueOn: s.dueOn } : {}), note: s.source.join('\n').slice(0, 1000), ...(s.reason ? { reason: s.reason } : {}), dateSource: s.dateSource ?? 'user_day', ...(s.customerId ? { customerId: s.customerId } : {}), ...(s.supplierId ? { supplierId: s.supplierId } : {}), ...(s.supersedesRef ? { supersedesRef: s.supersedesRef } : {}) } }
}
function slotOptions(stage: string) {
  return stage === 'purpose' ? ['سلفة', 'سداد', 'تحصيل', 'مصروف', 'سحب شخصي'] : stage === 'day' ? ['النهارده', 'امبارح', 'أول امبارح'] : stage === 'due' ? ['بكرة', 'بعد بكرة', 'مش متحدد'] : []
}
async function advanceFinancial(tx: Prisma.TransactionClient, businessId: string, s: DialogueState): Promise<Advance> {
  const step = next(s)
  if (step.intent) {
    const side = partySide(step.intent.kind)
    if (side && !s.customerId && !s.supplierId) {
      const parties = await matchingParties(tx, businessId, step.intent.partyName!, side)
      if (parties.length > 1) {
        s.stage = 'choose_party'; s.partyOptions = parties; s.choiceToken = crypto.randomUUID()
        return { state: s, step: { replyText: `في أكتر من حساب بنفس الاسم. حدد المقصود بالرقم أو الزر؛ مش هختار أول واحد:\n${describeParties(parties)}`, actions: choiceActions(s.choiceToken, parties.map((p, i) => `${i + 1}. ${p.name} · ${p.phone ?? p.id.slice(-6)}`)) } }
      }
      if (parties.length === 1) { const p = parties[0]; step.intent.partyName = p.name; step.intent[side === 'customer' ? 'customerId' : 'supplierId'] = p.id }
    }
  }
  if (step.replyText && slotOptions(s.stage).length) { s.choiceToken = crypto.randomUUID(); step.actions = choiceActions(s.choiceToken, slotOptions(s.stage)) }
  return { state: s, step }
}
function stateFromIntent(intent: CashbookIntent, text: string): DialogueState {
  return { flow: 'financial', stage: 'new', source: [intent.note || text], ...intent, occurredOn: intent.occurredOn ?? undefined, dueOn: intent.dueOn == null ? (intent.dueOn === null ? undefined : '') : intent.dueOn }
}
export async function financialDialogue(ctx: DialogueContext, parsed: CashbookIntent | 'ambiguous' | null) {
  const t = normalizeAr(toWesternDigits(ctx.text)).trim()
  const guided = /عايز اسجل بضاعه لعميل علي الحساب/.test(t) ? 'credit_sale' : /عايز اسجل بضاعه من مورد علي الحساب/.test(t) ? 'credit_purchase' : null
  const partial = t.match(/^(?:سجل )?(سلفت|استلفت من|حصلت من|سددت ل|سددت لـ)\s*(.*?)$/)
  const unknown = t.match(/^(.+?)\s+(?:خد|اخد)\s+فلوس(?:\s+(.+))?$/)
  const start = guided || partial || unknown || /عايز اسجل (?:سداد|فلوس خرجت)/.test(t)
  return withCashbookDialogue(ctx, async (tx, previous) => {
    if (dialogueCanceled(ctx.text) && previous?.stage !== 'complete') return { state: { flow: 'financial', stage: 'complete', source: [] }, step: { replyText: 'لغيت استكمال الطلب ده. مفيش فلوس اتغيرت؛ لو فيه مسودة اتجهزت قبل كده إلغاءها من بطاقتها.' } }
    if (containsMemorySecret(ctx.text) || /[؟?«»“”"]|^(لو|مثال|افترض|قال)\s/.test(t)) return null
    // New explicit requests supersede incomplete dialogue, never its facts or an existing draft.
    if (parsed && parsed !== 'ambiguous' && parsed.occurredOn && parsed.dueOn !== null) return advanceFinancial(tx, ctx.business.id, stateFromIntent(parsed, ctx.text))
    if (previous?.flow !== 'financial' && !start && !(parsed && parsed !== 'ambiguous')) return null
    let s: DialogueState | null = previous?.flow === 'financial' && previous.stage !== 'complete' ? previous : null
    const correction = parseFinancialCorrection(ctx.text)
    if (correction && s && !correction.ref) {
      const old: CashbookIntent = { ...s, kind: s.kind!, amount: s.amount!, occurredOn: s.occurredOn ?? null, note: s.source.join('\n') }
      const updated = applyFinancialCorrection(old, correction)
      if (typeof updated === 'string') return { state: s, step: { replyText: updated } }
      s = { ...s, ...updated, occurredOn: updated.occurredOn ?? undefined, dueOn: updated.dueOn ?? (correction.field === 'dueOn' ? '' : s.dueOn), source: [...s.source, ctx.text] }
      if (correction.field === 'partyName') { delete s.customerId; delete s.supplierId; delete s.partyOptions; delete s.choiceToken }
      return advanceFinancial(tx, ctx.business.id, s)
    }
    if (start || parsed && parsed !== 'ambiguous') {
      s = { flow: 'financial', stage: 'new', source: [ctx.text] }
      if (parsed && parsed !== 'ambiguous') {
        s = stateFromIntent(parsed, ctx.text)
        if (parsed.dueOn === null) s.stage = 'due'
      } else if (guided) s.kind = guided
      else if (partial) {
        s.kind = partial[1] === 'سلفت' ? 'lend' : partial[1] === 'استلفت من' ? 'borrow' : partial[1] === 'حصلت من' ? 'receive' : 'pay'
        const original = ctx.text.slice(ctx.text.lastIndexOf(' ') + 1)
        if (partial[2] && /^[\p{L} ]{1,60}$/u.test(partial[2]) && !/(?:امبارح|النهارده|بكره|يوم)/.test(partial[2]) && !partial[2].split(' ').some((_, i, words) => parseSpokenMoney(words.slice(i).join(' ')) != null)) s.partyName = ctx.text.replace(/^(?:سجل\s+)?(?:سلفت|استلفت\s+من|حصلت\s+من|سددت\s+لـ?)\s*/, '').trim() || original
      } else if (unknown) {
        s.partyName = ctx.text.slice(0, unknown[1].length).trim()
        if (unknown[2]) { const amount = parseSpokenMoney(unknown[2]); if (amount != null) s.amount = amount }
      }
      if (s.stage === 'due') return { state: s, step: { replyText: 'ميعاد الوعد محتاج يوم كامل. قول بكرة، الخميس الجاي، أو تاريخ يوم/شهر/سنة.' } }
      return advanceFinancial(tx, ctx.business.id, s)
    }
    if (!s || s.flow !== 'financial' || /[؟?]|^(?:حساب|وريني|مين|الخزنه|البضاعه|استلمنا|عايز اعرف|غير ميعاد)/.test(t)) return null
    s = { ...s, source: [...s.source, ctx.text].slice(-8) }
    let answerText = ctx.text
    let answerNormalized = t
    if (/^اختيار /.test(t) && s.stage !== 'choose_party') {
      const options = slotOptions(s.stage), selected = answerChoice(ctx.text, s.choiceToken!, options.length)
      if (selected.index == null) return { state: s, step: { replyText: 'الاختيار ده من سؤال قديم أو انتهى. جاوب آخر سؤال بوضوح؛ مفيش فلوس اتغيرت.' } }
      answerText = options[selected.index]; answerNormalized = normalizeAr(answerText)
    }
    if (s.stage === 'choose_party') {
      const answer = answerChoice(ctx.text, s.choiceToken!, s.partyOptions?.length ?? 0)
      if (answer.index == null) return { state: s, step: { replyText: answer.stale ? 'الاختيار ده من سؤال قديم. استخدم أحدث قائمة أو قول رقم المقصود.' : 'حدد رقم الحساب من القائمة. المبلغ واليوم محفوظين، ومفيش فلوس اتغيرت.' } }
      const selected = s.partyOptions![answer.index]
      const party = await reloadParty(tx, ctx.business.id, selected)
      if (!party || normalizeAr(party.name) !== normalizeAr(selected.name)) return { state: { ...s, stage: 'party', partyName: undefined, partyOptions: undefined }, step: { replyText: 'الحساب اتغير أو اتمسح؛ قول الاسم تاني نراجعه من السجل.' } }
      s[selected.side === 'customer' ? 'customerId' : 'supplierId'] = party.id; s.partyName = party.name
    } else if (s.stage === 'purpose') {
      if (/^(?:دي )?(?:سلفه|قرض)$/.test(answerNormalized)) s.kind = 'lend'
      else if (/^(?:دي )?(?:سداد|سددت)$/.test(answerNormalized)) s.kind = 'pay'
      else if (/^(?:دي )?(?:تحصيل|قبضت)$/.test(answerNormalized)) s.kind = 'receive'
      else if (/^(?:دي )?مصروف$/.test(answerNormalized)) { s.kind = 'expense'; delete s.partyName }
      else if (/^(?:دي )?سحب شخصي$/.test(answerNormalized)) { s.kind = 'withdrawal'; delete s.partyName }
      else return { state: s, step: { replyText: 'حدد الغرض بكلمة واضحة: سلفة، سداد، تحصيل، مصروف، أو سحب شخصي. مش هختار التصنيف من نفسي.' } }
    } else if (s.stage === 'party') {
      const short = toWesternDigits(ctx.text).match(/^([\p{L} ]{1,60}?)\s+(\d+(?:\.\d{1,2})?)\s*(?:جنيه)?(?:\s+(.*))?$/u)
      if (short) {
        const amount = parseSpokenMoney(short[2]); const rest = short[3] ?? ''
        const due = normalizeAr(rest).match(/(?:و?هيسدد|و?هيدفع|ميعاد السداد)\s+(.+)$/)
        const day = cashbookDay(due ? rest.slice(0, due.index) : rest, new Date(), false)
        if (amount == null || amount <= 0) return { state: s, step: { replyText: 'المبلغ غير صالح؛ قول مبلغ واحد بالجنيه.' } }
        s.partyName = short[1].trim(); s.amount = amount
        if (day) s.occurredOn = day
        if (due) { const date = cashbookAnswerDay(due[1]); if (date) s.dueOn = date }
        return advanceFinancial(tx, ctx.business.id, s)
      }
      if (!/^[\p{L} ]{1,60}$/u.test(ctx.text.trim()) || /(?:عايز|سجل|امبارح|النهارده|بكره|مش |لا )/.test(t)) return { state: s, step: { replyText: 'قول اسم صاحب الحساب بس، من غير المبلغ أو كلام تاني، عشان ما أخلطش بين اتنين.' } }
      s.partyName = ctx.text.trim()
    } else if (s.stage === 'amount') {
      const amount = parseSpokenMoney(ctx.text)
      if (amount == null || amount <= 0 && s.kind !== 'cash_count') return { state: s, step: { replyText: 'المبلغ مش واضح أو غير صالح. قول مبلغ واحد بالجنيه، زي ٥٥٠ أو «خمسمية وخمسين جنيه». مفيش فلوس اتغيرت.' } }
      s.amount = amount
    } else if (s.stage === 'reason') {
      if (ctx.text.trim().length < 2 || ctx.text.length > 160) return { state: s, step: { replyText: 'قول بند المصروف باختصار.' } }
      s.reason = ctx.text.trim()
    } else if (s.stage === 'day') {
      const day = cashbookAnswerDay(answerText)
      if (!day || day > cashbookDay('النهارده')!) return { state: s, step: { replyText: 'محتاج يوم حركة صحيح مش في المستقبل. قول النهارده، امبارح، أو تاريخ كامل.' } }
      s.occurredOn = day
    } else if (s.stage === 'due') {
      if (/^(?:مش متحدد|مش محدد|لسه|لا|مفيش|من غير ميعاد|بدون ميعاد)$/.test(answerNormalized)) s.dueOn = ''
      else {
        const due = cashbookAnswerDay(answerText)
        if (!due || s.occurredOn && due < s.occurredOn) return { state: s, step: { replyText: 'قول ميعاد صحيح بعد يوم الدين، أو «مش متحدد». مش هخمن شهر أو يوم.' } }
        s.dueOn = due
      }
    } else return null
    return advanceFinancial(tx, ctx.business.id, s)
  })
}
