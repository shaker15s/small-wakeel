// R44 — Native tool-calling wire contract (DeepSeek-Harness «tools join the
// request», verified on the wire, not by faith).
//
// The capture server below records EVERY byte of the outbound request:
//   • the `tools` array must be present with the full brain schema set
//   • the system prompt must arrive BYTE-EXACT (no truncation, no rewriting)
//   • a provider answering with NATIVE tool_calls must be normalized back
//     into the canonical `{"tool_calls":[{"tool","args"}]}` text the brain
//     loop already parses
//   • a provider that 400s on the `tools` field must be retried WITHOUT it
//     (JSON-in-text emulation) and remembered — the second call skips the
//     failing form entirely (self-heal ladder).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { testDb } from '../helpers/test-db'
import { completeChat, normalizeNativeToolCalls } from '@/lib/agent/llm'
import { brainToolSchemas, brainToolCount } from '@/lib/agent/tool-schemas'
import { encryptProviderKey } from '@/lib/security/provider-secrets'

process.env.WAKIL_ALLOW_LOCAL_PROVIDERS = '1'
const hadOffline = 'WAKIL_OFFLINE' in process.env
const prevOffline = process.env.WAKIL_OFFLINE
delete process.env.WAKIL_OFFLINE

const db = await testDb()
const SECRET = `tool-probe-${randomUUID()}`
const TOOLS = brainToolSchemas()

interface WireReq {
  model?: string
  stream?: boolean
  tools?: unknown[]
  messages?: { role: string; content: string }[]
}
let server: Server
let port = 0
let configId = ''
let providerId = ''
/** every request the server saw, in order */
const wire: WireReq[] = []
/** per-test response policy */
let policy: 'native' | 'reject-tools' | 'plain' = 'native'
let requestsWithTools = 0
let requestsWithoutTools = 0

const SYSTEM_PROMPT =
  'أنت وكيل — النظام كامل: ' +
  'بروتوكول العمل على المهام (PLAN-FIRST) | جودة الإجابة | حدود الثقة | ' +
  'المحرك القرار | ' +
  // pad to a realistic 20k+ prompt: the arrival proof must hold at real size
  Array.from({ length: 260 }, (_, i) => `القاعدة ${i + 1}: الأرقام من السجل فقط (مصدر موثق ${i + 1})`).join(' ')

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end()
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const parsed = JSON.parse(body) as WireReq
      wire.push(parsed)
      if (Array.isArray(parsed.tools) && parsed.tools.length > 0) requestsWithTools++
      else requestsWithoutTools++

      if (policy === 'reject-tools' && Array.isArray(parsed.tools) && parsed.tools.length > 0) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Unknown parameter: "tools" is not supported for this model' } }))
        return
      }

      const lastUser = [...(parsed.messages ?? [])].reverse().find((m) => m.role === 'user')?.content ?? ''
      const json =
        policy === 'native'
          ? {
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: 'call_1',
                        type: 'function',
                        function: {
                          name: 'get_cash_position',
                          arguments: JSON.stringify({}),
                        },
                      },
                      {
                        id: 'call_2',
                        type: 'function',
                        function: {
                          name: 'list_low_stock',
                          arguments: JSON.stringify({ limit: 5 }),
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            }
          : {
              choices: [{ message: { role: 'assistant', content: `ECHO «${lastUser}»` }, finish_reason: 'stop' }],
            }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(json))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port

  const provider = await db.modelProvider.create({
    data: { name: `tool-probe-${randomUUID()}`, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: encryptProviderKey(SECRET) },
  })
  providerId = provider.id
  const config = await db.modelConfig.create({
    data: { providerId: provider.id, remoteId: 'tool-model', label: 'tool probe', tier: 'air', enabled: true },
  })
  configId = config.id
})

afterAll(async () => {
  if (hadOffline) process.env.WAKIL_OFFLINE = prevOffline
  else delete process.env.WAKIL_OFFLINE
  server?.close()
  await db.modelConfig.deleteMany({ where: { providerId } })
  await db.modelProvider.deleteMany({ where: { id: providerId } })
})

const model = () => ({
  key: `ext:${configId}`,
  label: 'tool probe',
  tier: 'air' as const,
  source: 'external' as const,
  remoteModel: 'tool-model',
  baseUrl: `http://127.0.0.1:${port}/v1`,
})

