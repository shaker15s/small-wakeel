import { requireBusinessUser, AuthorizationError } from '@/lib/security/permissions'
import { matchingParties, describeParties, choiceActions, answerChoice, reloadParty, type PartyChoice } from './cashbook-parties'
import { db } from '@/lib/db'
import { normalizeAr, toWesternDigits } from './arabic'
import { cashbookAnswerDay } from './cashbook-dates'
import { withCashbookDialogue, dialogueCanceled, type DialogueContext, type DialogueStep } from './cashbook-dialogue'
import { createDraft } from '@/lib/domain/executors'
import { CASHBOOK_LABELS, type CashbookKind } from '@/lib/domain/cashbook'
import { egp } from '@/lib/format'
import type { TurnEmit, TurnResult } from './harness'
import type { ActionCardDTO, ResultCardDTO } from '@/lib/types'

async function readAccount(ctx: DialogueContext, choice: PartyChoice): Promise<ResultCardDTO[]> {
  return db.$transaction(async tx => {
    const businessId = ctx.business.id
    await requireBusinessUser(businessId, ctx.user.id, tx)
    if (!await tx.conversation.findFirst({ where: { id: ctx.conversationId, businessId, userId: ctx.user.id } })) throw new AuthorizationError()
    const current = await reloadParty(tx, businessId, choice)
    if (!current) return [{ kind: 'text', title: 'الحساب اتغير', body: 'الحساب مش موجود دلوقتي؛ اطلب الحساب بالاسم من جديد.' }]
    const party = { ...current, side: choice.side }
    const entries = await tx.cashbookEntry.findMany({ where: { businessId: businessId, ...(party.side === 'customer' ? { customerId: party.id } : { supplierId: party.id }) }, include: { operation: true }, orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }], take: 40 })
    const refs = entries.map(e => e.operationRef)
    const changes = refs.length ? await tx.operation.findMany({ where: { businessId: businessId, type: 'debt_promise', status: 'SUCCEEDED', OR: refs.map(ref => ({ payload: { contains: `"debtRef":"${ref}"` } })) }, orderBy: { createdAt: 'desc' }, take: 40 }) : []
    const cards: ResultCardDTO[] = [
      { kind: 'kv', title: `حساب ${party.name}`, rows: [{ label: (party.balance < 0 ? party.side === 'customer' ? 'له عندنا حسب المسجل' : 'لينا عنده حسب المسجل' : party.side === 'customer' ? 'لينا عنده حسب المسجل' : 'علينا له حسب المسجل'), value: egp(Math.abs(party.balance)) }] },
      { kind: 'table', title: 'آخر ٤٠ حركة محفوظة للحساب', columns: [{ key: 'ref', label: 'المرجع' }, { key: 'day', label: 'اليوم ومصدره' }, { key: 'kind', label: 'الحركة' }, { key: 'amount', label: 'المبلغ' }, { key: 'remaining', label: 'المتبقي من الدين' }, { key: 'due', label: 'الوعد الحالي' }], rows: entries.map(e => ({ ref: e.operationRef, day: `${e.occurredOn}${e.dateSource === 'recorded_day' ? ' (يوم الإدخال؛ يوم الواقعة غير محدد)' : e.dateSource === 'assumed_today' ? ' (اليوم المفترض عند الطلب)' : ''}`, kind: `${CASHBOOK_LABELS[e.kind as CashbookKind] ?? e.kind}${e.operation.reversedByRef ? ' · معكوسة' : ''}`, amount: egp(e.amount), remaining: e.operation.reversedByRef ? 'معكوسة' : egp(e.openAmount), due: e.dueOn ?? 'مش متحدد' })) },
      { kind: 'table', title: 'تاريخ تعديلات الوعود · آخر ٤٠ تعديل', columns: [{ key: 'debt', label: 'أصل الدين' }, { key: 'previous', label: 'الوعد السابق' }, { key: 'current', label: 'الوعد الجديد' }, { key: 'status', label: 'الحالة' }, { key: 'ref', label: 'مرجع التعديل' }], rows: changes.map(op => { const p = JSON.parse(op.payload); return { debt: String(p.debtRef), previous: String(p.previousDueOn ?? 'مش متحدد'), current: String(p.dueOn), status: op.reversedByRef ? `معكوسة بـ${op.reversedByRef}` : 'معتمدة', ref: op.ref } }) },
    ]
    return cards
  })
}

