// Isolated model boundary doubles: real harness/DB/tools, no outbound inference.
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { testDb } from './test-db'
import { BRAIN_CONTRACT_VERSION } from '../../src/lib/agent/context'
import { llmHealth } from '../../src/lib/agent/model-health'
const db = await testDb()
process.env.WAKIL_SAAS_ENABLED = '0'
process.env.WAKIL_SCHEDULER = 'off'
const mode = process.argv[2] ?? 'brain'
const captured: { role: string; content: string }[][] = []
let responses: string[] = []
const capture = async (_: unknown, messages: { role: string; content: string }[]) => {
  captured.push(structuredClone(messages))
  return responses.shift() ?? 'الخلاصة جاهزة من البيانات المتاحة.'
}
try {
  if (mode === 'brain') {
    mock.module('../../src/lib/agent/llm', () => ({
      completeChat: capture, resolveModel: async () => ({ key: 'test-brain', tier: 'balanced', source: 'builtin', label: 'fixture' }),
      modelLabelFor: () => 'fixture', llmHealth, getGeminiClient: () => null, zaiAvailable: () => false,
      streamChat: async function* () { yield { type: 'content', text: 'fixture' } },
    }))
    const { runAgentTurn } = await import('../../src/lib/agent/harness')
    const business = await db.business.create({ data: { name: 'Brain test', type: 'supermarket', openingCash: 0 } })
    const owner = await db.user.create({ data: { businessId: business.id, name: 'owner-fixture', role: 'owner' } })
    const cashier = await db.user.create({ data: { businessId: business.id, name: 'cashier-fixture', role: 'cashier' } })
    const conversation = await db.conversation.create({ data: { businessId: business.id, userId: owner.id, title: 'Fixture' } })
    const staffConversation = await db.conversation.create({ data: { businessId: business.id, userId: cashier.id, title: 'Staff fixture' } })
    const text = 'ممكن تساعدني أفهم الطلب اللي اتكلمنا عنه والخطوة اللي بعدها؟'
    const history = [{ role: 'user', text: 'العميل المقصود منى مش أحمد' }, { role: 'assistant', text: 'تمام، هنراجع طلب منى.' }]
    responses = ['فاهم إنك تقصد منى؛ محتاج تحدد الجزء اللي تحب نراجعه.']
    await runAgentTurn({ business, user: owner, conversationId: conversation.id, modelKey: null, text, history }, () => {})
    assert.ok(captured[0][0].content.includes(BRAIN_CONTRACT_VERSION))
    assert.ok(captured[0][0].content.includes('صلاحيات المستخدم الحالية'))
    assert.equal(captured[0].filter((m) => m.role === 'system').length, 1)
    assert.deepEqual(captured[0].slice(1, -1), history.map((h) => ({ role: h.role, content: h.text })))
    assert.equal(captured[0].at(-1)?.content, text)

    // Actual HTTP handler must fetch the NEWEST twelve persisted messages,
    // not the first twelve. Distinct timestamps keep this regression precise.
    await db.message.createMany({ data: Array.from({ length: 30 }, (_, i) => ({ conversationId: conversation.id, role: i % 2 ? 'assistant' : 'user', text: `history-marker-${i}`, createdAt: new Date(Date.now() - 10000 + i * 10) })) })
    captured.length = 0
    responses = ['حدد الجزء اللي تحب نراجعه من الكلام السابق.']
    const { POST } = await import('../../src/app/api/chat/route')
    const response = await POST(new Request('http://wakil.test/api/chat', { method: 'POST', headers: { host: 'wakil.test', 'content-type': 'application/json', origin: 'http://wakil.test' }, body: JSON.stringify({ businessId: business.id, userId: owner.id, conversationId: conversation.id, text }) }))
    assert.equal(response.status, 200)
    await response.text()
    const wireHistory = captured[0].slice(1, -1)
    assert.equal(wireHistory.length, 12)
    assert.equal(wireHistory[0].content, 'history-marker-18')
    assert.equal(wireHistory.at(-1)?.content, 'history-marker-29')

    await assert.rejects(runAgentTurn({ business, user: cashier, conversationId: conversation.id, modelKey: null, text, history: [] }, () => {}), /صلاحيتك/)
    captured.length = 0
    responses = [JSON.stringify({ tool_calls: [{ tool: 'memory_save', args: { text: 'معلومة خاصة للاختبار', kind: 'fact' } }] }), JSON.stringify({ tool_calls: [{ tool: 'memory_save', args: { kind: 'fact', text: 'معلومة خاصة للاختبار' } }] }), 'حفظت المعلومة بنجاح.']
    const denied = await runAgentTurn({ business, user: cashier, conversationId: staffConversation.id, modelKey: null, text: 'ممكن تحفظ المعلومة المطلوبة بعد مراجعة صلاحياتي؟', history: [] }, () => {})
    assert.equal(await db.agentMemory.count({ where: { businessId: business.id, userId: cashier.id } }), 0)
    assert.ok(denied.replyText.includes('صلاحيتك'))
    assert.ok(!denied.replyText.includes('حفظت المعلومة بنجاح'))
    assert.ok(captured.at(-1)!.some((m) => m.content.includes('"duplicate":true') && m.content.includes('"ok":false')))

    const memoryBefore = await db.agentMemory.count({ where: { businessId: business.id } })
    const refusedSecret = await runAgentTurn({ business, user: owner, conversationId: conversation.id, modelKey: null, text: 'احفظ كلمة المرور للاختبار synthetic-only', history: [] }, () => {})
    assert.ok(refusedSecret.replyText.includes('مش هحفظ'))
    assert.equal(await db.agentMemory.count({ where: { businessId: business.id } }), memoryBefore)
    captured.length = 0
    responses = [JSON.stringify({ tool_calls: [{ tool: 'record_expense', args: { amount: 17, reason: 'نظافة' } }] }), JSON.stringify({ tool_calls: [{ tool: 'record_expense', args: { reason: 'نظافة', amount: 17 } }] }), 'تم خصم المصروف بنجاح.']
    const drafted = await runAgentTurn({ business, user: owner, conversationId: conversation.id, modelKey: null, turnId: 'fixture-same-turn', text: 'جهز مصروف النظافة المطلوب ووضحلي حالته بعد كده', history: [] }, () => {})
    assert.equal(await db.operation.count({ where: { businessId: business.id } }), 1)
    assert.equal(await db.cashEntry.count({ where: { businessId: business.id } }), 0)
    assert.equal(drafted.card?.status, 'AWAITING_APPROVAL')
    assert.ok(drafted.replyText.includes('مسودة'))
    assert.ok(!drafted.replyText.includes('تم خصم'))
    console.log('PASS: brain prompt delivery, real dialogue, denied-result replay and one pending draft')
  } else {
    delete process.env.WAKIL_OFFLINE
    delete process.env.GEMINI_API_KEY
    await db.modelConfig.updateMany({ data: { enabled: false } })
    const messages = [{ role: 'system' as const, content: BRAIN_CONTRACT_VERSION + ' — server policy' }, { role: 'user' as const, content: 'context-user' }, { role: 'assistant' as const, content: 'context-assistant' }, { role: 'user' as const, content: 'current-user' }]
    let modelKey = 'auto'
    let transportCalls = 0
    if (mode === 'external') {
      process.env.WAKIL_SECRETS_KEY = 'ab'.repeat(32)
      const { encryptProviderKey } = await import('../../src/lib/security/provider-secrets')
      const provider = await db.modelProvider.create({ data: { name: 'fixture-provider', baseUrl: 'https://provider.example.test/v1', apiKey: encryptProviderKey('synthetic-provider-key') } })
      const config = await db.modelConfig.create({ data: { providerId: provider.id, remoteId: 'fixture-model', label: 'fixture', tier: 'balanced', enabled: true } })
      modelKey = `ext:${config.id}`
      mock.module('../../src/lib/security/provider-network', () => ({ providerFetch: async (url: string, init: RequestInit) => {
        transportCalls++
        if (transportCalls === 4) throw new Error('synthetic strict-provider failure')
        assert.equal(url, 'https://provider.example.test/v1/chat/completions')
        assert.deepEqual(JSON.parse(String(init.body)).messages, messages)
        assert.equal(new Headers(init.headers).get('authorization'), 'Bearer synthetic-provider-key')
        assert.ok(init.signal instanceof AbortSignal)
        if (JSON.parse(String(init.body)).stream) {
          return new Response(new ReadableStream({ start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial response"}}]}\n\n'))
            setTimeout(() => controller.error(new Error('synthetic mid-stream transport loss')), 10)
          } }))
        }
        return Response.json({ choices: [{ message: { content: 'fixture completion' } }] })
      } }))
    } else if (mode === 'gemini') {
      process.env.GEMINI_API_KEY = 'synthetic-not-real'
      mock.module('@google/genai', () => ({ GoogleGenAI: class { models = { generateContent: async (request: { config: { systemInstruction: string; abortSignal: AbortSignal }; contents: { role: string }[] }) => {
        assert.equal(request.config.systemInstruction, messages[0].content)
        assert.deepEqual(request.contents.map((c) => c.role), ['user', 'model', 'user'])
        assert.ok(request.config.abortSignal instanceof AbortSignal)
        return { text: 'fixture completion' }
      } } } }))
    } else if (mode === 'sdk') {
      mock.module('z-ai-web-dev-sdk', () => ({ default: { create: async () => ({ chat: { completions: { create: async (request: { messages: typeof messages }) => { assert.deepEqual(request.messages, messages); return { choices: [{ message: { content: 'fixture completion' } }] } } } } }) } }))
    } else throw new Error('Unknown fixture mode')
    const { completeChat, streamChat } = await import('../../src/lib/agent/llm')
    assert.equal(await completeChat({ key: modelKey, label: 'fixture', tier: 'balanced', source: mode === 'external' ? 'external' : 'builtin' }, messages), 'fixture completion')
    if (mode === 'external') {
      const chunks: string[] = []
      await assert.rejects(async () => {
        for await (const chunk of streamChat({ key: modelKey, label: 'fixture', tier: 'balanced', source: 'external' }, messages)) if (chunk.type === 'content') chunks.push(chunk.text)
      })
      assert.deepEqual(chunks, ['partial response'])
      assert.equal(transportCalls, 2, 'no fallback/restart may splice a second answer into partial content')
      const { withStrictInference } = await import('../../src/lib/agent/inference-audit')
      const model = { key: modelKey, label: 'fixture', tier: 'balanced' as const, source: 'external' as const }
      const strict = await withStrictInference(() => completeChat(model, messages))
      assert.equal(strict.receipts.length, 1)
      assert.equal(strict.receipts[0].roles[0], 'system')
      assert.equal(strict.receipts[0].systemSha256.length, 64)
      llmHealth.fellBack = false
      await assert.rejects(withStrictInference(() => completeChat(model, messages)), /strict-provider failure/)
      assert.equal(transportCalls, 4, 'strict inference never invokes another model/provider')
      assert.equal(llmHealth.fellBack, false)
    }
    console.log(`PASS: ${mode} gateway preserves system authority and dialogue roles`)
  }
} finally { await db.$disconnect() }
