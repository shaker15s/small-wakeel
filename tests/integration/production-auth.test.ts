import { GET as speechStatus, POST as speechUpload } from '@/app/api/speech/route'
import { GET as speechConfig, POST as speechConfigWrite } from '@/app/api/speech/settings/route'
import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { guard } from '@/app/api/_lib/guard'
import { tokenAccepted } from '@/lib/security/auth'
import { GET as operationDetail } from '@/app/api/operations/[id]/confirm/route'
import { GET as bootstrap, POST as createBusiness } from '@/app/api/bootstrap/route'
import { GET as providers, POST as addProvider } from '@/app/api/providers/route'
import { POST as probe } from '@/app/api/providers/probe/route'
import { POST as updateProvider, DELETE as deleteProvider } from '@/app/api/providers/[id]/route'
import { PATCH as patchMemory, DELETE as deleteMemory } from '@/app/api/memories/route'
import { PATCH as patchPlugin, DELETE as deletePlugin } from '@/app/api/plugins/route'
import { POST as scheduleTask } from '@/app/api/tasks/route'
import { POST as backgroundTask } from '@/app/api/background-tasks/route'
import { dispatchConcurrentBackgroundJobs } from '@/lib/agent/task-engine'
import { resetRateLimiter } from '@/lib/security/rateLimit'

const original = { ...process.env }
const token = 'test-only-user-credential-'.repeat(3)
const otherToken = 'test-only-second-credential-'.repeat(3)
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
let owner: { id: string; businessId: string }
let other: { id: string; businessId: string }
function config(admin = false) {
  Object.assign(process.env, { NODE_ENV: 'production', WAKIL_AUTH_CREDENTIALS: JSON.stringify([
    { userId: owner.id, tokenHash: hash(token), admin },
    { userId: other.id, tokenHash: hash(otherToken) },
  ]) })
}
function request(path = '/api/bootstrap', method = 'GET', headers: Record<string, string> = {}) {
  return new NextRequest(`http://test${path}`, { method, headers: { authorization: `Bearer ${token}`, ...headers } })
}
beforeAll(async () => {
  owner = await db.user.findFirstOrThrow({ where: { role: 'owner' } })
  other = await db.user.findFirstOrThrow({ where: { businessId: { not: owner.businessId } } })
})
afterEach(() => {
  for (const key of ['NODE_ENV', 'WAKIL_AUTH_CREDENTIALS', 'WAKIL_ACCESS_TOKEN']) {
    if (original[key] === undefined) delete process.env[key]
    else process.env[key] = original[key]
  }
  resetRateLimiter()
})