/** Exact party/reference lookup. Multiple debts never silently pick the first promise date. */
export async function cashbookAccountTurn(ctx: DialogueContext, emit: TurnEmit): Promise<TurnResult | null> {
  const t = normalizeAr(toWesternDigits(ctx.text)).trim()
  const finish = (replyText: string, extra: Partial<TurnResult> = {}): TurnResult => { emit({ event: 'delta', text: replyText }); return { replyText, modelLabel: 'دفتر المحل · من السجل مباشرة', thinking: [], ...extra } }
  const promise = t.match(/^(.+?)\s+(?:وعد(?:ني)?(?: انه)? يسدد|هيسدد|هيدفع)\s+(.+)$/) ?? t.match(/^(?:غير|عدل|اجل)\s+ميعاد(?: سداد)?\s+(.+?)\s+(?:الي|لـ?)\s*(.+)$/)
  const lookup = t.match(/^(?:حساب|وريني حساب|كشف حساب)\s+(.+?)[؟?\s]*$/) ?? t.match(/^(.+?)\s+(?:عليه كام|عليها كام|له كام|ليه كام)[؟?\s]*$/)
  if (!lookup && !promise && /[؟?]|^(?:لو|افترض|مثال|قال)\s/.test(t)) return null
  if (promise && /[؟?«»“”"]|^(?:لو|افترض|مثال|قال)\s/.test(t)) return null
  const result = await withCashbookDialogue(ctx, async (tx, previous) => {
    if (lookup && !promise) {
      const target = lookup[1].replace(/^(?:المورد|العميل)\s+/, '').trim()
      const side = /^المورد\s/.test(lookup[1]) ? 'supplier' : /^العميل\s/.test(lookup[1]) ? 'customer' : undefined
      const hits = await matchingParties(tx, ctx.business.id, target, side)
      const state = { flow: 'account' as const, stage: hits.length > 1 ? 'choose' : 'complete', source: [ctx.text], partyOptions: hits, choiceToken: crypto.randomUUID() }
      if (!hits.length) return { state, step: { replyText: 'مفيش حساب مسجل بالاسم ده في المحل. قول الاسم زي ما اتسجل، ومش هخترع رصيد.' } }
      if (hits.length === 1) return { state, step: { account: hits[0] } }
      return { state, step: { replyText: `الاسم ده له أكتر من حساب. حدد الحساب بالرقم أو الزر، من غير خلط الأرصدة:\n${describeParties(hits)}`, actions: choiceActions(state.choiceToken, hits.map((p, i) => `${i + 1}. ${p.side === 'customer' ? 'عميل' : 'مورد'} · ${p.phone ?? p.id.slice(-6)}`)) } }
    }
    if (!promise && previous?.flow === 'account' && previous.stage === 'choose') {
      if (dialogueCanceled(ctx.text)) return { state: { ...previous, stage: 'complete' }, step: { replyText: 'تمام، لغيت اختيار الحساب؛ مفيش فلوس اتغيرت.' } }
      const answer = answerChoice(ctx.text, previous.choiceToken!, previous.partyOptions?.length ?? 0)
      if (answer.index == null) return { state: previous, step: { replyText: answer.stale ? 'الاختيار من قائمة قديمة؛ استخدم أحدث قائمة أو قول رقم الحساب.' : 'قول رقم الحساب من القائمة أو حدده بالزر. مش هجمع حسابين بنفس الاسم.' } }
      return { state: { ...previous, stage: 'complete' }, step: { account: previous.partyOptions![answer.index] } }
    }
    let s = previous?.flow === 'promise' && previous.stage !== 'complete' ? previous : null
    if (dialogueCanceled(ctx.text) && s) return { state: { ...s, stage: 'complete' }, step: { replyText: 'لغيت استكمال تعديل الميعاد. الميعاد الأصلي والفلوس زي ما هم.' } }
    if (promise) {
      const target = promise[1].trim(), explicit = /^wkl-\d+$/.test(target)
      const lots = await tx.cashbookEntry.findMany({ where: { businessId: ctx.business.id, openAmount: { gt: 0 }, kind: { in: ['credit_sale', 'credit_purchase', 'lend', 'borrow'] }, operation: { status: 'SUCCEEDED', reversedByRef: null }, ...(explicit ? { operationRef: target.toUpperCase() } : {}) }, orderBy: [{ occurredOn: 'asc' }, { recordedAt: 'asc' }] })
      const matching = explicit ? lots : lots.filter(e => normalizeAr(e.partyName) === target)
      if (!matching.length) return { state: { flow: 'promise', stage: 'complete', source: [ctx.text] }, step: { replyText: 'مفيش أصل دين مفتوح بالاسم أو المرجع ده. وريني الحساب الأول؛ مش هسجل وعد على مبلغ مش موجود.' } }
      s = { flow: 'promise', stage: matching.length === 1 ? 'day' : 'choose', source: [ctx.text], choiceToken: crypto.randomUUID(), candidates: matching.map(e => e.operationRef), ...(matching.length === 1 ? { debtRef: matching[0].operationRef } : {}) }
      const due = cashbookAnswerDay(promise[2])
      if (due) s.dueOn = due
      if (matching.length > 1) return { state: s, step: { replyText: `في أكتر من دين بالاسم ده. الوعد يخص أنهي واحد؟ قول رقم الاختيار أو المرجع:\n${matching.map((e, i) => `${i + 1}. ${e.operationRef} · ${e.customerId ? 'لينا' : 'علينا'} · يوم ${e.occurredOn} · باقي ${egp(e.openAmount)} · ميعاده ${e.dueOn ?? 'مش متحدد'}`).join('\n')}`, actions: choiceActions(s.choiceToken!, matching.map((e, i) => `${i + 1}. ${e.operationRef} · ${egp(e.openAmount)}`)) } }
    } else if (s?.stage === 'choose') {
      const answer = answerChoice(ctx.text, s.choiceToken!, s.candidates?.length ?? 0)
      const chosen = answer.index != null ? s.candidates?.[answer.index] : /^wkl-\d+$/.test(t) && s.candidates?.includes(t.toUpperCase()) ? t.toUpperCase() : null
      if (!chosen) return { state: s, step: { replyText: 'قول رقم اختيار من القائمة أو مرجع الدين نفسه؛ مش هختار أول حساب من نفسي.' } }
      s = { ...s, debtRef: chosen, stage: 'day', source: [...s.source, ctx.text] }
    } else if (s?.stage === 'day') {
      const options = ['بكرة', 'بعد بكرة', 'الخميس الجاي']
      const picked = /^اختيار /.test(t) ? answerChoice(ctx.text, s.choiceToken!, options.length) : null
      if (picked && picked.index == null) return { state: s, step: { replyText: 'الزر ده من سؤال قديم. قول الميعاد بالكتابة أو من أحدث سؤال.' } }
      const day = cashbookAnswerDay(picked ? options[picked.index!] : ctx.text)
      if (day) s = { ...s, dueOn: day, source: [...s.source, ctx.text] }
    } else return null
    if (!s.dueOn) { s.choiceToken = crypto.randomUUID(); return { state: s, step: { replyText: 'ميعاد الوعد إمتى بالضبط؟ قول بكرة، الخميس الجاي، أو تاريخ كامل يوم/شهر/سنة؛ مش هخمن شهر.', actions: choiceActions(s.choiceToken, ['بكرة', 'بعد بكرة', 'الخميس الجاي']) } } }
    const step: DialogueStep = { promise: { debtRef: s.debtRef!, dueOn: s.dueOn, note: s.source.join('\n').slice(0, 1000) } }
    return { state: { ...s, stage: 'complete' }, step }
  })
  if (!result) return null
  if (result.replyText) {
    if (result.actions?.length) emit({ event: 'actions', actions: result.actions })
    return finish(result.replyText, { actions: result.actions })
  }
  if (result.account) {
    const cards = await readAccount(ctx, result.account)
    emit({ event: 'cards', cards })
    return finish('ده حسابه من السجل. الوعد مش سداد؛ لو حصل دفع ولسه ما اتسجلش قولّي المبلغ ويومه نراجعه الأول.', { cards })
  }
  if (!result.promise) return null
  try {
    const p = result.promise
    const op = await createDraft({ businessId: ctx.business.id, userId: ctx.user.id, conversationId: ctx.conversationId, type: 'debt_promise', summary: `تعديل وعد سداد ${p.debtRef} إلى ${p.dueOn}`, payload: { ...p }, idempotencyKey: `promise:${ctx.conversationId}:${ctx.turnId ?? crypto.randomUUID()}` })
    if (op.status !== 'AWAITING_APPROVAL') return finish(`تعديل الوعد ${op.ref} اتعالج قبل كده؛ مش هكرره.`, { opId: op.id })
    const saved = JSON.parse(op.payload) as Record<string, unknown>
    const card: ActionCardDTO = { kind: 'draft', opId: op.id, ref: op.ref, type: 'debt_promise', risk: 'R2', status: 'AWAITING_APPROVAL', title: 'تعديل وعد السداد', summary: op.summary, fields: [{ label: 'الحساب', value: String(saved.partyName) }, { label: 'أصل الدين', value: String(saved.debtRef) }, { label: 'الموعد السابق', value: String(saved.previousDueOn ?? 'مش متحدد') }, { label: 'الموعد الجديد', value: String(saved.dueOn) }], effects: [], dangerNote: 'ده تغيير ميعاد بس، مش تحصيل ولا سداد. الخزنة والمبلغ المتبقي مش هيتغيروا.' }
    emit({ event: 'card', card })
    return finish('جهزت تعديل الوعد، راجع القديم والجديد واعتمد. بعد الاعتماد هتابع الميعاد الجديد؛ لسه مفيش ميعاد أو فلوس اتغيرت.', { card, opId: op.id })
  } catch (error) { return finish(`${error instanceof Error ? error.message : 'تعذر تجهيز تعديل الوعد'}؛ مفيش ميعاد أو فلوس اتغيرت.`) }
}
