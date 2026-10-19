import { afterAll, beforeAll, expect, test } from 'bun:test'
import { randomUUID, createHash } from 'node:crypto'
import { NextRequest } from 'next/server'
import { testDb } from '../helpers/test-db'
import { getWorkspacePreferences, updateWorkspacePreferences } from '@/lib/workspace-preferences'
import { AuthorizationError } from '@/lib/security/permissions'
import { buildSuggestions } from '@/lib/agent/suggest'
import { createNewBusinessWithDefaults } from '@/lib/domain/business-builder'
import { POST as analyzeOnboarding } from '@/app/api/onboarding/analyze/route'
import { GET, PATCH } from '@/app/api/workspace/preferences/route'
import { resetRateLimiter } from '@/lib/security/rateLimit'
const db = await testDb()
let businessId: string, owner: string, staff: string, foreignId: string, foreign: string
const created: string[] = []
beforeAll(async () => {
  const b = await createNewBusinessWithDefaults({ name: randomUUID(), type: 'supermarket' }); businessId = b.id; owner = b.users[0].id; created.push(b.id)
  staff = (await db.user.create({ data: { businessId, name: 'staff', role: 'cashier' } })).id
  const f = await createNewBusinessWithDefaults({ name: randomUUID(), type: 'gym' }); foreignId = f.id; foreign = f.users[0].id; created.push(f.id)
})
afterAll(async () => { await db.business.deleteMany({ where: { id: { in: created } } }) })
test('new real business has no demo stock, customers, suppliers, employees, chips or invented cash', async () => {
  expect((await db.business.findUniqueOrThrow({ where: { id: businessId } })).openingCash).toBe(0)
  for (const model of [db.item, db.customer, db.supplier, db.quickCommand]) expect(await (model as typeof db.item).count({ where: { businessId } })).toBe(0)
  expect(await db.user.count({ where: { businessId, role: 'owner' } })).toBe(1)
  expect(await db.user.count({ where: { businessId, name: 'مسؤول الوردية' } })).toBe(0)
})
test('explicit names do not invent prices or stock; invalid money creates no partial business', async () => {
  const b = await createNewBusinessWithDefaults({ name: randomUUID(), type: 'clothing', customItems: ['اسم فعلي supplied'] }); created.push(b.id)
  const it = await db.item.findFirstOrThrow({ where: { businessId: b.id } })
  expect([it.costPrice, it.sellPrice, it.stockQty]).toEqual([0, 0, 0])
  const name = randomUUID()
  await expect(createNewBusinessWithDefaults({ name, type: 'attar', openingCashEgp: NaN })).rejects.toThrow()
  expect(await db.business.count({ where: { name } })).toBe(0)
})
test('profile persists per actor/tenant, audits fields, and never mutates financial balances', async () => {
  const p = await updateWorkspacePreferences(businessId, staff, { accent: 'indigo', density: 'compact', responseMode: 'deep', onboardingComplete: true, goals: ['cash'] })
  expect(p.accent).toBe('indigo')
  expect((await getWorkspacePreferences(businessId, staff)).responseMode).toBe('deep')
  expect((await getWorkspacePreferences(businessId, owner)).onboardingComplete).toBe(false)
  expect((await getWorkspacePreferences(foreignId, foreign)).accent).toBe('amber')
  expect(await db.auditEvent.count({ where: { businessId, actor: staff, action: 'workspace.personalized' } })).toBe(1)
  expect(await db.cashEntry.count({ where: { businessId } })).toBe(0)
  expect(await db.operation.count({ where: { businessId } })).toBe(0)
})
test('cross-tenant, unknown roles, CSS, script, arbitrary colors, money and privilege patches fail closed', async () => {
  await expect(updateWorkspacePreferences(businessId, foreign, { accent: 'rose' })).rejects.toBeInstanceOf(AuthorizationError)
  const unknown = await db.user.create({ data: { businessId, name: 'unknown', role: 'admin' } })
  await expect(updateWorkspacePreferences(businessId, unknown.id, { accent: 'rose' })).rejects.toBeInstanceOf(AuthorizationError)
  for (const patch of [{ accent: '#ffffff' }, { role: 'owner' }, { css: 'body{display:none}' }, { openingCash: 100000 }, { script: 'eval(1)' }, { goals: ['invented'] }]) await expect(updateWorkspacePreferences(businessId, owner, patch)).rejects.toThrow()
  expect((await getWorkspacePreferences(businessId, owner)).accent).toBe('amber')
})
test('empty actor gets no demos or clock-based invented commands; declared goals are explicit', async () => {
  // R46: an empty actor gets no invented activity — the single affordance is the
  // permission-first «connect my program» chip (owner only), and its prompt must
  // demand explicit consent before anything runs on the owner's machine.
  const ownerSuggestions = await buildSuggestions(businessId, owner)
  expect(ownerSuggestions.map((s) => s.id)).toEqual(['sg-harness-connect'])
  expect(ownerSuggestions[0].prompt).toContain('إذني')
  const suggestions = await buildSuggestions(businessId, staff)
  expect(suggestions.map((s) => s.id)).toEqual(['sg-goal-cash'])
})
test('real usage ranks safe drafts and READ recurrence proposals, never creates a schedule or leaks actors', async () => {
  await db.usageEvent.createMany({ data: Array.from({ length: 6 }, (_, i) => ({ businessId, userId: owner, kind: 'tool', label: 'get_cash_position', createdAt: new Date(Date.now() - (i % 3) * 86400000) })) })
  await db.usageEvent.createMany({ data: Array.from({ length: 3 }, () => ({ businessId, userId: owner, kind: 'tool', label: 'expense' })) })
  const suggestions = await buildSuggestions(businessId, owner)
  expect(suggestions.some((s) => s.id === 'sg-freq-get_cash_position')).toBe(true)
  expect(suggestions.some((s) => s.id === 'sg-schedule-get_cash_position' && s.prompt.includes('لا تنشئ'))).toBe(true)
  const draft = suggestions.find((s) => s.id === 'sg-freq-expense')!
  expect(draft.prompt).toContain('اسألني')
  expect(draft.prompt).not.toMatch(/\d|رجب|كهربا|عود/)
  expect(await db.scheduledTask.count({ where: { businessId } })).toBe(0)
  expect((await buildSuggestions(businessId, staff)).some((s) => s.id.startsWith('sg-freq'))).toBe(false)
  await db.usageEvent.createMany({ data: Array.from({ length: 6 }, () => ({ businessId, userId: staff, kind: 'tool', label: 'expense' })) })
  expect((await buildSuggestions(businessId, staff)).some((s) => s.id === 'sg-freq-expense' || s.id.startsWith('sg-schedule'))).toBe(false)
})
test('HTTP profile enforces actor auth, validation and same-origin protection', async () => {
  const saved = { ...process.env }
  try {
    Object.assign(process.env, { NODE_ENV: 'production', WAKIL_SAAS_ENABLED: '0', WAKIL_ACCESS_TOKEN: 'workspace-secret' })
    process.env.WAKIL_AUTH_CREDENTIALS = JSON.stringify([{ tokenHash: createHash('sha256').update('workspace-owner'.repeat(4)).digest('hex'), userId: owner }])
    resetRateLimiter()
    const req = (method: string, body?: object, origin = 'http://workspace.test') => new NextRequest(`http://workspace.test/api/workspace/preferences?businessId=${businessId}&userId=${owner}`, { method, headers: { host: 'workspace.test', origin, 'content-type': 'application/json', authorization: 'Bearer ' + 'workspace-owner'.repeat(4) }, ...(body ? { body: JSON.stringify({ businessId, userId: owner, ...body }) } : {}) })
    expect((await PATCH(req('PATCH', { accent: 'rose' }))).status).toBe(200)
    expect((await GET(req('GET'))).status).toBe(200)
    expect((await PATCH(req('PATCH', { accent: 'rose' }, 'https://evil.test'))).status).toBe(403)
    expect((await PATCH(req('PATCH', { userId: staff, accent: 'teal' }))).status).toBe(403)
    expect((await PATCH(req('PATCH', { role: 'owner' }))).status).toBe(400)
    expect((await PATCH(req('PATCH', { businessId: foreignId, userId: foreign, accent: 'teal' }))).status).toBe(403)
    process.env.WAKIL_OFFLINE = '1'
    process.env.WAKIL_AUTH_CREDENTIALS = JSON.stringify([{ tokenHash: createHash('sha256').update('workspace-owner'.repeat(4)).digest('hex'), userId: owner, admin: true }])
    const businessesBefore = await db.business.count()
    const analyze = await analyzeOnboarding(req('POST', { mode: 'analyze', imageBase64: 'x'.repeat(100), message: 'أضف بضائع مناسبة' }))
    expect(analyze.status).toBe(503)
    expect((await analyze.json()).extractedItems).toEqual([])
    expect((await analyzeOnboarding(req('POST', { mode: 'provision', openingCashEgp: 999999 }))).status).toBe(410)
    expect(await db.business.count()).toBe(businessesBefore)

  } finally { for (const key of ['NODE_ENV', 'WAKIL_SAAS_ENABLED', 'WAKIL_ACCESS_TOKEN', 'WAKIL_AUTH_CREDENTIALS', 'WAKIL_OFFLINE']) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key] }; resetRateLimiter() }
})