describe('production identity / tenant binding', () => {
  test('missing, malformed and duplicate identity config all fail closed', async () => {
    Object.assign(process.env, { NODE_ENV: 'production', WAKIL_ACCESS_TOKEN: token })
    for (const value of [undefined, '', '{bad', '[]', JSON.stringify([{ userId: owner.id, tokenHash: 'invalid' }])]) {
      if (value === undefined) delete process.env.WAKIL_AUTH_CREDENTIALS
      else process.env.WAKIL_AUTH_CREDENTIALS = value
      expect(tokenAccepted(request())).toBe(false)
      const result = await guard(request(), { scope: 'open' })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.res.status).toBe(401)
    }
    config()
    const entries = JSON.parse(process.env.WAKIL_AUTH_CREDENTIALS!)
    process.env.WAKIL_AUTH_CREDENTIALS = JSON.stringify([entries[0], entries[0]])
    expect(tokenAccepted(request())).toBe(false)
  })

  test('query strings and cookies are not production identity', () => {
    config()
    expect(tokenAccepted(new Request(`http://test/api?token=${token}`))).toBe(false)
    expect(tokenAccepted(new Request('http://test/api', { headers: { cookie: `wakil_token=${token}` } }))).toBe(false)
    expect(tokenAccepted(request())).toBe(true)
  })

  test('caller cannot impersonate another user or another tenant, even as admin', async () => {
    config(true)
    for (const options of [
      { scope: 'business' as const, businessId: other.businessId },
      { businessId: other.businessId, userId: other.id },
      { businessId: owner.businessId, userId: other.id },
    ]) {
      const result = await guard(request(), options)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.res.status).toBe(403)
    }
    const headersOverride = await guard(request('/api', 'GET', { 'x-wakil-business': other.businessId }), {
      businessId: owner.businessId, userId: owner.id,
    })
    expect(headersOverride.ok).toBe(false)
  })

  test('business-only reads derive their tenant from authenticated DB membership', async () => {
    config()
    const result = await guard(request('/api/items'), { scope: 'business' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.business.id).toBe(owner.businessId)
  })

  test('bootstrap returns only the authenticated shop and user, never secrets', async () => {
    config()
    const res = await bootstrap(request())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.businesses.map((b: any) => b.id)).toEqual([owner.businessId])
    expect(body.businesses[0].users.map((u: any) => u.id)).toEqual([owner.id])
    expect(JSON.stringify(body)).not.toContain('apiKey')
  })

  test('every provider handler and business creation reject non-admin before body/DB/fetch', async () => {
    config()
    const params = { params: Promise.resolve({ id: 'not-a-provider' }) }
    const responses = await Promise.all([
      speechConfig(request('/api/speech/settings')),
      speechConfigWrite(request('/api/speech/settings', 'POST')),
      providers(request('/api/providers')),
      addProvider(request('/api/providers', 'POST')),
      probe(request('/api/providers/probe', 'POST')),
      updateProvider(request('/api/providers/x', 'POST'), params),
      deleteProvider(request('/api/providers/x', 'DELETE'), params),
      createBusiness(request('/api/bootstrap', 'POST')),
    ])
    expect(responses.map((res) => res.status)).toEqual([403, 403, 403, 403, 403, 403, 403, 403])
  })

  test('provider listing rejects anonymous requests and permits explicit deployment admin', async () => {
    config(true)
    expect((await providers(new Request('http://test/api/providers'))).status).toBe(401)
    expect((await providers(request('/api/providers'))).status).toBe(200)
  })

  test('operation detail GET is guarded and hides cross-tenant rows', async () => {
    config()
    const op = await db.operation.findFirstOrThrow({ where: { businessId: other.businessId } })
    const params = { params: Promise.resolve({ id: op.id }) }
    expect((await operationDetail(new Request('http://test/api/operations/x/confirm'), params)).status).toBe(401)
    expect((await operationDetail(request('/api/operations/x/confirm'), params)).status).toBe(404)
  })

  test('credentials cannot survive deletion of their DB user', async () => {
    config()
    process.env.WAKIL_AUTH_CREDENTIALS = JSON.stringify([{ userId: 'deleted-user', tokenHash: hash(token), admin: true }])
    const result = await guard(request(), { scope: 'admin' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.res.status).toBe(401)
  })

  test('foreign memory cannot be edited or deleted by an authenticated tenant', async () => {
    config()
    const memory = await db.agentMemory.create({ data: {
      businessId: other.businessId, userId: other.id, kind: 'fact', text: 'Foreign tenant fact', category: 'test',
    } })
    try {
      const edit = new NextRequest('http://test/api/memories', {
        method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: memory.id, text: 'attacker replacement' }),
      })
      expect((await patchMemory(edit)).status).toBe(404)
      expect((await deleteMemory(request(`/api/memories?id=${memory.id}`, 'DELETE'))).status).toBe(404)
      expect((await db.agentMemory.findUniqueOrThrow({ where: { id: memory.id } })).text).toBe(memory.text)
    } finally { await db.agentMemory.delete({ where: { id: memory.id } }) }
  })

  test('own-tenant memory mutation still works under authenticated scope', async () => {
    config()
    const memory = await db.agentMemory.create({ data: {
      businessId: owner.businessId, userId: owner.id, kind: 'fact', text: 'Own fact', category: 'test',
    } })
    try {
      const edit = new NextRequest('http://test/api/memories', {
        method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: memory.id, text: 'Updated own fact' }),
      })
      expect((await patchMemory(edit)).status).toBe(200)
      expect((await db.agentMemory.findUniqueOrThrow({ where: { id: memory.id } })).text).toBe('Updated own fact')
      expect((await deleteMemory(request(`/api/memories?id=${memory.id}`, 'DELETE'))).status).toBe(200)
    } finally { await db.agentMemory.deleteMany({ where: { id: memory.id } }) }
  })

  test('foreign plugin cannot be toggled or deleted using an object ID', async () => {
    config()
    const plugin = await db.customTool.create({ data: {
      businessId: other.businessId, userId: other.id, kind: 'plugin', name: 'Foreign plugin', config: '{}', active: true,
    } })
    try {
      const edit = new NextRequest('http://test/api/plugins', {
        method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: plugin.id, active: false }),
      })
      expect((await patchPlugin(edit)).status).toBe(404)
      expect((await deletePlugin(request(`/api/plugins?id=${plugin.id}`, 'DELETE'))).status).toBe(404)
      expect((await db.customTool.findUniqueOrThrow({ where: { id: plugin.id } })).active).toBe(true)
    } finally { await db.customTool.delete({ where: { id: plugin.id } }) }
  })

  test('scheduled and background tasks reject foreign conversations before creating work', async () => {
    config()
    const conversation = await db.conversation.create({ data: { businessId: other.businessId, userId: other.id, title: 'Foreign' } })
    try {
      const before = await db.scheduledTask.count()
      const body = { businessId: owner.businessId, userId: owner.id, conversationId: conversation.id,
        title: 'test task', tool: 'remind', jobKinds: ['scan_risks_and_opportunities'] }
      for (const [path, handler] of [
        ['/api/tasks', scheduleTask], ['/api/background-tasks', backgroundTask],
      ] as const) {
        const req = new NextRequest(`http://test${path}`, { method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
        expect((await handler(req)).status).toBe(404)
      }
      expect(await db.scheduledTask.count()).toBe(before)
      expect(await db.message.count({ where: { conversationId: conversation.id } })).toBe(0)
    } finally { await db.conversation.delete({ where: { id: conversation.id } }) }
  })

  test('background engine itself refuses a foreign conversation before side effects', async () => {
    config()
    const conversation = await db.conversation.create({ data: { businessId: other.businessId, userId: other.id, title: 'Foreign engine target' } })
    try {
      const before = await db.scheduledTask.count()
      await expect(dispatchConcurrentBackgroundJobs({ businessId: owner.businessId, userId: owner.id,
        conversationId: conversation.id, jobKinds: ['scan_risks_and_opportunities'] })).rejects.toThrow('المحادثة')
      expect(await db.scheduledTask.count()).toBe(before)
    } finally { await db.conversation.delete({ where: { id: conversation.id } }) }
  })

  test('revocation takes effect on the next request without cached identity', async () => {
    config()
    expect(tokenAccepted(request())).toBe(true)
    process.env.WAKIL_AUTH_CREDENTIALS = '[]'
    expect(tokenAccepted(request())).toBe(false)
  })
})

test('audio routes require authenticated actor identity before reading or uploading audio', async () => {
  config()
  expect((await speechStatus(new Request('http://test/api/speech'))).status).toBe(401)
  expect((await speechUpload(new Request('http://test/api/speech', { method: 'POST' }))).status).toBe(401)
})
