import { beforeAll, afterAll, test, expect } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { Business, User } from '@prisma/client'
import { testDb } from '../helpers/test-db'
import { createNewBusinessWithDefaults } from '@/lib/domain/business-builder'
import { cashbookTurn, parseCashbook } from '@/lib/agent/cashbook'
import { createDraft, executeOperation } from '@/lib/domain/executors'
import { cashbookCash } from '@/lib/domain/cashbook'
import { cairoIsoDay } from '@/app/api/_lib/dates'
const db = await testDb()
let business: Business, owner: User, cashier: User
const today = cairoIsoDay(new Date())
const cash = () => db.$transaction(tx => cashbookCash(tx, business.id))
async function context() { return { business, user: owner, conversationId: (await db.conversation.create({ data: { businessId: business.id, userId: owner.id } })).id } }
async function command(base: Awaited<ReturnType<typeof context>>, text: string, turnId = randomUUID()) { return cashbookTurn({ ...base, text, turnId, history: [] }, () => {}) }
async function payload(id: string) { return JSON.parse((await db.operation.findUniqueOrThrow({ where: { id } })).payload) }
beforeAll(async () => {
  const b = await createNewBusinessWithDefaults({ name: randomUUID(), type: 'attar' })
  business = await db.business.findUniqueOrThrow({ where: { id: b.id } })
  owner = await db.user.findUniqueOrThrow({ where: { id: b.users[0].id } })
  cashier = await db.user.create({ data: { businessId: b.id, name: 'كاشير', role: 'cashier' } })
  const count = await createDraft({ businessId: b.id, userId: owner.id, type: 'cashbook', summary: 'عد اختبار معزول', idempotencyKey: randomUUID(), payload: { kind: 'cash_count', amount: 500000, expectedCash: 0, occurredOn: today, note: 'اختبار لا يمس البيانات الأصلية' } })
  await executeOperation(count.id, owner.id, 'عد اختبار')
})
afterAll(async () => { await db.business.delete({ where: { id: business.id } }) })

