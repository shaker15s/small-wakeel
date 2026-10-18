import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import type { Business, User } from '@prisma/client'
import { testDb } from '../helpers/test-db'
import { resetRateLimiter } from '@/lib/security/rateLimit'
import { createDraft, executeOperation, rejectOperation } from '@/lib/domain/executors'
import { AuthorizationError } from '@/lib/security/permissions'
import { upsertCatalogItemInDb } from '@/lib/domain/business-builder'
import { TaskManager } from '@/lib/agent/task-engine'
import { installOrUpdatePlugin, executePlugin, STARTER_PLUGIN_CATALOG } from '@/lib/agent/plugin-harness'
import { autoLearnFromUserMessage } from '@/lib/agent/vector-memory'
import { runAgentTurn } from '@/lib/agent/harness'
import { GET as exportData } from '@/app/api/export/route'
import { POST as importItems } from '@/app/api/items/import/route'
import { POST as restoreData } from '@/app/api/restore/route'
import { GET as listTools, POST as addTool, PATCH as patchTool, DELETE as deleteTool } from '@/app/api/tools/route'
import { POST as addMemory } from '@/app/api/memories/route'
import { POST as installPlugin } from '@/app/api/plugins/route'
import { GET as backgroundRead, POST as background } from '@/app/api/background-tasks/route'
import { POST as schedule } from '@/app/api/tasks/route'
import { POST as confirm } from '@/app/api/operations/[id]/confirm/route'
import { GET as notes, POST as addNote, PATCH as patchNote, DELETE as deleteNote } from '@/app/api/notes/route'
import { PATCH as editCommand, DELETE as deleteCommand } from '@/app/api/quick-commands/route'

