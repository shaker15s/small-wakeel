import { afterAll, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { Business, User } from '@prisma/client'
import { testDb } from '../helpers/test-db'
import { createNewBusinessWithDefaults } from '@/lib/domain/business-builder'
import { cashbookTurn } from '@/lib/agent/cashbook'
import { runAgentTurn } from '@/lib/agent/harness'
import { buildMorningBrief } from '@/lib/agent/brief'
import { buildRadar } from '@/lib/agent/radar'
import { scanRisksAndOpportunities, getRecentBackgroundJobs, TaskManager } from '@/lib/agent/task-engine'
import { createDraft, executeOperation } from '@/lib/domain/executors'
import { cashbookCash } from '@/lib/domain/cashbook'
import { dayOffset } from '@/lib/agent/cashbook-dates'
import { cairoIsoDay } from '@/app/api/_lib/dates'
import { egp } from '@/lib/format'
const db = await testDb()
const ids: string[] = []
const today = cairoIsoDay(new Date()), yesterday = dayOffset(-1, new Date())
async function shop() {
  const created = await createNewBusinessWithDefaults({ name: `shop-assistant-${randomUUID()}`, type: 'attar' })
  ids.push(created.id)
  return {
    business: await db.business.findUniqueOrThrow({ where: { id: created.id } }),
    user: await db.user.findUniqueOrThrow({ where: { id: created.users[0].id } }),
  }
}
async function context(base: { business: Business; user: User }) {
  return { ...base, conversationId: (await db.conversation.create({ data: { businessId: base.business.id, userId: base.user.id } })).id }
}
const command = (base: Awaited<ReturnType<typeof context>>, text: string, turnId = randomUUID()) => cashbookTurn({ ...base, text, turnId, history: [] }, () => {})
const harness = (base: Awaited<ReturnType<typeof context>>, text: string) => runAgentTurn({ ...base, text, turnId: randomUUID(), history: [], modelKey: 'no-model-needed-for-real-shop-path' }, () => {})
async function money(base: Awaited<ReturnType<typeof shop>>) {
  return { cash: await db.$transaction(tx => cashbookCash(tx, base.business.id)), ops: await db.operation.count({ where: { businessId: base.business.id } }), entries: await db.cashEntry.count({ where: { businessId: base.business.id } }), items: await db.item.count({ where: { businessId: base.business.id } }) }
}
async function debt(base: Awaited<ReturnType<typeof shop>>, name: string, amount: number, dueOn?: string) {
  const op = await createDraft({ businessId: base.business.id, userId: base.user.id, type: 'cashbook', summary: 'دين في نسخة الاختبار', payload: { kind: 'credit_sale', partyName: name, amount, note: 'اختبار على نسخة معزولة', occurredOn: yesterday, ...(dueOn ? { dueOn } : {}) }, idempotencyKey: randomUUID() })
  expect((await executeOperation(op.id, base.user.id, 'اختبار معزول')).outcome.ok).toBe(true)
  return op
}
afterAll(async () => { await db.business.deleteMany({ where: { id: { in: ids } } }) })

test('real harness retains personal restock context across conversations; buttons finish only the checked item', async () => {
  const base = await shop(), first = await context(base)
  const before = await money(base)
  expect((await harness(first, 'البيض قرب يخلص فكرني أجيبه المرة الجاية')).replyText).toContain('هفتكر')
  expect((await harness(first, 'فكرني أجيب أَكياس تعبئة مع البضاعة')).replyText).toContain('أَكياس تعبئة')
  await harness(first, 'فكرني أجيب اكياس تعبئه مع البضاعة')
  expect(await db.shopReminder.count({ where: { businessId: base.business.id, active: true } })).toBe(2)
  const later = await context(base)
  const arrival = await harness(later, 'البضاعة وصلت')
  expect(arrival.replyText).toContain('البيض'); expect(arrival.replyText).toContain('أَكياس تعبئة')
  expect(arrival.actions?.length).toBe(3)
  const chosen = arrival.actions!.find(a => a.label === 'جبت البيض')!
  const next = await harness(later, chosen.reply!)
  expect(next.replyText).toContain('شلت «البيض»')
  expect(next.actions?.some(a => a.label === 'جبت البيض')).toBe(false)
  expect(await db.shopReminder.count({ where: { businessId: base.business.id, active: true } })).toBe(1)
  const stay = next.actions!.find(a => a.label === 'لسه محتاجهم')!
  expect((await harness(later, stay.reply!)).replyText).toContain('للبضاعة الجاية')
  expect(await db.shopReminder.count({ where: { businessId: base.business.id, active: true } })).toBe(1)
  expect(await money(base)).toEqual(before)
})

test('old buttons cannot clear a reactivated shortage, even from another still-live conversation; retries do not clear the next item', async () => {
  const base = await shop(), a = await context(base), b = await context(base)
  await command(a, 'فكرني أجيب البيض مع البضاعة')
  const old = await command(a, 'قائمة النواقص')
  await command(b, 'جبت البيض')
  await command(b, 'فكرني أجيب البيض مع البضاعة')
  const current = await command(a, old!.actions!.find(a => a.label === 'جبت البيض')!.reply!)
  expect(current?.replyText).toContain('القائمة اتغيرت')
  expect(await db.shopReminder.count({ where: { businessId: base.business.id, active: true } })).toBe(1)
  await command(b, 'فكرني أجيب أكياس تعبئة مع البضاعة')
  const list = await command(a, 'قائمة النواقص'), turn = randomUUID()
  const answer = list!.actions!.find(a => a.label === 'جبت البيض')!.reply!
  const result = await command(a, answer, turn)
  expect((await command(a, answer, turn))?.replyText).toBe(result?.replyText)
  expect(await db.shopReminder.count({ where: { businessId: base.business.id, active: true } })).toBe(1)
  const stale = await command(a, answer)
  expect(stale?.replyText).toContain('قديم')
  expect(await db.shopReminder.count({ where: { businessId: base.business.id, active: true } })).toBe(1)
})

test('restock choices are actor/conversation scoped, recheck live permissions, and never consume a new purchase', async () => {
  const base = await shop(), a = await context(base)
  await command(a, 'فكرني أجيب سكر مع البضاعة')
  const list = await command(a, 'استلمنا بضاعة')
  const other = await shop(), foreign = await context(other)
  expect((await command(foreign, list!.actions![0].reply!))?.replyText).toContain('مش مرتبط')
  expect((await command(foreign, 'قائمة النواقص'))?.replyText).not.toContain('«سكر»')
  await expect(command({ ...foreign, conversationId: a.conversationId }, 'قائمة النواقص')).rejects.toThrow()
  const cashier = await db.user.create({ data: { businessId: base.business.id, name: 'كاشير', role: 'cashier' } })
  const staff = await context({ ...base, user: cashier })
  await expect(command(staff, 'فكرني أجيب سكر مع البضاعة')).rejects.toThrow('صلاحيتك')
  expect((await command(staff, 'قائمة النواقص'))?.replyText).not.toContain('«سكر»')
  // Membership/role changed since the server emitted the button.
  await db.user.update({ where: { id: base.user.id }, data: { role: 'cashier' } })
  await expect(command(a, list!.actions![0].reply!)).rejects.toThrow('صلاحيتك')
  expect(await db.shopReminder.count({ where: { businessId: base.business.id, active: true } })).toBe(1)
  await db.user.update({ where: { id: base.user.id }, data: { role: 'owner' } })
  const purchase = await command(a, 'جبت بضاعة من حسن بمية على الحساب النهارده')
  expect(purchase?.card?.title).toContain('بضاعة من المورد')
  expect(await db.shopReminder.count({ where: { businessId: base.business.id, active: true } })).toBe(1)
})

test('reported or explicit shortages are not learned from questions, hypotheticals, secrets, quotations or money clauses', async () => {
  const base = await shop(), ctx = await context(base)
  for (const text of ['لو البيض ناقص', 'البيض ناقص؟', 'قال البيض ناقص', '«البيض ناقص»', 'مش البيض ناقص', 'فكرني أجيب رمز الدخول 123456', 'فكرني أجيب سكر وبعت بضاعة بمية جنيه', 'البيض قرب يخلص وكمان سلفت أحمد 500']) {
    await command(ctx, text)
    expect(await db.shopReminder.count({ where: { businessId: base.business.id } })).toBe(0)
  }
  await command(ctx, 'فكرني أجيب السكر مع البضاعة')
  expect((await command(ctx, 'متفكرنيش بالسكر'))?.replyText).toContain('مش هفكرك')
  expect(await db.shopReminder.count({ where: { businessId: base.business.id, active: true } })).toBe(0)
  expect(await money(base)).toEqual({ cash: 0, ops: 0, entries: 0, items: 0 })
})

test('brief prioritizes genuine due promises and personal shortages; its CTAs read/review without fabricating a receipt', async () => {
  const base = await shop(), ctx = await context(base)
  await debt(base, 'متأخر', 10055, yesterday)
  await debt(base, 'وعد اليوم', 20025, today)
  await debt(base, 'أكبر رصيد بلا وعد', 9999955)
  await command(ctx, 'فكرني أجيب أكياس تعبئة مع البضاعة')
  await db.item.create({ data: { businessId: base.business.id, name: 'رصيد قديم مش دليل نقص', unit: 'piece', stockQty: 0, lowStockThreshold: 10 } })
  const before = await money(base)
  const brief = await buildMorningBrief(base.business.id, base.user.id)
  expect(brief.items.map(i => i.id)).toEqual(['promises-overdue', 'promises-today', 'restock'])
  expect(brief.items[0].impact).toBe(10055); expect(brief.items[1].impact).toBe(20025)
  for (const item of brief.items) {
    const response = await command(ctx, item.cta.prompt!)
    expect(response).toBeTruthy(); expect(response?.opId).toBeUndefined()
    if (item.id.startsWith('promises')) expect(JSON.stringify(response?.cards)).toContain(item.id === 'promises-today' ? 'وعد اليوم' : 'متأخر')
  }
  expect(await money(base)).toEqual(before)
  const otherOwner = await db.user.create({ data: { businessId: base.business.id, name: 'مشرف', role: 'supervisor' } })
  expect((await buildMorningBrief(base.business.id, otherOwner.id)).items.some(i => i.id === 'restock')).toBe(false)
})

test('brief removes settled/reversed/future promises, keeps exact piastres in the balance, and never claims an empty book is complete', async () => {
  const base = await shop(), ctx = await context(base)
  expect((await buildMorningBrief(base.business.id, base.user.id)).headline).toContain('من المسجل')
  const settled = await debt(base, 'مسدد', 3055, yesterday)
  const receive = await createDraft({ businessId: base.business.id, userId: base.user.id, type: 'cashbook', summary: 'تحصيل اختبار', idempotencyKey: randomUUID(), payload: { kind: 'receive', note: 'سداد اختبار', partyName: 'مسدد', amount: 3055, occurredOn: today } })
  await executeOperation(receive.id, base.user.id, 'سداد الاختبار')
  const reversed = await debt(base, 'معكوس', 5055, yesterday)
  const reverse = await createDraft({ businessId: base.business.id, userId: base.user.id, type: 'reversal', summary: 'عكس اختبار', idempotencyKey: randomUUID(), payload: { originalRef: reversed.ref, reason: 'اختبار' } })
  await executeOperation(reverse.id, base.user.id, 'اختبار')
  await debt(base, 'وعد لسه جاي', 2055, dayOffset(1, new Date()))
  const unknown = await db.customer.create({ data: { businessId: base.business.id, name: 'رصيد قديم', balance: 9999955 } })
  const brief = await buildMorningBrief(base.business.id, base.user.id)
  expect(brief.items.some(i => i.id.startsWith('promises'))).toBe(false)
  const review = brief.items.find(i => i.id === `collect:${unknown.id}`)!
  expect(review.title).toContain(egp(9999955))
  expect(review.cta.prompt).not.toContain('حصلت')
  const before = await money(base)
  expect((await command(ctx, review.cta.prompt!))?.opId).toBeUndefined()
  expect(await money(base)).toEqual(before)
  expect((await db.cashbookEntry.findUniqueOrThrow({ where: { operationRef: settled.ref } })).openAmount).toBe(0)
})

test('manual-shop radar never infers theft, dead stock or stockout from missing sale logs; corrected drafts are not a cancellation alarm', async () => {
  const base = await shop(), ctx = await context(base)
  const item = await db.item.create({ data: { businessId: base.business.id, name: 'سكر', unit: 'kg', stockQty: 100, lowStockThreshold: 2, costPrice: 100, sellPrice: 200 } })
  await db.usageEvent.createMany({ data: Array.from({ length: 4 }, () => ({ businessId: base.business.id, userId: base.user.id, kind: 'tool', label: 'get_item_stock:سكر' })) })
  for (let i = 0; i < 2; i++) {
    const original = await command(ctx, 'بعت لأحمد بضاعة بمية على الحساب النهارده')
    await command(ctx, `عدل ${original!.card!.ref} المبلغ 120`)
  }
  const radar = await buildRadar(base.business.id)
  expect(radar.some(r => /^radar-(query|fast-stockout|margin|cancel-pattern)/.test(r.id))).toBe(false)
  const scan = await scanRisksAndOpportunities(base.business.id, base.user.id)
  expect(scan.alerts.some(a => /^opp-(unlock-dead-stock|star)/.test(a.id))).toBe(false)
  expect(JSON.stringify(scan)).not.toContain('جاهزة للتحصيل')
  expect((await db.item.findUniqueOrThrow({ where: { id: item.id } })).stockQty).toBe(100)
})

test('owner-private radar cannot leak through background scan or another user’s saved job cards', async () => {
  const base = await shop()
  const cashier = await db.user.create({ data: { businessId: base.business.id, name: 'كاشير', role: 'cashier' } })
  for (let i = 0; i < 2; i++) await db.operation.create({ data: { businessId: base.business.id, userId: base.user.id, ref: `T-${randomUUID()}`, type: 'expense', risk: 'R2', status: 'CANCELLED', summary: 'خاص بالمالك', payload: '{}', idempotencyKey: randomUUID() } })
  expect((await scanRisksAndOpportunities(base.business.id, base.user.id)).alerts.some(a => a.id === 'radar-cancel-pattern')).toBe(true)
  expect((await scanRisksAndOpportunities(base.business.id, cashier.id)).alerts.some(a => a.id.startsWith('radar-'))).toBe(false)
  await db.scheduledTask.create({ data: { businessId: base.business.id, userId: base.user.id, title: 'تقرير المالك', tool: 'bg:scan_risks_and_opportunities', fields: '{}', whenLabel: 'اختبار', scheduledFor: new Date(), status: 'done', result: JSON.stringify([{ kind: 'text', title: 'مراجعة خاصة', body: 'لا يراها الكاشير' }]) } })
  expect((await getRecentBackgroundJobs(base.business.id, cashier.id)).length).toBe(0)
  expect((await getRecentBackgroundJobs(base.business.id, base.user.id)).length).toBe(1)
  const foreign = await shop()
  await expect(scanRisksAndOpportunities(base.business.id, foreign.user.id)).rejects.toThrow()
})


test('generic background review never silently calibrates stock and never reports a manual-shop prediction as computed', async () => {
  const base = await shop()
  const item = await db.item.create({ data: { businessId: base.business.id, name: 'كمية غير معروفة', unit: 'kg', stockQty: 0, lowStockThreshold: 0 } })
  const before = await money(base)
  const manager = new TaskManager(1)
  const reviewed = await manager.enqueueJob({ businessId: base.business.id, userId: base.user.id, kind: 'sync_and_audit_records' })
  expect(reviewed.job.status).toBe('done')
  expect((await db.item.findUniqueOrThrow({ where: { id: item.id } })).lowStockThreshold).toBe(0)
  expect(reviewed.job.summary).toContain('لا أسعار أو كميات أو حدود أمان اتغيرت')
  const profit = await manager.enqueueJob({ businessId: base.business.id, userId: base.user.id, kind: 'analyze_financial_report' })
  expect(profit.job.summary).toContain('الربح غير محسوب')
  const forecast = await manager.enqueueJob({ businessId: base.business.id, userId: base.user.id, kind: 'forecast_inventory_velocity' })
  expect(forecast.job.summary).toContain('النفاد غير متوقع')
  expect(await money(base)).toEqual(before)
})