test('single-utterance spoken finance preserves original name, exact piastres, reason and dates', async () => {
  const base = await context(), before = await cash()
  const result = await command(base, 'سلفت أَحمد حَسن خمسمية وخمسين جنيه امبارح وهيسدد بكرة')
  expect(result?.card?.type).toBe('cashbook')
  expect(await payload(result!.opId!)).toMatchObject({ amount: 55000, partyName: 'أَحمد حَسن', dateSource: 'user_day' })
  expect(await cash()).toBe(before)
  const expense = await command(await context(), 'صرفت مية وعشرين جنيه بند صيانة التلاجة النهارده')
  expect(await payload(expense!.opId!)).toMatchObject({ kind: 'expense', amount: 12000, reason: 'صيانة التلاجة' })
  expect(expense?.card?.fields.find(f => f.label === 'بند المصروف')?.value).toBe('صيانة التلاجة')
  for (const text of ['سلفت أحمد مية مية', 'سلفت أحمد 100 و 200', 'سلفت أحمد 100.234', 'سلفت أحمد خمسمية؟', 'لو سلفت أحمد خمسمية', '«سلفت أحمد خمسمية»']) {
    const parsed = parseCashbook(text)
    expect(!parsed || parsed === 'ambiguous').toBe(true)
  }
})
test('implicit today is disclosed and persisted; explicit/incomplete Egyptian dates never turn into money', async () => {
  const implicit = await command(await context(), 'سلفت سامح مية وعشرين')
  expect(implicit?.card?.fields.find(f => f.label === 'يوم الحركة')?.hint).toContain('لأن اليوم ما اتقالش')
  expect((await payload(implicit!.opId!)).dateSource).toBe('assumed_today')
  await executeOperation(implicit!.opId!, owner.id)
  expect((await db.cashbookEntry.findUniqueOrThrow({ where: { operationRef: implicit!.card!.ref } })).dateSource).toBe('assumed_today')
  const base = await context()
  expect((await command(base, 'سلفت رامي خمسة جنيه يوم 20'))?.replyText).toContain('الحركة حصلت')
  const next = await command(base, today)
  expect(next?.card?.fields.find(f => f.label === 'المبلغ')?.value).toContain('٥')
})
test('correction before approval atomically replaces exactly one draft, retains history and is retry-safe', async () => {
  const base = await context(), before = await cash()
  const original = await command(base, 'سلفت عادل خمسمية النهارده')
  const id = randomUUID()
  const updated = await command(base, 'المبلغ مش خمسمية هو خمسمية وخمسين', id)
  expect(updated?.card?.supersedesRef).toBe(original!.card!.ref)
  expect(await payload(updated!.opId!)).toMatchObject({ amount: 55000, supersedesRef: original!.card!.ref, partyName: 'عادل' })
  expect((await db.operation.findUniqueOrThrow({ where: { id: original!.opId } })).status).toBe('CANCELLED')
  expect(await cash()).toBe(before)
  expect((await command(base, 'المبلغ مش خمسمية هو خمسمية وخمسين', id))?.opId).toBe(updated?.opId)
  expect(await db.operation.count({ where: { conversationId: base.conversationId } })).toBe(2)
  await expect(executeOperation(original!.opId!, owner.id)).rejects.toThrow()
  await executeOperation(updated!.opId!, owner.id)
  expect(await cash()).toBe(before - 55000)
  expect((await command(base, 'المبلغ 600'))?.replyText).toContain('بعكس معتمد')
  expect(await cash()).toBe(before - 55000)
})
test('failed correction leaves the old draft usable and never overwrites another pending operation', async () => {
  const base = await context()
  const original = await command(base, 'صرفت خمسين جنيه بند صيانة النهارده')
  expect((await command(base, 'المبلغ مش ستين هو سبعين'))?.replyText).toContain('مش مطابقة')
  expect((await command(base, 'المبلغ 999999'))?.replyText).toContain('لا تكفي')
  expect((await db.operation.findUniqueOrThrow({ where: { id: original!.opId } })).status).toBe('AWAITING_APPROVAL')
  const second = await command(base, 'صرفت عشرين جنيه بند نظافة النهارده')
  expect((await command(base, 'المبلغ ثلاثين'))?.replyText).toContain('أكتر من مسودة')
  const corrected = await command(base, `عدل ${second!.card!.ref} بند المصروف أكياس تعبئة`)
  expect(await payload(corrected!.opId!)).toMatchObject({ amount: 2000, reason: 'أكياس تعبئة' })
  expect((await db.operation.findUniqueOrThrow({ where: { id: original!.opId } })).status).toBe('AWAITING_APPROVAL')
})
test('corrections on an unfinished request change its slots, not a different pending card', async () => {
  const base = await context()
  const pending = await command(base, 'سلفت معتصم 25 النهارده')
  await command(base, 'سلفت تامر')
  expect((await command(base, 'المبلغ 550'))?.replyText).toContain('الحركة حصلت')
  expect((await command(base, 'امبارح'))?.replyText).toContain('ميعاد')
  const final = await command(base, 'مش متحدد')
  expect(await payload(final!.opId!)).toMatchObject({ partyName: 'تامر', amount: 55000 })
  expect((await db.operation.findUniqueOrThrow({ where: { id: pending!.opId } })).status).toBe('AWAITING_APPROVAL')
})
test('duplicate financial names require an explicit durable party choice; only that account changes', async () => {
  const a = await db.customer.create({ data: { businessId: business.id, name: 'أحمد مكرر', phone: '01011111111' } })
  const b = await db.customer.create({ data: { businessId: business.id, name: 'أحمد مكرر', phone: '01022222222' } })
  const base = await context()
  const first = await command(base, 'بعت لأحمد مكرر بضاعة بمية على الحساب امبارح')
  expect(first?.opId).toBeUndefined(); expect(first?.actions?.length).toBe(2)
  expect(first?.replyText).toContain(a.phone!); expect(first?.replyText).toContain(b.phone!)
  const options = first!.actions!
  const selectedIndex = options.findIndex(o => o.label.includes(b.phone!))
  const final = await command(base, options[selectedIndex].reply!)
  expect(await payload(final!.opId!)).toMatchObject({ customerId: b.id, amount: 10000 })
  await executeOperation(final!.opId!, owner.id)
  expect((await db.customer.findUniqueOrThrow({ where: { id: b.id } })).balance).toBe(10000)
  expect((await db.customer.findUniqueOrThrow({ where: { id: a.id } })).balance).toBe(0)
  expect((await command(base, options[selectedIndex].reply!))?.opId).toBeUndefined()
})
test('account lookup distinguishes customer/supplier and duplicate names with no invented combined balance', async () => {
  const base = await context()
  const c = await db.customer.create({ data: { businessId: business.id, name: 'اسم مشترك', balance: 12300, phone: '01033333333' } })
  await db.supplier.create({ data: { businessId: business.id, name: 'اسم مشترك', balance: 45600 } })
  const question = await command(base, 'حساب اسم مشترك')
  expect(question?.actions?.length).toBe(2)
  const index = question!.actions!.findIndex(a => a.label.includes(c.phone!))
  const answer = await command(base, question!.actions![index].reply!)
  expect(answer?.cards?.[0].kind).toBe('kv')
  expect(JSON.stringify(answer?.cards?.[0])).toContain('١٢٣')
  expect(JSON.stringify(answer?.cards?.[0])).not.toContain('٤٥٦')
  const before = await cash()
  await command(base, 'حساب المورد اسم مشترك')
  expect(await cash()).toBe(before)
})
test('stale choices, expired state and deleted parties cannot select a different account', async () => {
  const base = await context()
  const first = await command(base, 'حساب أحمد مكرر')
  const second = await command(base, 'حساب اسم مشترك')
  expect((await command(base, first!.actions![0].reply!))?.replyText).toContain('قديمة')
  expect((await command(base, first!.actions![0].reply!))?.cards).toBeUndefined()
  await db.cashbookDialogue.update({ where: { conversationId: base.conversationId }, data: { expiresAt: new Date(0) } })
  expect((await command(base, second!.actions![0].reply!))?.opId).toBeUndefined()
  const flow = await context()
  await command(flow, 'بعت لأحمد مكرر بضاعة بمية على الحساب النهارده')
  const state = JSON.parse((await db.cashbookDialogue.findUniqueOrThrow({ where: { conversationId: flow.conversationId } })).state)
  await db.customer.delete({ where: { id: state.partyOptions[0].id } })
  expect((await command(flow, '1'))?.replyText).toContain('اتغير أو اتمسح')
})
test('new financial commands escape unfinished promise/account choice without mixing the previous facts', async () => {
  const base = await context()
  await command(base, 'حساب اسم مشترك')
  const expense = await command(base, 'صرفت عشرة جنيه بند تغليف النهارده')
  expect(await payload(expense!.opId!)).toMatchObject({ kind: 'expense', amount: 1000 })
  const old = await command(base, 'بعت لجلال بضاعة بمية على الحساب امبارح')
  await executeOperation(old!.opId!, owner.id)
  expect((await command(base, 'جلال هيسدد يوم 20'))?.replyText).toContain('إمتى')
  expect((await command(base, 'سلفت عاصم'))?.replyText).toContain('المبلغ')
  expect((await command(base, 'خمسين'))?.replyText).toContain('الحركة حصلت')
  expect((await db.cashbookEntry.findUniqueOrThrow({ where: { operationRef: old!.card!.ref } })).dueOn).toBeNull()
})
test('replacement domain boundary rechecks permissions and conversation ownership and rolls back both drafts on failure', async () => {
  const base = await context()
  const original = await command(base, 'سلفت لطفي 50 النهارده')
  const input = { businessId: business.id, userId: owner.id, type: 'cashbook' as const, summary: 'تصحيح', conversationId: base.conversationId, replaceDraftRef: original!.card!.ref, payload: { kind: 'lend', amount: 6000, partyName: 'لطفي', occurredOn: today, note: 'تصحيح صريح' }, idempotencyKey: randomUUID() }
  await expect(createDraft({ ...input, userId: cashier.id, idempotencyKey: randomUUID() })).rejects.toThrow()
  await expect(createDraft({ ...input, conversationId: (await context()).conversationId, idempotencyKey: randomUUID() })).rejects.toThrow()
  const trigger = `replace_${randomUUID().replaceAll('-', '')}`
  await db.$executeRawUnsafe(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON Operation WHEN OLD.ref='${original!.card!.ref}' AND NEW.status='CANCELLED' BEGIN SELECT RAISE(ABORT, 'replacement failure'); END`)
  try {
    await expect(createDraft(input)).rejects.toThrow()
    expect(await db.operation.count({ where: { conversationId: base.conversationId } })).toBe(1)
    expect((await db.operation.findUniqueOrThrow({ where: { id: original!.opId } })).status).toBe('AWAITING_APPROVAL')
  } finally { await db.$executeRawUnsafe(`DROP TRIGGER ${trigger}`) }
})
test('purpose/day/promise quick replies are scoped to the current question, never an approval', async () => {
  const base = await context(), before = await cash()
  const purpose = await command(base, 'عاصم حسن خد فلوس خمسمية')
  expect(purpose?.actions?.find(a => a.label === 'سلفة')).toBeDefined()
  const day = await command(base, purpose!.actions!.find(a => a.label === 'سلفة')!.reply!)
  expect(day?.replyText).toContain('الحركة حصلت')
  const reprompt = await command(base, purpose!.actions![0].reply!)
  expect(reprompt?.opId).toBeUndefined()
  const due = await command(base, reprompt!.actions!.find(a => a.label === 'امبارح')!.reply!)
  const final = await command(base, due!.actions!.find(a => a.label === 'بكرة')!.reply!)
  expect(await payload(final!.opId!)).toMatchObject({ kind: 'lend', amount: 50000, partyName: 'عاصم حسن' })
  expect(await cash()).toBe(before)
})
test('due queries actually filter promise dates, not every balance or latest drawer entry', async () => {
  const base = await context(), before = await cash()
  const { cashbookAnswerDay } = await import('@/lib/agent/cashbook-dates')
  const saved: Record<string, string> = {}
  for (const [name, due] of [['وعد امبارح', cashbookAnswerDay('امبارح')], ['وعد النهارده', today], ['وعد بكرة', cashbookAnswerDay('بكرة')]] as const) {
    const op = await createDraft({ businessId: business.id, userId: owner.id, type: 'cashbook', summary: name, idempotencyKey: randomUUID(), payload: { kind: 'credit_sale', amount: 1000, partyName: name, occurredOn: cashbookAnswerDay('أول امبارح'), dueOn: due, note: 'وعد اختبار' } })
    await executeOperation(op.id, owner.id); saved[name] = op.ref
  }
  const overdue = JSON.stringify((await command(base, 'الديون المتأخرة'))?.cards)
  expect(overdue).toContain(saved['وعد امبارح']); expect(overdue).not.toContain(saved['وعد بكرة'])
  const now = JSON.stringify((await command(base, 'مين هيسدد النهارده'))?.cards)
  expect(now).toContain(saved['وعد النهارده']); expect(now).not.toContain(saved['وعد امبارح'])
  const tomorrow = JSON.stringify((await command(base, 'مين هيسدد بكرة'))?.cards)
  expect(tomorrow).toContain(saved['وعد بكرة']); expect(tomorrow).not.toContain(saved['وعد النهارده'])
  expect(await cash()).toBe(before)
})