const original = { ...process.env }
const token = 'role-test-token-not-a-real-credential-'.repeat(2)
let db: Awaited<ReturnType<typeof testDb>>
let business: Business
let owner: User
let cashier: User
let supervisor: User
function configure(user = cashier) {
  Object.assign(process.env, { NODE_ENV: 'production', WAKIL_OFFLINE: '1', WAKIL_AUTH_CREDENTIALS: JSON.stringify([
    { userId: user.id, tokenHash: createHash('sha256').update(token).digest('hex') },
  ]) })
}
function req(path: string, method = 'GET', body?: unknown) {
  return new NextRequest(`http://test${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
}
beforeAll(async () => {
  db = await testDb()
  business = await db.business.create({ data: { name: randomUUID(), type: 'supermarket' } })
  owner = await db.user.create({ data: { businessId: business.id, name: 'owner', role: 'owner' } })
  cashier = await db.user.create({ data: { businessId: business.id, name: 'cashier', role: 'cashier' } })
  supervisor = await db.user.create({ data: { businessId: business.id, name: 'supervisor', role: 'supervisor' } })
})
afterEach(() => {
  for (const key of ['NODE_ENV', 'WAKIL_AUTH_CREDENTIALS', 'WAKIL_OFFLINE', 'WAKIL_STRICT_APPROVALS']) {
    if (original[key] === undefined) delete process.env[key]
    else process.env[key] = original[key]
  }
  resetRateLimiter()
})
afterAll(async () => { await db.business.delete({ where: { id: business.id } }) })

test('same-tenant cashier is denied sensitive HTTP writes/export before any side effect', async () => {
  configure()
  const actor = { businessId: business.id, userId: cashier.id }
  const results = await Promise.all([
    exportData(req(`/api/export?businessId=${business.id}`)),
    importItems(req('/api/items/import', 'POST', { ...actor, csv: 'اسم,سعر البيع\nاختبار,50' })),
    restoreData(req('/api/restore', 'POST', { ...actor, mode: 'merge', items: [{ name: 'forbidden' }] })),
    addTool(req('/api/tools', 'POST', { ...actor, name: 'test', kind: 'webhook', config: { url: 'https://example.com' } })),
    addMemory(req('/api/memories', 'POST', { ...actor, text: 'forbidden shared policy', kind: 'rule' })),
    installPlugin(req('/api/plugins', 'POST', { ...actor, slug: STARTER_PLUGIN_CATALOG[0].slug })),
    background(req('/api/background-tasks', 'POST', { ...actor, jobKinds: ['upsert_catalog_batch'], catalogUpdates: [{ name: 'forbidden', sellPriceEgp: 1 }] })),
    schedule(req('/api/tasks', 'POST', { ...actor, title: 'forbidden', tool: 'get_daily_summary' })),
  ])
  expect(results.map((r) => r.status)).toEqual([403, 403, 403, 403, 403, 403, 403, 403])
  expect(await db.item.count({ where: { businessId: business.id } })).toBe(0)
  expect(await db.customTool.count({ where: { businessId: business.id } })).toBe(0)
  expect(await db.agentMemory.count({ where: { businessId: business.id } })).toBe(0)
  expect(await db.scheduledTask.count({ where: { businessId: business.id } })).toBe(0)
})

test('owner can export; supervisor can preview catalog restore but cannot bulk export', async () => {
  configure(owner)
  expect((await exportData(req(`/api/export?businessId=${business.id}`))).status).toBe(200)
  configure(supervisor)
  expect((await exportData(req(`/api/export?businessId=${business.id}`))).status).toBe(403)
  expect((await restoreData(req('/api/restore', 'POST', { businessId: business.id, userId: supervisor.id, mode: 'preview', items: [{ name: 'preview only' }] }))).status).toBe(200)
  expect(await db.item.count({ where: { businessId: business.id } })).toBe(0)
})

test('catalog helper and both background entrypoints refuse non-management direct calls', async () => {
  const manager = new TaskManager()
  const actor = { businessId: business.id, userId: cashier.id }
  await expect(upsertCatalogItemInDb({ ...actor, name: 'forbidden', sellPriceEgp: 1 })).rejects.toBeInstanceOf(AuthorizationError)
  await expect(manager.dispatchBatch({ ...actor, jobKinds: ['upsert_catalog_batch'], catalogUpdates: [{ name: 'forbidden' }] })).rejects.toBeInstanceOf(AuthorizationError)
  await expect(manager.enqueueJob({ ...actor, kind: 'upsert_catalog_batch', catalogUpdates: [{ name: 'forbidden' }] })).rejects.toBeInstanceOf(AuthorizationError)
  expect(await db.scheduledTask.count({ where: { businessId: business.id } })).toBe(0)
})

test('plugin install checks real actor, and a read never silently installs as owner', async () => {
  await expect(installOrUpdatePlugin({ businessId: business.id, userId: cashier.id, spec: STARTER_PLUGIN_CATALOG[0] })).rejects.toBeInstanceOf(AuthorizationError)
  await executePlugin({ businessId: business.id, pluginOrSlug: STARTER_PLUGIN_CATALOG[0].slug })
  expect(await db.customTool.count({ where: { businessId: business.id } })).toBe(0)
})

test('non-manager cannot train shared rules through implicit learning or forged stale role', async () => {
  expect(await autoLearnFromUserMessage({ businessId: business.id, userId: cashier.id, text: 'خلي بالك أنا مش ببيع بالدين أبداً' })).toBeNull()
  const conversation = await db.conversation.create({ data: { businessId: business.id, userId: cashier.id, title: 'staff' } })
  await expect(runAgentTurn({ business, user: { ...cashier, role: 'owner' }, conversationId: conversation.id, text: 'احفظ اني مش ببيع بالدين', modelKey: null, history: [] }, () => {})).rejects.toBeInstanceOf(AuthorizationError)
  expect(await db.agentMemory.count({ where: { businessId: business.id, kind: 'rule' } })).toBe(0)
})

test('same-tenant staff cannot approve/reject an expense or mutate its reason', async () => {
  configure()
  const op = await createDraft({ businessId: business.id, userId: owner.id, type: 'expense', summary: 'expense', payload: { total: 100 }, idempotencyKey: randomUUID() })
  for (const action of ['approve', 'reject', 'cancel']) {
    const response = await confirm(req(`/api/operations/${op.id}/confirm`, 'POST', { action, userId: cashier.id, reason: 'forbidden' }), { params: Promise.resolve({ id: op.id }) })
    expect(response.status).toBe(403)
  }
  expect((await db.operation.findUniqueOrThrow({ where: { id: op.id } })).reason).toBeNull()
  expect(await db.cashEntry.count({ where: { ref: op.ref } })).toBe(0)
})

test('strict approvals means management-only, not a false four-eyes guarantee; own cancellation works', async () => {
  process.env.WAKIL_STRICT_APPROVALS = '1'
  const it = await db.item.create({ data: { businessId: business.id, name: 'sale item', unit: 'piece', sellPrice: 100, stockQty: 5 } })
  const op = await createDraft({ businessId: business.id, userId: cashier.id, type: 'sale', summary: 'sale', payload: { itemId: it.id, qty: 1, total: 100 }, idempotencyKey: randomUUID() })
  await expect(executeOperation(op.id, cashier.id)).rejects.toBeInstanceOf(AuthorizationError)
  expect((await rejectOperation(op.id, cashier.id, 'changed mind', 'cancel')).status).toBe('CANCELLED')
  const ownerDraft = await createDraft({ businessId: business.id, userId: owner.id, type: 'expense', summary: 'expense', payload: { total: 100 }, idempotencyKey: randomUUID() })
  expect((await executeOperation(ownerDraft.id, owner.id)).op.status).toBe('SUCCEEDED')
})

test('R3 reason is required and is never overwritten by repeat approval/rejection', async () => {
  configure(owner)
  const op = await createDraft({ businessId: business.id, userId: owner.id, type: 'expense', summary: 'large expense', payload: { total: 1_000_000 }, idempotencyKey: randomUUID() })
  const approve = (reason?: string) => confirm(req(`/api/operations/${op.id}/confirm`, 'POST', { action: 'approve', userId: owner.id, reason }), { params: Promise.resolve({ id: op.id }) })
  expect((await approve()).status).toBe(400)
  expect((await approve('approved reason')).status).toBe(200)
  expect((await approve('overwritten')).status).toBe(409)
  expect((await db.operation.findUniqueOrThrow({ where: { id: op.id } })).reason).toBe('approved reason')
})

test('notes are private to conversation owner, even within one business', async () => {
  const conversation = await db.conversation.create({ data: { businessId: business.id, userId: owner.id, title: 'private' } })
  const note = await db.agentNote.create({ data: { businessId: business.id, userId: owner.id, conversationId: conversation.id, kind: 'fact', text: 'private note' } })
  configure()
  expect((await notes(req(`/api/notes?businessId=${business.id}&conversationId=${conversation.id}`))).status).toBe(404)
  expect((await addNote(req('/api/notes', 'POST', { businessId: business.id, userId: cashier.id, conversationId: conversation.id, kind: 'fact', text: 'inject' }))).status).toBe(404)
  expect((await patchNote(req('/api/notes', 'PATCH', { id: note.id, text: 'overwrite' }))).status).toBe(404)
  expect((await deleteNote(req(`/api/notes?id=${note.id}`, 'DELETE'))).status).toBe(404)
  const current = await db.agentNote.findUniqueOrThrow({ where: { id: note.id } })
  expect(current.text).toBe('private note')
  expect(current.active).toBe(true)
  configure(owner)
  expect((await patchNote(req('/api/notes', 'PATCH', { id: note.id, text: 'own edit' }))).status).toBe(200)
})

test('staff can touch a shared command but cannot rewrite/delete another user’s command', async () => {
  const command = await db.quickCommand.create({ data: { businessId: business.id, userId: owner.id, label: 'shared', prompt: 'read only' } })
  configure()
  expect((await editCommand(req('/api/quick-commands', 'PATCH', { id: command.id, touch: true }))).status).toBe(200)
  expect((await editCommand(req('/api/quick-commands', 'PATCH', { id: command.id, prompt: 'changed' }))).status).toBe(403)
  expect((await deleteCommand(req(`/api/quick-commands?id=${command.id}`, 'DELETE'))).status).toBe(403)
  expect((await db.quickCommand.findUniqueOrThrow({ where: { id: command.id } })).prompt).toBe('read only')
})

test('tool edits/deletion are denied by role even for own-business row IDs', async () => {
  const tool = await db.customTool.create({ data: { businessId: business.id, userId: owner.id, name: 'read tool', kind: 'web_source', config: '{"site":"example.com"}' } })
  configure()
  expect((await listTools(req(`/api/tools?businessId=${business.id}&userId=${cashier.id}`))).status).toBe(403)
  expect((await patchTool(req('/api/tools', 'PATCH', { id: tool.id, active: false }))).status).toBe(403)
  expect((await deleteTool(req(`/api/tools?id=${tool.id}`, 'DELETE'))).status).toBe(403)
  expect((await db.customTool.findUniqueOrThrow({ where: { id: tool.id } })).active).toBe(true)
})


test('background HTTP response keeps owner-only radar and saved job cards private from cashiers', async () => {
  const privateJob = await db.scheduledTask.create({ data: { businessId: business.id, userId: owner.id, title: 'owner-private-proof', tool: 'bg:scan_risks_and_opportunities', fields: '{}', whenLabel: 'test', scheduledFor: new Date(), status: 'done', result: JSON.stringify([{ kind: 'text', title: 'owner-private-proof', body: 'owner-private-proof' }]) } })
  const privateOps: { id: string }[] = []
  try {
    for (let i = 0; i < 2; i++) privateOps.push(await db.operation.create({ data: { businessId: business.id, userId: owner.id, ref: `private-${randomUUID()}`, type: 'expense', status: 'CANCELLED', risk: 'R2', summary: 'owner-private-proof', payload: '{}', idempotencyKey: randomUUID() } }))
    configure(cashier)
    const staffResponse = await backgroundRead(req(`/api/background-tasks?businessId=${business.id}`))
    expect(staffResponse.status).toBe(200)
    const staff = await staffResponse.json()
    expect(staff.jobs.some((j: { id: string }) => j.id === privateJob.id)).toBe(false)
    expect(staff.proactiveAlerts.some((a: { id: string }) => a.id.startsWith('radar-'))).toBe(false)
    expect(JSON.stringify(staff)).not.toContain('owner-private-proof')
    expect((await backgroundRead(req(`/api/background-tasks?businessId=${business.id}&userId=${owner.id}`))).status).toBe(403)
    configure(owner)
    const ownerResponse = await backgroundRead(req(`/api/background-tasks?businessId=${business.id}`))
    expect(ownerResponse.status).toBe(200)
    const mine = await ownerResponse.json()
    expect(mine.jobs.some((j: { id: string }) => j.id === privateJob.id)).toBe(true)
    expect(mine.proactiveAlerts.some((a: { id: string }) => a.id === 'radar-cancel-pattern')).toBe(true)
  } finally {
    await db.scheduledTask.delete({ where: { id: privateJob.id } })
    await db.operation.deleteMany({ where: { id: { in: privateOps.map(o => o.id) } } })
  }
})
