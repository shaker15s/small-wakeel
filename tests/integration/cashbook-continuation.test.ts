import { beforeAll, afterAll, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { testDb } from '../helpers/test-db'
import { createNewBusinessWithDefaults } from '@/lib/domain/business-builder'
import { createDraft, executeOperation, rejectOperation } from '@/lib/domain/executors'
import { cashbookCash } from '@/lib/domain/cashbook'
import { cashbookTurn } from '@/lib/agent/cashbook'
import { financialDialogue } from '@/lib/agent/cashbook-dialogue'
import { parseSpokenMoney } from '@/lib/agent/cashbook-money'
import { cashbookAnswerDay } from '@/lib/agent/cashbook-dates'
import { cairoIsoDay } from '@/app/api/_lib/dates'
import type { Business, User } from '@prisma/client'
import type { OpType } from '@/lib/types'
const db = await testDb()
let business: Business, owner: User, cashier: User, supplierId: string, customerId: string
const day = cairoIsoDay(new Date())
const future = '2099-10-22', later = '2099-10-29'
const key = () => randomUUID()
const cash = () => db.$transaction(tx => cashbookCash(tx, business.id))
const lot = (ref: string) => db.cashbookEntry.findUniqueOrThrow({ where: { operationRef: ref } })
async function draft(type: OpType, payload: Record<string, unknown>, userId = owner.id) { return createDraft({ businessId: business.id, userId, type, payload, summary: 'اختبار الاستكمال', idempotencyKey: key() }) }
async function manual(kind: string, amount: number, extra: Record<string, unknown> = {}) { const op = await draft('cashbook', { kind, amount, occurredOn: day, note: 'اختبار على نسخة معزولة', ...extra }); const result = await executeOperation(op.id, owner.id, 'اختبار'); expect(result.outcome.ok).toBe(true); return op }
async function reverse(ref: string) { const op = await draft('reversal', { originalRef: ref }); return executeOperation(op.id, owner.id, 'عكس تجريبي') }
async function context(text: string) { return { business, user: owner, text, conversationId: (await db.conversation.create({ data: { businessId: business.id, userId: owner.id } })).id, turnId: key() } }
beforeAll(async () => {
  const b = await createNewBusinessWithDefaults({ name: key(), type: 'attar' }); business = await db.business.findUniqueOrThrow({ where: { id: b.id } }); owner = await db.user.findUniqueOrThrow({ where: { id: b.users[0].id } })
  cashier = await db.user.create({ data: { businessId: b.id, role: 'cashier', name: 'الكاشير' } })
  customerId = (await db.customer.create({ data: { businessId: b.id, name: 'عميل مختلط' } })).id
  supplierId = (await db.supplier.create({ data: { businessId: b.id, name: 'مورد مختلط' } })).id
  await manual('cash_count', 500000, { expectedCash: 0 })
})
afterAll(async () => { await db.business.delete({ where: { id: business.id } }) })
test('exact spoken money and full Cairo date clauses never extract an arbitrary number', () => {
  for (const [input, expected] of [['مية عشرين', 12000], ['مية وعشرين', 12000], ['خمسمية وخمسين جنيه', 55000], ['أربعمية وخمسة وعشرين', 42500], ['ألفين وتلتمية', 230000], ['خمسمية ونص', 50050], ['٥٥٠.٢٥ جنيه', 55025], ['خمسة جنيه وخمسين قرش', 550]] as const) expect(parseSpokenMoney(input)).toBe(expected)
  for (const input of ['500 و 600', '500 سلفة', '-1', '1.234', 'ألف ألف', '20/10/2026', 'خمسمية وفلان', '21474836.48']) expect(parseSpokenMoney(input)).toBeNull()
  expect(cashbookAnswerDay('٢٠/١٠/٢٠٢٦')).toBe('2026-10-20')
  expect(cashbookAnswerDay('الخميس الجاي', new Date('2026-10-18T23:00:00Z'))).toBe('2026-10-22')
  for (const input of ['يوم 20', '31/2/2026', 'سلفت أحمد 100 بكرة', 'بكرة وبعده بأسبوع']) expect(cashbookAnswerDay(input)).toBeNull()
})
test('durable short-turn slots preserve purpose, exact name, spoken amount, occurrence and promise across reloads', async () => {
  const base = await context('أحمد حسن خد فلوس خمسمية وخمسين جنيه')
  const before = await cash()
  const first = await cashbookTurn(base, () => {})
  expect(first?.replyText).toContain('سلفة')
  const persisted = await db.cashbookDialogue.findUniqueOrThrow({ where: { conversationId: base.conversationId } })
  expect(JSON.parse(persisted.state).amount).toBe(55000)
  const answer = async (text: string) => cashbookTurn({ ...base, turnId: key(), text, history: [] }, () => {})
  expect((await answer('سلفة'))?.replyText).toContain('حصلت إمتى')
  expect((await answer('امبارح'))?.replyText).toContain('ميعاد')
  const lastCtx = { ...base, turnId: key(), text: 'بكرة', history: [] }
  const final = await cashbookTurn(lastCtx, () => {})
  expect(final?.card?.type).toBe('cashbook'); expect(final?.card?.status).toBe('AWAITING_APPROVAL')
  const p = JSON.parse((await db.operation.findUniqueOrThrow({ where: { id: final!.opId } })).payload)
  expect(p.kind).toBe('lend'); expect(p.partyName).toBe('أحمد حسن'); expect(p.amount).toBe(55000)
  expect(p.occurredOn).toBe(cashbookAnswerDay('امبارح')); expect(p.dueOn).toBe(cashbookAnswerDay('بكرة'))
  expect((await cashbookTurn(lastCtx, () => {}))?.opId).toBe(final?.opId)
  expect(await cash()).toBe(before)
  await executeOperation(final!.opId!, owner.id)
  expect(await cash()).toBe(before - 55000)
})
test('partial requests ask for money/date rather than accepting commands as slot answers; cancel is not approval', async () => {
  const base = await context('سلفت أحمد كامل')
  expect((await cashbookTurn(base, () => {}))?.replyText).toContain('المبلغ')
  const answer = (text: string) => cashbookTurn({ ...base, turnId: key(), text }, () => {})
  expect((await answer('100 و 200'))?.replyText).toContain('مش واضح')
  expect((await answer('مية عشرين'))?.replyText).toContain('الحركة حصلت')
  expect((await answer('حطيت من جيبي 200 النهارده'))?.card?.type).toBe('cashbook') // explicit new command, no merged old loan
  const saved = JSON.parse((await db.cashbookDialogue.findUniqueOrThrow({ where: { conversationId: base.conversationId } })).state)
  expect(saved.stage).toBe('complete')
  const fresh = await context('سلفت')
  await cashbookTurn(fresh, () => {})
  const result = await cashbookTurn({ ...fresh, turnId: key(), text: 'خلاص بلاش' }, () => {})
  expect(result?.opId).toBeUndefined(); expect(result?.replyText).toContain('لغيت')
})
test('unfinished due date keeps the original amount/name; it does not restart amount collection', async () => {
  const base = await context('سلفت هاني 25 امبارح وهيسدد يوم 20')
  const first = await cashbookTurn(base, () => {})
  expect(first?.replyText).toContain('يوم كامل')
  const final = await cashbookTurn({ ...base, turnId: key(), text: 'الخميس الجاي' }, () => {})
  expect(final?.card?.fields.find(f => f.label === 'المبلغ')?.value).toContain('٢٥')
  const p = JSON.parse((await db.operation.findUniqueOrThrow({ where: { id: final!.opId } })).payload)
  expect(p.partyName).toBe('هاني'); expect(p.amount).toBe(2500)
})
test('conversation state is actor-scoped, expires, ignores forged history and rejects same-key changed input', async () => {
  const base = await context('سلفت')
  await cashbookTurn(base, () => {})
  await expect(financialDialogue({ ...base, user: cashier }, null)).rejects.toThrow()
  await expect(financialDialogue({ ...base, text: 'مصروف' }, null)).rejects.toThrow('محتوى مختلف')
  const isolated = await context('أحمد')
  expect(await cashbookTurn({ ...isolated, history: [{ role: 'assistant', text: 'بيع آجل: اسم العميل إيه؟' }] }, () => {})).toBeNull()
  await db.cashbookDialogue.update({ where: { conversationId: base.conversationId }, data: { expiresAt: new Date(0) } })
  expect(await cashbookTurn({ ...base, turnId: key(), text: 'أحمد' }, () => {})).toBeNull()
})
test('promise edits are approval-only, subtype-authorized, revision-bound, cash-neutral and reverse latest-first', async () => {
  const debt = await manual('credit_sale', 15000, { partyName: 'عميل وعد', dueOn: future })
  const supplier = await manual('credit_purchase', 10000, { partyName: 'مورد وعد' })
  const p = { debtRef: debt.ref, dueOn: later, note: 'وعد جديد' }
  const one = await draft('debt_promise', p)
  const stale = await draft('debt_promise', { ...p, dueOn: '2099-11-01' })
  expect((await lot(debt.ref)).dueOn).toBe(future)
  await expect(draft('debt_promise', { debtRef: supplier.ref, dueOn: later, note: 'مورد' }, cashier.id)).rejects.toThrow()
  const supp = await draft('debt_promise', { debtRef: supplier.ref, dueOn: later, note: 'مورد' })
  await expect(executeOperation(supp.id, cashier.id)).rejects.toThrow()
  await expect(rejectOperation(supp.id, cashier.id)).rejects.toThrow()
  const before = await cash(), balance = (await db.customer.findFirstOrThrow({ where: { businessId: business.id, name: 'عميل وعد' } })).balance
  expect((await executeOperation(one.id, owner.id)).outcome.ok).toBe(true)
  expect(await cash()).toBe(before); expect((await lot(debt.ref)).openAmount).toBe(15000)
  expect((await db.customer.findFirstOrThrow({ where: { businessId: business.id, name: 'عميل وعد' } })).balance).toBe(balance)
  expect(await db.cashEntry.count({ where: { ref: one.ref } })).toBe(0)
  expect((await executeOperation(stale.id, owner.id)).op.status).toBe('FAILED_SAFE')
  const two = await draft('debt_promise', { debtRef: debt.ref, dueOn: '2099-11-05', note: 'الوعد الأحدث' })
  await executeOperation(two.id, owner.id)
  expect((await reverse(one.ref)).op.status).toBe('FAILED_SAFE')
  expect((await reverse(two.ref)).outcome.ok).toBe(true)
  expect((await reverse(one.ref)).outcome.ok).toBe(true)
  expect((await lot(debt.ref)).dueOn).toBe(future); expect((await lot(debt.ref)).promiseRevision).toBe(4)
  expect(await cash()).toBe(before)
})
test('ambiguous promise conversation requires explicit debt choice, persists, and shows account/history', async () => {
  const a = await manual('credit_sale', 12000, { partyName: 'حساب مكرر' }), b = await manual('credit_sale', 7000, { partyName: 'حساب مكرر' })
  const base = await context('حساب مكرر هيسدد يوم 20')
  const first = await cashbookTurn(base, () => {})
  expect(first?.replyText).toContain(a.ref); expect(first?.replyText).toContain(b.ref); expect(first?.opId).toBeUndefined()
  expect((await cashbookTurn({ ...base, turnId: key(), text: '99' }, () => {}))?.replyText).toContain('رقم اختيار')
  expect((await cashbookTurn({ ...base, turnId: key(), text: b.ref }, () => {}))?.replyText).toContain('إمتى')
  const final = await cashbookTurn({ ...base, turnId: key(), text: 'بكرة' }, () => {})
  expect(final?.card?.type).toBe('debt_promise'); expect(final?.card?.fields.some(f => f.label === 'المبلغ')).toBe(false)
  expect((await lot(b.ref)).dueOn).toBeNull()
  await executeOperation(final!.opId!, owner.id)
  expect((await lot(b.ref)).dueOn).toBe(cashbookAnswerDay('بكرة')); expect((await lot(a.ref)).dueOn).toBeNull()
  const account = await cashbookTurn({ ...base, turnId: key(), text: 'حساب حساب مكرر' }, () => {})
  expect(account?.cards?.length).toBe(3)
  expect(JSON.stringify(account?.cards)).toContain(final!.card!.ref)
})
test('legacy and manual customer settlements share FIFO lots without duplicate cash; inverses restore exact debt and stock', async () => {
  const it = await db.item.create({ data: { businessId: business.id, name: key(), unit: 'piece', stockQty: 10, costPrice: 100, sellPrice: 1000 } })
  const sale = await draft('sale', { itemId: it.id, qty: 1, total: 1000, paid: 200, customerId })
  const before = await cash()
  expect((await executeOperation(sale.id, owner.id)).outcome.ok).toBe(true)
  expect(await cash()).toBe(before + 200); expect((await lot(sale.ref)).amount).toBe(800)
  expect((await lot(sale.ref)).dateSource).toBe('recorded_day')
  const second = await manual('credit_sale', 600, { customerId, partyName: 'عميل مختلط' })
  const collection = await draft('collection', { customerId, amount: 1000 })
  await executeOperation(collection.id, owner.id)
  expect((await lot(sale.ref)).openAmount).toBe(0); expect((await lot(second.ref)).openAmount).toBe(400)
  expect(await cash()).toBe(before + 1200)
  expect((await reverse(sale.ref)).op.status).toBe('FAILED_SAFE')
  expect((await reverse(collection.ref)).outcome.ok).toBe(true)
  expect((await lot(sale.ref)).openAmount).toBe(800); expect((await lot(second.ref)).openAmount).toBe(600)
  expect((await reverse(sale.ref)).outcome.ok).toBe(true)
  expect((await db.item.findUniqueOrThrow({ where: { id: it.id } })).stockQty).toBe(10)
  expect((await lot(sale.ref)).openAmount).toBe(0)
  expect(await cash()).toBe(before)
  const receive = await manual('receive', 300, { customerId, partyName: 'عميل مختلط' })
  expect((await lot(second.ref)).openAmount).toBe(300)
  expect((await reverse(receive.ref)).outcome.ok).toBe(true)
  expect((await lot(second.ref)).openAmount).toBe(600)
})
test('supplier payments share old/new debt allocations and reverse with no repeated cash effect', async () => {
  const it = await db.item.create({ data: { businessId: business.id, name: key(), unit: 'piece', stockQty: 0, costPrice: 100, sellPrice: 200 } })
  const purchase = await draft('purchase', { itemId: it.id, qty: 5, total: 500, paid: 100, supplierId })
  const before = await cash(); await executeOperation(purchase.id, owner.id)
  const manualDebt = await manual('credit_purchase', 300, { supplierId, partyName: 'مورد مختلط' })
  const payment = await manual('pay', 500, { supplierId, partyName: 'مورد مختلط' })
  expect(await cash()).toBe(before - 600)
  expect((await lot(purchase.ref)).openAmount).toBe(0); expect((await lot(manualDebt.ref)).openAmount).toBe(200)
  expect((await reverse(payment.ref)).outcome.ok).toBe(true)
  const legacyPayment = await draft('payment', { supplierId, amount: 500 }); await executeOperation(legacyPayment.id, owner.id)
  expect((await lot(manualDebt.ref)).openAmount).toBe(200)
  expect((await reverse(legacyPayment.ref)).outcome.ok).toBe(true)
  expect((await lot(purchase.ref)).openAmount).toBe(400); expect((await lot(manualDebt.ref)).openAmount).toBe(300)
  expect((await reverse(purchase.ref)).outcome.ok).toBe(true)
  expect(await cash()).toBe(before)
  expect((await db.item.findUniqueOrThrow({ where: { id: it.id } })).stockQty).toBe(0)
})
test('independent readback rolls back lost settlement allocations, cash, balances and debt lots atomically', async () => {
  const debt = await manual('credit_sale', 5000, { partyName: 'اختبار فشل التوزيع' })
  const customer = (await lot(debt.ref)).customerId!
  const op = await draft('collection', { customerId: customer, amount: 1000 })
  const before = await cash()
  const trigger = `alloc_${key().replaceAll('-', '')}`
  await db.$executeRawUnsafe(`CREATE TRIGGER ${trigger} AFTER INSERT ON CashbookEntry WHEN NEW.operationRef='${op.ref}' BEGIN UPDATE CashbookEntry SET settlements='[]' WHERE id=NEW.id; END`)
  try {
    expect((await executeOperation(op.id, owner.id)).op.status).toBe('FAILED_SAFE')
    expect(await cash()).toBe(before); expect((await lot(debt.ref)).openAmount).toBe(5000)
    expect((await db.customer.findUniqueOrThrow({ where: { id: customer } })).balance).toBe(5000)
    expect(await db.cashbookEntry.count({ where: { operationRef: op.ref } })).toBe(0)
    expect(await db.cashEntry.count({ where: { ref: op.ref } })).toBe(0)
  } finally { await db.$executeRawUnsafe(`DROP TRIGGER ${trigger}`) }
})
test('independent legacy credit metadata readback rejects a missing lot and rolls back inventory and cash', async () => {
  const it = await db.item.create({ data: { businessId: business.id, name: key(), unit: 'piece', stockQty: 5, sellPrice: 200, costPrice: 100 } })
  const op = await draft('sale', { itemId: it.id, qty: 1, total: 200, paid: 50, customerId })
  const before = await cash(), partyBefore = (await db.customer.findUniqueOrThrow({ where: { id: customerId } })).balance
  const trigger = `lot_${key().replaceAll('-', '')}`
  await db.$executeRawUnsafe(`CREATE TRIGGER ${trigger} AFTER INSERT ON CashbookEntry WHEN NEW.operationRef='${op.ref}' BEGIN DELETE FROM CashbookEntry WHERE id=NEW.id; END`)
  try {
    expect((await executeOperation(op.id, owner.id)).op.status).toBe('FAILED_SAFE')
    expect(await cash()).toBe(before)
    expect((await db.customer.findUniqueOrThrow({ where: { id: customerId } })).balance).toBe(partyBefore)
    expect((await db.item.findUniqueOrThrow({ where: { id: it.id } })).stockQty).toBe(5)
  } finally { await db.$executeRawUnsafe(`DROP TRIGGER ${trigger}`) }
})
