import { afterAll, beforeAll, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { testDb } from '../helpers/test-db'
import { createNewBusinessWithDefaults } from '@/lib/domain/business-builder'
import { createDraft, executeOperation } from '@/lib/domain/executors'
import { cashbookCash } from '@/lib/domain/cashbook'
import { runAgentTurn } from '@/lib/agent/harness'
import { cashbookDay, cashbookTurn, parseCashbook } from '@/lib/agent/cashbook'
import { runCashbookFollowups } from '@/lib/domain/cashbook-followups'
import { GET as getReports } from '@/app/api/reports/route'
import { getSnapshot } from '@/lib/agent/memory'
import { runReadTool } from '@/lib/agent/tools'
import { cairoIsoDay } from '@/app/api/_lib/dates'
const db = await testDb()
let id: string, owner: string, cashier: string, conv: string
const day = cairoIsoDay(new Date())
const yesterday = new Date(day + 'T12:00:00Z'); yesterday.setUTCDate(yesterday.getUTCDate() - 1)
const past = yesterday.toISOString().slice(0, 10)
beforeAll(async () => {
  const b = await createNewBusinessWithDefaults({ name: `cashbook-${randomUUID()}`, type: 'attar' })
  id = b.id; owner = b.users[0].id
  cashier = (await db.user.create({ data: { businessId: id, name: 'الكاشير', role: 'cashier' } })).id
  conv = (await db.conversation.create({ data: { businessId: id, userId: owner } })).id
})
afterAll(async () => { await db.business.delete({ where: { id } }) })
async function draft(kind: string, amount: number, extra: Record<string, unknown> = {}, actor = owner) {
  return createDraft({ businessId: id, userId: actor, type: 'cashbook', summary: kind, payload: { kind, amount, occurredOn: day, note: 'حركة حقيقية للاختبار على نسخة معزولة', ...extra }, idempotencyKey: randomUUID() })
}
async function execute(kind: string, amount: number, extra: Record<string, unknown> = {}) { const op = await draft(kind, amount, extra); const result = await executeOperation(op.id, owner, 'اختبار أثر محاسبي'); expect(result.outcome.ok).toBe(true); return result.op }
const cash = () => db.$transaction(tx => cashbookCash(tx, id))
test('manual shop starts blank and cannot spend unrecorded cash or unknown dates', async () => {
  expect((await db.business.findUniqueOrThrow({ where: { id } })).workflowMode).toBe('cashbook')
  expect(await cash()).toBe(0)
  await expect(draft('expense', 100)).rejects.toThrow('رصيد الخزنة غير معروف')
  await expect(draft('cash_count', -1, { expectedCash: 0 })).rejects.toThrow()
  await expect(draft('borrow', 100, { partyName: 'حسن', occurredOn: '2026-02-30' })).rejects.toThrow()
  await expect(draft('borrow', 100, { partyName: 'حسن', occurredOn: '2099-01-01' })).rejects.toThrow()
  expect(await db.cashEntry.count({ where: { businessId: id } })).toBe(0)
})
test('drawer count is approval-only, reconciles all cash readers, never creates a sale; stale counts fail atomically', async () => {
  const op = await draft('cash_count', 100000, { expectedCash: 0, expectedCashKnown: false })
  expect(await cash()).toBe(0)
  const result = await executeOperation(op.id, owner)
  expect(result.outcome.ok).toBe(true); expect(result.outcome.checks.length).toBeGreaterThanOrEqual(4)
  expect(await cash()).toBe(100000)
  expect(await db.operation.count({ where: { businessId: id, type: 'sale' } })).toBe(0)
  expect((await db.cashEntry.findFirstOrThrow({ where: { ref: op.ref } })).reason).toContain('ليس مبيعات')
  const stale = await draft('cash_count', 120000, { expectedCash: 100000, expectedCashKnown: true })
  await execute('expense', 1000)
  const fail = await executeOperation(stale.id, owner)
  expect(fail.op.status).toBe('FAILED_SAFE'); expect(await cash()).toBe(99000)
  expect(await db.cashbookEntry.count({ where: { operationRef: stale.ref } })).toBe(0)
  await expect(executeOperation(op.id, owner)).rejects.toThrow()
  expect(await db.cashbookEntry.count({ where: { operationRef: op.ref } })).toBe(1)
})
test('itemless credit sales/purchases, loans, repayments and occurrence/promise dates persist precisely', async () => {
  await execute('credit_sale', 50000, { partyName: 'أحمد', occurredOn: past, dueOn: day })
  await execute('credit_purchase', 80000, { partyName: 'حسن', occurredOn: past, dueOn: day })
  expect(await cash()).toBe(99000)
  await execute('lend', 10000, { partyName: 'أحمد' })
  expect(await cash()).toBe(89000)
  await execute('borrow', 20000, { partyName: 'حسن' })
  expect(await cash()).toBe(109000)
  const receipt = await execute('receive', 25000, { partyName: 'أحمد' })
  await execute('pay', 30000, { partyName: 'حسن' })
  expect(await cash()).toBe(104000)
  expect((await db.customer.findFirstOrThrow({ where: { businessId: id, name: 'أحمد' } })).balance).toBe(35000)
  expect((await db.supplier.findFirstOrThrow({ where: { businessId: id, name: 'حسن' } })).balance).toBe(70000)
  const lot = await db.cashbookEntry.findFirstOrThrow({ where: { businessId: id, kind: 'credit_sale' } })
  expect(lot.openAmount).toBe(25000); expect(lot.occurredOn).toBe(past); expect(lot.dueOn).toBe(day)
  expect(lot.recordedAt).toBeInstanceOf(Date)
  const allocations = JSON.parse((await db.cashbookEntry.findUniqueOrThrow({ where: { operationRef: receipt.ref } })).settlements)
  expect(allocations).toEqual([{ id: lot.id, amount: 25000 }])
  expect(await db.item.count({ where: { businessId: id } })).toBe(0)
  await expect(draft('receive', 35001, { partyName: 'أحمد' })).rejects.toThrow('أكبر')
})
test('unambiguous party references, integer money, tenant isolation and subtype permissions fail closed', async () => {
  for (const amount of [NaN, 1.1, Infinity, -1, 2147483648]) await expect(draft('deposit', amount)).rejects.toThrow()
  const before = await cash()
  await expect(draft('deposit', 10, {}, cashier)).rejects.toThrow()
  await expect(draft('credit_purchase', 10, { partyName: 'مورد' }, cashier)).rejects.toThrow()
  const foreign = await db.customer.findFirst({ where: { businessId: { not: id } } })
  if (foreign) await expect(draft('credit_sale', 100, { partyName: foreign.name, customerId: foreign.id })).rejects.toThrow()
  const duplicate = await db.customer.create({ data: { businessId: id, name: 'أحمد' } })
  await expect(draft('credit_sale', 100, { partyName: 'أحمد' })).rejects.toThrow('أكتر')
  await db.customer.delete({ where: { id: duplicate.id } })
  expect(await cash()).toBe(before)
})
test('debt reversals require restoring settlements first, preserve history, and verify inverse money', async () => {
  const debt = await execute('credit_sale', 1000, { partyName: 'محمود' })
  const receipt = await execute('receive', 500, { partyName: 'محمود' })
  const reverse = async (ref: string) => { const d = await createDraft({ businessId: id, userId: owner, type: 'reversal', summary: 'تصحيح', payload: { originalRef: ref }, idempotencyKey: randomUUID() }); return executeOperation(d.id, owner, 'تصحيح خطأ الإدخال') }
  expect((await reverse(debt.ref)).op.status).toBe('FAILED_SAFE')
  expect((await reverse(receipt.ref)).outcome.ok).toBe(true)
  expect((await db.cashbookEntry.findUniqueOrThrow({ where: { operationRef: debt.ref } })).openAmount).toBe(1000)
  expect((await reverse(debt.ref)).outcome.ok).toBe(true)
  expect((await db.customer.findFirstOrThrow({ where: { businessId: id, name: 'محمود' } })).balance).toBe(0)
  expect(await db.cashbookEntry.count({ where: { operationRef: { in: [debt.ref, receipt.ref] } } })).toBe(2)
})
test('concurrent outflows recheck available cash at approval, never go negative', async () => {
  const current = await cash()
  const a = await draft('withdrawal', current)
  const b = await draft('withdrawal', current)
  const results = await Promise.allSettled([executeOperation(a.id, owner, 'سحب'), executeOperation(b.id, owner, 'سحب')])
  expect(results.filter(r => r.status === 'fulfilled' && r.value.outcome.ok).length).toBe(1)
  expect(await cash()).toBe(0)
})
test('Cairo dates, Arabic piastres and ambiguity do not become invented financial effects', () => {
  expect(parseCashbook('باقي في الخزنة ١٢٣.٤٥')).toMatchObject({ kind: 'cash_count', amount: 12345 })
  expect(parseCashbook('بعت لأحمد بضاعة بـ٥٠٠ على الحساب امبارح وهيسدد بكرة')).toMatchObject({ kind: 'credit_sale', partyName: 'أحمد', amount: 50000, occurredOn: past })
  expect(parseCashbook('جبت بضاعة من حسن بـ800 على الحساب')).toMatchObject({ kind: 'credit_purchase', amount: 80000, partyName: 'حسن' })
  expect(parseCashbook('أحمد خد فلوس 500')).toBe('ambiguous')
  expect(parseCashbook('لو باقي في الخزنة 500؟')).toBeNull()
  expect(cashbookDay('يوم 15')).toBeNull()
  expect(cashbookDay('2026-10-01')).toBe('2026-10-01')
})
test('actual cashbook chat path needs no model; reminders survive later goods event and never record purchase', async () => {
  const business = await db.business.findUniqueOrThrow({ where: { id } }); const user = await db.user.findUniqueOrThrow({ where: { id: owner } })
  const turn = (text: string, turnId = randomUUID()) => runAgentTurn({ business, user, text, turnId, conversationId: conv, modelKey: 'nonexistent-no-inference', history: [] }, () => {})
  expect((await turn('البيض قرب يخلص فكرني أجيبه المرة الجاية'))?.replyText).toContain('هفتكر')
  const before = await cash()
  expect((await turn('استلمنا بضاعة'))?.replyText).toContain('البيض')
  expect(await db.shopReminder.count({ where: { businessId: id, active: true } })).toBe(1)
  expect((await turn('جبت البيض'))?.replyText).toContain('شلتها')
  expect(await db.shopReminder.count({ where: { businessId: id, active: true } })).toBe(0)
  expect(await cash()).toBe(before)
  const key = randomUUID()
  const first = await turn('باقي في الخزنة 700', key)
  const retry = await turn('باقي في الخزنة 700', key)
  expect(first?.opId).toBe(retry?.opId); expect(first?.card?.status).toBe('AWAITING_APPROVAL'); expect(await cash()).toBe(before)
})
test('overdue followups recheck actual balance, are once per Cairo day, never assume payment or mutate money', async () => {
  await execute('credit_sale', 4500, { partyName: 'متأخر', occurredOn: past, dueOn: past })
  const before = await cash()
  expect(await runCashbookFollowups()).toBeGreaterThanOrEqual(1)
  expect(await runCashbookFollowups()).toBe(0)
  const messages = await db.message.findMany({ where: { conversationId: conv, modelLabel: 'متابعة دفتر المحل · من السجل' } })
  expect(messages.some(m => m.text.includes('حصل سداد ولسه ما قلتليش؟'))).toBe(true)
  expect(await cash()).toBe(before)
  await execute('receive', 4500, { partyName: 'متأخر' })
  const tomorrow = new Date(); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
  const olderCount = await db.message.count({ where: { conversationId: conv } })
  await runCashbookFollowups(tomorrow)
  const after = await db.message.findMany({ where: { conversationId: conv }, orderBy: { createdAt: 'asc' }, skip: olderCount })
  expect(after.some(m => m.text.includes('«متأخر»'))).toBe(false)
})

test('count variance never becomes income/profit in API, snapshot or read tools', async () => {
  const response = await getReports(new Request(`http://localhost/api/reports?businessId=${id}&range=7d`, { headers: { 'x-wakil-business': id, 'x-wakil-user': owner } }))
  expect(response.status).toBe(200)
  const reports = await response.json()
  expect(reports.cashbookMode).toBe(true)
  expect(reports.totals.sales).toBe(54500) // credit sale + overdue sale only, excluding reversed sale and count
  expect(reports.totals.expenses).toBe(1000)
  const count = await db.cashbookEntry.findFirstOrThrow({ where: { businessId: id, kind: 'cash_count' } })
  expect(reports.totals.sales).not.toBe(count.amount)
  const snapshot = await getSnapshot(await db.business.findUniqueOrThrow({ where: { id } }))
  expect(snapshot.cash).toBe(await cash())
  const cards = await runReadTool('get_daily_summary', id)
  expect(JSON.stringify(cards)).toContain('مش حساب أرباح')
  expect(JSON.stringify(await runReadTool('get_profit_by_item', id))).toContain('مش كفاية')
})

test('cash goods purchase needs no items, reduces drawer, adds no supplier debt; inverse is exact', async () => {
  expect(parseCashbook('جبت بضاعة من حسن بـ٢٠ كاش')).toMatchObject({ kind: 'cash_purchase', partyName: 'حسن', amount: 2000 })
  const before = await cash()
  const owed = (await db.supplier.findFirstOrThrow({ where: { businessId: id, name: 'حسن' } })).balance
  const op = await execute('cash_purchase', 2000, { partyName: 'حسن' })
  expect(await cash()).toBe(before - 2000)
  expect((await db.supplier.findFirstOrThrow({ where: { businessId: id, name: 'حسن' } })).balance).toBe(owed)
  const inverse = await createDraft({ businessId: id, userId: owner, type: 'reversal', summary: 'تصحيح شراء كاش', payload: { originalRef: op.ref }, idempotencyKey: randomUUID() })
  expect((await executeOperation(inverse.id, owner, 'إدخال خاطئ')).outcome.ok).toBe(true)
  expect(await cash()).toBe(before)
  expect((await db.supplier.findFirstOrThrow({ where: { businessId: id, name: 'حسن' } })).balance).toBe(owed)
})

test('guided credit conversation, implicit shortage memory, no provider calls, and permissions use the real harness', async () => {
  const business = await db.business.findUniqueOrThrow({ where: { id } }); const user = await db.user.findUniqueOrThrow({ where: { id: owner } })
  const history: { role: string; text: string }[] = []
  const turn = async (text: string) => {
    const out = await runAgentTurn({ business, user, text, conversationId: conv, turnId: randomUUID(), history, modelKey: 'external:unreachable' }, () => {})
    expect(out.modelLabel).toBe('دفتر المحل · من السجل مباشرة')
    history.push({ role: 'user', text }, { role: 'assistant', text: out.replyText }); return out
  }
  const durations: number[] = []
  try {
    let start = performance.now()
    expect((await turn('عايز أسجل بضاعة لعميل على الحساب؛ اسألني الاسم والمبلغ واليوم')).replyText).toContain('بيع آجل:')
    durations.push(performance.now() - start); start = performance.now()
    const card = (await turn('محمد علي ٧٥ امبارح وهيسدد بكرة')).card
    expect(card?.type).toBe('cashbook'); expect(card?.fields.some(f => f.value === 'محمد علي')).toBe(true)
    expect(card?.fields.some(f => f.label === 'يوم الحركة' && f.value === past)).toBe(true)
    expect(card?.fields.some(f => f.label === 'ميعاد السداد')).toBe(true)
    durations.push(performance.now() - start); start = performance.now()
    await turn('السكر قرب يخلص')
    expect((await turn('البضاعة وصلت')).replyText).toContain('السكر')
    durations.push(performance.now() - start)
    const count = await db.shopReminder.count({ where: { businessId: id } })
    expect(await cashbookTurn({ business, user, text: 'لو الزيت قرب يخلص فكرني أجيبه المرة الجاية', conversationId: conv }, () => {})).toBeNull()
    expect(await db.shopReminder.count({ where: { businessId: id } })).toBe(count)
  } finally { /* no provider/model stubs: core path returns its own ledger label */ }
  console.log('CASHBOOK real local harness durations ms (not live model/microphone):', durations.map(n => Math.round(n)))
})
