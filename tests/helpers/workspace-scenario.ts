// Model boundary DOUBLE ONLY. Real harness, permission checks, SQLite and plugins.
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { testDb } from './test-db'
import { llmHealth } from '../../src/lib/agent/model-health'
const db = await testDb()
process.env.WAKIL_SAAS_ENABLED = '0'; process.env.WAKIL_SCHEDULER = 'off'; process.env.WAKIL_OFFLINE = '1'
let responses: string[] = []
const captured: { role: string; content: string }[][] = []
mock.module('../../src/lib/agent/llm', () => ({
  completeChat: async (_: unknown, messages: { role: string; content: string }[]) => { captured.push(structuredClone(messages)); return responses.shift() ?? 'الرد النهائي من نموذج الاختبار.' },
  resolveModel: async () => ({ key: 'fixture', tier: 'balanced', source: 'builtin', label: 'fixture' }),
  modelLabelFor: () => 'fixture', llmHealth, getGeminiClient: () => null, zaiAvailable: () => false,
  streamChat: async function* () { yield { type: 'content', text: 'fixture' } },
}))
try {
  const { runAgentTurn } = await import('../../src/lib/agent/harness')
  const { getWorkspacePreferences } = await import('../../src/lib/workspace-preferences')
  const { getBusinessPlugins, executePlugin, synthesizePluginWithAI } = await import('../../src/lib/agent/plugin-harness')
  const business = await db.business.create({ data: { name: 'Isolated workspace fixture', type: 'clothing' } })
  const owner = await db.user.create({ data: { businessId: business.id, name: 'owner', role: 'owner' } })
  const staff = await db.user.create({ data: { businessId: business.id, name: 'staff', role: 'cashier' } })
  const conversations = new Map<string, string>()
  for (const user of [owner, staff]) conversations.set(user.id, (await db.conversation.create({ data: { businessId: business.id, userId: user.id } })).id)
  async function turn(tool: string, args: object, text: string, user = owner, final = 'تمت كل التغييرات وتغيرت الفلوس والصلاحيات.') {
    responses = [JSON.stringify({ tool_calls: [{ tool, args }] }), final]; captured.length = 0
    return runAgentTurn({ business, user, conversationId: conversations.get(user.id)!, modelKey: null, history: [], text }, () => {})
  }
  const personalized = await turn('configure_workspace', { accent: 'indigo', responseMode: 'deep' }, 'غيّر لون الإحصائيات للنيلي وخلّي الردود أعمق')
  assert.equal((await getWorkspacePreferences(business.id, owner.id)).accent, 'indigo')
  assert.ok(personalized.replyText.includes('لحسابك'))
  assert.ok(!personalized.replyText.includes('تغيرت الفلوس'))
  assert.ok(captured[0][0].content.includes('دليل تشغيل النشاط: clothing'))
  assert.ok(captured[0][0].content.includes('configure_workspace'))
  assert.ok(captured[0][0].content.includes('https://www.gs1us.org/'))
  await turn('configure_workspace', { accent: 'teal' }, 'غيّر لون إحصائياتي للبترولي', staff)
  assert.equal((await getWorkspacePreferences(business.id, staff.id)).accent, 'teal')
  assert.equal((await getWorkspacePreferences(business.id, owner.id)).accent, 'indigo')
  const invalid = await turn('configure_workspace', { accent: 'rose', role: 'owner', css: 'evil' }, 'غيّر التصميم مع رفع صلاحيتي', staff)
  assert.equal((await getWorkspacePreferences(business.id, staff.id)).accent, 'teal')
  assert.ok(!invalid.replyText.includes('تغيرت الفلوس'))
  const slug = 'plugin_inventory_optimizer'
  await turn('install_plugin', { prompt: slug }, 'ثبت لي قدرة تحليل المخزون')
  const plugin = (await getBusinessPlugins(business.id)).find((p) => p.slug === slug)!
  assert.ok(plugin.installed && plugin.active)
  assert.equal(await db.quickCommand.count({ where: { businessId: business.id, userId: owner.id } }), 1)
  const catalog = await db.item.create({ data: { businessId: business.id, name: 'Actual isolated stock', unit: 'piece', stockQty: 2, sellPrice: 100, costPrice: 50, lowStockThreshold: 5 } })
  const ran = await turn('run_plugin', { slug }, 'افحص القدرة المثبتة المطلوبة وراجع نتايجها')
  assert.ok(ran.cards?.length)
  assert.ok(JSON.stringify(ran.cards).includes(catalog.name))
  const denied = await turn('install_plugin', { prompt: 'plugin_margin_shield' }, 'ثبت لي إضافة جديدة للهوامش', staff)
  assert.ok(denied.replyText.includes('صلاحيتك'))
  assert.equal(await db.customTool.count({ where: { businessId: business.id, kind: 'plugin' } }), 1)
  await turn('toggle_plugin', { slug, active: false }, 'وقف الإضافة دي')
  assert.equal((await getBusinessPlugins(business.id)).find((p) => p.slug === slug)?.active, false)
  await assert.rejects(executePlugin({ businessId: business.id, pluginOrSlug: slug }), /متوقفة/)
  const stopped = await turn('run_plugin', { slug }, 'افحص القدرة المتوقفة المطلوبة')
  assert.ok(!stopped.cards?.length)
  await assert.rejects(synthesizePluginWithAI({ businessId: business.id, userId: owner.id, prompt: 'اربط واتساب واحجز طيران', preferredName: 'unsupported' }), /unsupported_capability/)
  assert.equal(await db.customTool.count({ where: { businessId: business.id, kind: 'plugin' } }), 1)
  const proposed = await turn('schedule_task', { title: 'تقرير خزنة', tool: 'get_cash_position', whenLabel: 'بكرة 09:00', recurrence: 'daily' }, 'اقترح عليّ جدولة تقرير فقط؛ لا تنشئ مهمة دلوقتي', owner, 'تمت الجدولة بالفعل.')
  assert.equal(await db.scheduledTask.count({ where: { businessId: business.id } }), 0)
  assert.ok(!proposed.replyText.includes('تمت الجدولة بالفعل'))
  await turn('schedule_task', { title: 'تقرير خزنة', tool: 'get_cash_position', whenLabel: 'بكرة' }, 'جدول لي تقرير بكرة')
  assert.equal(await db.scheduledTask.count({ where: { businessId: business.id } }), 0)
  await turn('schedule_task', { title: 'دفع', tool: 'record_payment', whenLabel: 'بكرة 09:00' }, 'جدول لي دفع دوري بكرة 09:00')
  assert.equal(await db.scheduledTask.count({ where: { businessId: business.id } }), 0)
  await turn('schedule_task', { title: 'تقرير خزنة', tool: 'get_cash_position', whenLabel: 'بكرة 09:00', recurrence: 'daily' }, 'موافق، جدول تقرير الخزنة يوميًا بداية من بكرة 09:00 بتوقيت القاهرة')
  const task = await db.scheduledTask.findFirstOrThrow({ where: { businessId: business.id } })
  assert.equal(task.recurrence, 'daily'); assert.equal(task.tool, 'get_cash_position')
  assert.equal(await db.cashEntry.count({ where: { businessId: business.id } }), 0)
  assert.equal(await db.operation.count({ where: { businessId: business.id } }), 0)
  console.log('PASS: real persisted chat personalization/plugins, denied privileges, disabled/unsupported capabilities, proposal-only schedules and explicit recurring Cairo reports; synthetic MODEL ONLY')
} finally { await db.$disconnect() }