test('wire carries the full tool schema set — the model gets real JSON schemas', async () => {
  wire.length = 0
  requestsWithTools = 0
  requestsWithoutTools = 0
  policy = 'native'
  const out = await completeChat(model(), [{ role: 'system', content: 'sys' }, { role: 'user', content: 'الخزنة كام؟' }], { tools: TOOLS })

  // the request went out WITH the native tools array
  expect(requestsWithTools).toBe(1)
  const req = wire[0]
  expect(Array.isArray(req.tools)).toBe(true)
  expect((req.tools as unknown[]).length).toBe(brainToolCount())
  const names = new Set((req.tools as { function?: { name?: string } }[]).map((t) => t.function?.name))
  expect(names.has('get_cash_position')).toBe(true)
  expect(names.has('record_sale')).toBe(true)
  expect(names.has('memory_save')).toBe(true)
  expect(names.has('search_web')).toBe(true)
  // every schema is a well-formed function definition
  for (const t of req.tools as { type?: string; function?: { name?: string; description?: string; parameters?: { type?: string } } }[]) {
    expect(t.type).toBe('function')
    expect(typeof t.function?.name).toBe('string')
    expect(typeof t.function?.description).toBe('string')
    expect(t.function?.parameters?.type).toBe('object')
  }
  // the provider answered with NATIVE tool_calls; the gateway normalized it
  // into the canonical text contract the brain loop parses
  const parsed = JSON.parse(out) as { tool_calls: { tool: string; args: Record<string, unknown> }[] }
  expect(parsed.tool_calls.map((c) => c.tool)).toEqual(['get_cash_position', 'list_low_stock'])
  expect(parsed.tool_calls[1].args).toEqual({ limit: 5 })
}, 20_000)

test('the system prompt arrives byte-exact at real size (20k+ chars, never truncated)', async () => {
  wire.length = 0
  policy = 'plain'
  await completeChat(model(), [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: 'سؤال طويل وكامل' }])
  const req = wire[0]
  expect(req.messages?.[0]?.content).toBe(SYSTEM_PROMPT)
  expect(req.messages?.[0]?.content?.length).toBe(SYSTEM_PROMPT.length)
  expect(req.messages?.at(-1)?.content).toBe('سؤال طويل وكامل')
  // and no tools were requested → nothing extra on the wire
  expect(req.tools).toBeUndefined()
}, 20_000)

test('provider without tool support: 400 on `tools` → retried without it → remembered', async () => {
  wire.length = 0
  requestsWithTools = 0
  requestsWithoutTools = 0
  policy = 'reject-tools'
  const out = await completeChat(model(), [{ role: 'user', content: 'المرحبا' }], { tools: TOOLS })
  // two attempts: with tools (400) then without (200)
  expect(requestsWithTools).toBe(1)
  expect(requestsWithoutTools).toBe(1)
  expect(out).toContain('المرحبا')

  // second call: the cache knows this provider rejects tools → ONE request,
  // without the field, no failing attempt
  wire.length = 0
  requestsWithTools = 0
  requestsWithoutTools = 0
  const out2 = await completeChat(model(), [{ role: 'user', content: 'تاني' }], { tools: TOOLS })
  expect(requestsWithTools).toBe(0)
  expect(requestsWithoutTools).toBe(1)
  expect(out2).toContain('تاني')
}, 30_000)

test('normalizeNativeToolCalls: edge cases (malformed args, missing names, empty)', () => {
  expect(normalizeNativeToolCalls(undefined)).toBeNull()
  expect(normalizeNativeToolCalls([])).toBeNull()
  expect(normalizeNativeToolCalls([{ function: { name: 'a', arguments: 'not-json' } }])).toBe(
    JSON.stringify({ tool_calls: [{ tool: 'a', args: { _raw: 'not-json' } }] }),
  )
  const mixed = normalizeNativeToolCalls([
    { function: { name: 'x', arguments: '{"n":1}' } },
    { function: {} },
    { function: { name: 'y' } },
  ])
  expect(JSON.parse(mixed ?? 'null').tool_calls).toEqual([
    { tool: 'x', args: { n: 1 } },
    { tool: 'y', args: {} },
  ])
})
