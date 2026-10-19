// Provider PATH verification — the answer to «is my prompt really reaching
// the model, and are the model's words really reaching me?».
//
// The stub below is a live OpenAI-compatible server that is DELIBERATELY
// non-canned: it computes every reply from the request it receives
// (the model id, the last user message, and a digit sum it performs
// itself). If completeChat returns that computed string, then — by
// construction — (a) the app sent the REAL prompt to the provider and
// (b) the provider's answer reached the caller byte-for-byte. No canned
// reply anywhere in the chain.
//
// The second test pins the FAILURE contract: an unreachable provider
// throws (it never invents an answer), which is what the harness's
// transparency note relies on.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { testDb } from '../helpers/test-db'
import { completeChat } from '@/lib/agent/llm'
import { encryptProviderKey } from '@/lib/security/provider-secrets'

// loopback opt-in for the guarded transport (dev-only; production keeps the
// HTTPS-public contract with zero exceptions)
process.env.WAKIL_ALLOW_LOCAL_PROVIDERS = '1'
// a sibling suite may hold WAKIL_OFFLINE=1 for its own scenario — the provider
// path under test must be judged in live mode; save/restore, don't fight it
const hadOffline = 'WAKIL_OFFLINE' in process.env
const prevOffline = process.env.WAKIL_OFFLINE
const hadLocal = 'WAKIL_ALLOW_LOCAL_PROVIDERS' in process.env
const prevLocal = process.env.WAKIL_ALLOW_LOCAL_PROVIDERS
delete process.env.WAKIL_OFFLINE

const db = await testDb()

const SECRET = `probe-key-${randomUUID()}`
let server: Server
let port = 0
let providerId = ''
let configId = ''
const seen: { auth?: string; model?: string; lastUser?: string } = {}

/** Compute the reply FROM the request — never from a fixed string. */
function computeReply(model: string, lastUser: string): string {
  const digits = (lastUser.match(/\d+/g) ?? []).reduce((s, d) => s + Number(d), 0)
  return `ECHO[${model}] «${lastUser}» مجموع الأرقام=${digits}`
}

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end()
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const parsed = JSON.parse(body) as { model?: string; stream?: boolean; messages?: { role: string; content: string }[] }
      const lastUser = [...(parsed.messages ?? [])].reverse().find((m) => m.role === 'user')?.content ?? ''
      seen.auth = req.headers.authorization
      seen.model = parsed.model
      seen.lastUser = lastUser
      const reply = computeReply(parsed.model ?? '?', lastUser)
      if (parsed.stream) {
        // OpenAI-compatible SSE stream, split into two chunks on purpose
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const half = Math.max(1, Math.floor(reply.length / 2))
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply.slice(0, half) } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply.slice(half) } }] })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      // completeChat's external path is non-streaming JSON
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply }, finish_reason: 'stop' }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port

  const provider = await db.modelProvider.create({
    data: { name: `probe-${randomUUID()}`, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: encryptProviderKey(SECRET) },
  })
  providerId = provider.id
  const config = await db.modelConfig.create({
    data: { providerId: provider.id, remoteId: 'probe-model-x', label: 'probe model', tier: 'air', enabled: true },
  })
  configId = config.id
})

afterAll(async () => {
  if (hadOffline) process.env.WAKIL_OFFLINE = prevOffline
  else delete process.env.WAKIL_OFFLINE
  if (hadLocal) process.env.WAKIL_ALLOW_LOCAL_PROVIDERS = prevLocal
  else delete process.env.WAKIL_ALLOW_LOCAL_PROVIDERS
  server?.close()
  await db.modelConfig.deleteMany({ where: { providerId } })
  await db.modelProvider.deleteMany({ where: { id: providerId } })
})

test('external provider: the real prompt goes out and the real answer comes back verbatim', async () => {
  const question = 'كم يساوي ١٢ + 45؟'
  const out = await completeChat(
    { key: `ext:${configId}`, label: 'probe', tier: 'air', source: 'external', remoteModel: 'probe-model-x', baseUrl: `http://127.0.0.1:${port}/v1` },
    [
      { role: 'system', content: 'أنت وكيل.' },
      { role: 'user', content: question },
    ],
  )
  // the stub's reply is COMPUTED from what it received — matching it proves
  // the request carried the real prompt and the answer passed through whole
  expect(out).toBe(computeReply('probe-model-x', question))
  expect(seen.auth).toBe(`Bearer ${SECRET}`)
  expect(seen.model).toBe('probe-model-x')
  expect(seen.lastUser).toBe(question)
}, 20_000)

test('unreachable provider with NO reachable alternative: it THROWS, it never invents an answer', async () => {
  // Hermetic ladder: park every other enabled external config so the ONLY
  // options are the dead provider and the builtin (no key in CI). With the
  // DeepSeek-harness fallback ladder, a reachable sibling provider rescues
  // the call — that rescue is proven by the stub test above.
  const others = await db.modelConfig.findMany({ where: { enabled: true } })
  const dead = await db.modelProvider.create({
    data: { name: `dead-${randomUUID()}`, baseUrl: `http://127.0.0.1:1/v1`, apiKey: encryptProviderKey('x') },
  })
  const deadConfig = await db.modelConfig.create({
    data: { providerId: dead.id, remoteId: 'dead-model', label: 'dead', tier: 'air', enabled: true },
  })
  try {
    await db.modelConfig.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { enabled: false } })
    await expect(
      completeChat(
        { key: `ext:${deadConfig.id}`, label: 'dead', tier: 'air', source: 'external', remoteModel: 'dead-model', baseUrl: 'http://127.0.0.1:1/v1' },
        [{ role: 'user', content: 'سلام' }],
      ),
    ).rejects.toBeInstanceOf(Error)
  } finally {
    await db.modelConfig.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { enabled: true } })
    await db.modelConfig.deleteMany({ where: { providerId: dead.id } })
    await db.modelProvider.deleteMany({ where: { id: dead.id } })
  }
}, 60_000)
