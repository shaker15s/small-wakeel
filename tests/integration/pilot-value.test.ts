// وكيل — PR-015 (plan v2 §13 pilot): «سجل خط أساس وبعدي لكل نشاط يوضح الوقت
// الفعلي للمهام، السجلات الناقصة، التصحيحات، حالات المتابعة، الأخطاء،
// وتكلفة التشغيل» + «بوابة GO».
//
// Every number in the pilot report is MEASURED from an append-only ledger or
// is an owner-reported baseline. Unknowns are `null` («غير مسجل»), never
// 0-as-unknown. Tenant isolation is absolute. The release gate script must
// run and report an honest NO-GO in this (mock-only) environment.
import { beforeAll, afterAll, test, expect } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testDb } from '../helpers/test-db'
import { GET } from '@/app/api/pilot/route'
import { POST as recordBaseline } from '@/app/api/pilot/baseline/route'
import { compareBaselineToPost } from '@/lib/pilot'

const db = await testDb()
let businessId: string, userId: string, otherBusinessId: string, otherUserId: string
const headers = (biz: string, user: string) => ({ 'x-wakil-business': biz, 'x-wakil-user': user })

const t0 = Date.parse('2026-10-10T00:00:00.000Z')
const at = (ms: number) => new Date(t0 + ms)

beforeAll(async () => {
  businessId = (await db.business.create({ data: { name: randomUUID(), type: 'attar' } })).id
  userId = (await db.user.create({ data: { businessId, name: 'مالك البايロット', role: 'owner' } })).id
  otherBusinessId = (await db.business.create({ data: { name: randomUUID(), type: 'gym' } })).id
  otherUserId = (await db.user.create({ data: { businessId: otherBusinessId, name: 'مالك آخر', role: 'owner' } })).id

  // — measured ledger for business A —
  // two completed turns: 5,000ms and 15,000ms (real createdAt deltas)
  await db.agentEvent.createMany({
    data: [
      { businessId, traceId: 'tr1', sequence: 0, type: 'turn.started', actor: 'user', payload: '{}', createdAt: at(0) },
      { businessId, traceId: 'tr1', sequence: 1, type: 'tool.proposed', actor: 'model', payload: '{}', createdAt: at(500) },
      { businessId, traceId: 'tr1', sequence: 2, type: 'tool.executed', actor: 'tool', payload: JSON.stringify({ tool: 'record_sale' }), createdAt: at(2000) },
      { businessId, traceId: 'tr1', sequence: 3, type: 'turn.ended', actor: 'system', payload: '{}', createdAt: at(5000) },
      { businessId, traceId: 'tr2', sequence: 0, type: 'turn.started', actor: 'user', payload: '{}', createdAt: at(60_000) },
      { businessId, traceId: 'tr2', sequence: 1, type: 'tool.executed', actor: 'tool', payload: JSON.stringify({ tool: 'record_sale' }), createdAt: at(70_000) },
      { businessId, traceId: 'tr2', sequence: 2, type: 'tool.refused', actor: 'system', payload: '{}', createdAt: at(71_000) },
      { businessId, traceId: 'tr2', sequence: 3, type: 'tool.failed', actor: 'tool', payload: '{}', createdAt: at(72_000) },
      { businessId, traceId: 'tr2', sequence: 4, type: 'provider.error', actor: 'system', payload: '{}', createdAt: at(73_000) },
      { businessId, traceId: 'tr2', sequence: 5, type: 'correction', actor: 'user', payload: '{}', createdAt: at(74_000) },
      { businessId, traceId: 'tr2', sequence: 6, type: 'turn.ended', actor: 'system', payload: '{}', createdAt: at(75_000) },
      // an orphaned turn (started, no ended) — must NOT be counted
      { businessId, traceId: 'tr3', sequence: 0, type: 'turn.started', actor: 'user', payload: '{}', createdAt: at(90_000) },
    ],
  })
  // clarifications measured from the follow-up queue (conversationId is an FK)
  const c1 = (await db.conversation.create({ data: { businessId, userId } })).id
  const c2 = (await db.conversation.create({ data: { businessId, userId } })).id
  await db.pendingRequest.createMany({
    data: [
      { businessId, conversationId: c1, userId, kind: 'purchase_new_item', question: 'السعر كام؟', status: 'awaiting', expiresAt: at(999_000) },
      { businessId, conversationId: c2, userId, kind: 'purchase_new_item', question: 'من المزوّد؟', status: 'resolved', expiresAt: at(999_000) },
    ],
  })
  // operations: one approved+succeeded (fine), one SUCCEEDED WITHOUT approval
  // (a release blocker the report must surface), one awaiting approval
  await db.operation.createMany({
    data: [
      { id: 'op1', ref: 'WKL-9001', businessId, userId, type: 'sale', status: 'SUCCEEDED', risk: 'R2', summary: 'بيع معتمد', payload: '{}', idempotencyKey: 'k1', createdAt: at(100_000) },
      { id: 'op2', ref: 'WKL-9002', businessId, userId, type: 'expense', status: 'SUCCEEDED', risk: 'R2', summary: 'مصروف بلا اعتماد (خطأ مقصود في البذرة)', payload: '{}', idempotencyKey: 'k2', createdAt: at(101_000) },
      { id: 'op3', ref: 'WKL-9003', businessId, userId, type: 'purchase', status: 'AWAITING_APPROVAL', risk: 'R2', summary: 'بانتظار الاعتماد', payload: '{}', idempotencyKey: 'k3', createdAt: at(102_000) },
    ],
  })
  await db.auditEvent.createMany({
    data: [{ businessId, actor: userId, action: 'operation.approved', ref: 'WKL-9001', detail: '{}' }],
  })
  await db.usageEvent.createMany({
    data: [
      { businessId, userId, kind: 'chat', label: 'turn', latencyMs: 5000, tokens: 300, fallback: false, createdAt: at(10_000) },
      { businessId, userId, kind: 'tool', label: 'record_sale', latencyMs: 900, tokens: null, fallback: true, createdAt: at(20_000) },
      { businessId, userId, kind: 'chat', label: 'turn', latencyMs: 15000, tokens: 500, fallback: false, createdAt: at(30_000) },
    ],
  })
  await db.scheduledTask.createMany({
    data: [
      { businessId, userId, title: 'تذكير عالق', tool: 'notify', fields: '{}', whenLabel: 'غدًا', scheduledFor: at(200_000), status: 'pending' },
      { businessId, userId, title: 'مهمة فاشلة', tool: 'notify', fields: '{}', whenLabel: 'اليوم', scheduledFor: at(150_000), status: 'failed' },
    ],
  })
  // a baseline with an UNKNOWN minutes — must stay null, never 0
  await db.pilotBaseline.create({
    data: { businessId, workflow: 'إقفال الكاش', tasksCount: 20, minutes: null, errors: 3, recordedBy: userId, note: 'المدة غير مسجلة' },
  })
})
afterAll(async () => {
  await db.business.delete({ where: { id: businessId } })
  await db.business.delete({ where: { id: otherBusinessId } })
})

test('the value report measures what the ledgers hold — and says «غير مسجل» for the rest', async () => {
  const res = await GET(new Request(`http://localhost/api/pilot?businessId=${businessId}&days=30`, { headers: headers(businessId, userId) }))
  expect(res.status).toBe(200)
  const r = await res.json()

  // turns: exactly the two COMPLETED turns (the orphaned one is not counted)
  expect(r.turns.count).toBe(2)
  expect(r.turns.p50Ms).toBe(5000)
  expect(r.turns.p95Ms).toBe(15000)

  // tools / errors / corrections — measured, not estimated
  expect(r.toolsExecuted.count).toBe(2)
  expect(r.toolsExecuted.byLabel.record_sale).toBe(2)
  expect(r.toolRefusals.count).toBe(1)
  expect(r.toolFailures.count).toBe(1)
  expect(r.providerErrors.count).toBe(1)
  expect(r.corrections.count).toBe(1)

  // clarifications from the follow-up queue
  expect(r.clarifications.count).toBe(2)
  expect(r.clarifications.awaiting).toBe(1)
  expect(r.clarifications.resolved).toBe(1)

  // financial safety: the unapproved SUCCEEDED op MUST be surfaced
  expect(r.operations.total).toBe(3)
  expect(r.operations.byStatus.SUCCEEDED).toBe(2)
  expect(r.operations.byStatus.AWAITING_APPROVAL).toBe(1)
  expect(r.operations.succeededWithoutApproval).toBe(1)

  // stuck work + fallbacks
  expect(r.stuckTasks.count).toBe(2)
  expect(r.stuckTasks.byStatus.pending).toBe(1)
  expect(r.stuckTasks.byStatus.failed).toBe(1)
  expect(r.fallbacks.count).toBe(1)
  expect(r.fallbacks.totalEvents).toBe(3)

  // cost: tokens are recorded but MONEY is not measured → honest null
  expect(r.costUsd.value).toBeNull()
  expect(r.costUsd.measured).toBe(false)
  expect(r.costUsd.note).toContain('غير مسجل')

  // baselines: owner-reported, and the unknown minutes stay null
  expect(r.baselines.length).toBe(1)
  expect(r.baselines[0].source).toBe('owner_reported')
  expect(r.baselines[0].minutes).toBeNull()
  expect(r.baselines[0].tasksCount).toBe(20)
})

test('tenant isolation: another business sees an EMPTY report, and cannot read this one', async () => {
  const res = await GET(new Request(`http://localhost/api/pilot?businessId=${otherBusinessId}`, { headers: headers(otherBusinessId, otherUserId) }))
  expect(res.status).toBe(200)
  const r = await res.json()
  expect(r.turns.count).toBe(0)
  expect(r.operations.total).toBe(0)
  expect(r.baselines.length).toBe(0)
  expect(r.costUsd.value).toBeNull()

  // A's credentials cannot read B's report (actor scope guard)
  const cross = await GET(new Request(`http://localhost/api/pilot?businessId=${otherBusinessId}`, { headers: headers(otherBusinessId, userId) }))
  expect(cross.status).toBe(403)
})

test('baseline recording: owner-reported facts with validation — unknowns stay null, never 0', async () => {
  const ok = await recordBaseline(new Request('http://localhost/api/pilot/baseline', {
    method: 'POST', headers: { ...headers(businessId, userId), 'content-type': 'application/json' },
    body: JSON.stringify({ businessId, workflow: 'تقارير نهاية اليوم', tasksCount: 10, minutes: 25, note: 'قياس يدوي قبل التشغيل' }),
  }))
  expect(ok.status).toBe(201)
  const { source, recorded } = await ok.json()
  expect(source).toBe('owner_reported')
  expect(recorded).toBe(true)

  // unknown field → null accepted (honest), not coerced to 0
  const partial = await recordBaseline(new Request('http://localhost/api/pilot/baseline', {
    method: 'POST', headers: { ...headers(businessId, userId), 'content-type': 'application/json' },
    body: JSON.stringify({ businessId, workflow: 'تقارير نهاية اليوم', minutes: null }),
  }))
  expect(partial.status).toBe(201)

  const res = await GET(new Request(`http://localhost/api/pilot?businessId=${businessId}`, { headers: headers(businessId, userId) }))
  const r = await res.json()
  const rows = r.baselines.filter((b: { workflow: string }) => b.workflow === 'تقارير نهاية اليوم')
  expect(rows.length).toBe(2)
  expect(rows.some((b: { minutes: number | null }) => b.minutes === null)).toBe(true)
  expect(rows.some((b: { minutes: number | null; tasksCount: number | null }) => b.minutes === 25 && b.tasksCount === 10)).toBe(true)

  // validation
  expect((await recordBaseline(new Request('http://localhost/api/pilot/baseline', {
    method: 'POST', headers: { ...headers(businessId, userId), 'content-type': 'application/json' },
    body: JSON.stringify({ businessId }),
  }))).status).toBe(400)
  expect((await recordBaseline(new Request('http://localhost/api/pilot/baseline', {
    method: 'POST', headers: { ...headers(businessId, userId), 'content-type': 'application/json' },
    body: JSON.stringify({ businessId, workflow: 'خ', minutes: -5 }),
  }))).status).toBe(400)
})

test('before/after comparison: missing sides are reported missing, never padded with zeros', async () => {
  const noBaseline = compareBaselineToPost(null, { turns: { count: 2, p50Ms: 5000, p95Ms: 15000 }, corrections: { count: 1 } })
  expect(noBaseline.baselineSource).toBeNull()
  expect(noBaseline.minutesPerTask.before).toBeNull()
  expect(noBaseline.minutesPerTask.after).toBeNull()
  expect(noBaseline.note).toContain('لا خط أساس')

  const withBaseline = compareBaselineToPost(
    { id: 'b', businessId, workflow: 'إقفال الكاش', tasksCount: 20, minutes: 30, errors: 3, note: null, recordedBy: userId, createdAt: new Date() },
    { turns: { count: 2, p50Ms: 5000, p95Ms: 15000 }, corrections: { count: 1 } },
  )
  expect(withBaseline.baselineSource).toBe('owner_reported')
  expect(withBaseline.minutesPerTask.before).toBe(30)
  expect(withBaseline.minutesPerTask.after).toBeCloseTo(5000 / 60000, 6)
  expect(withBaseline.note).toContain('قياس المالك')

  const missingAfter = compareBaselineToPost(
    { id: 'b', businessId, workflow: 'إقفال الكاش', tasksCount: 20, minutes: 30, errors: 3, note: null, recordedBy: userId, createdAt: new Date() },
    { turns: { count: 0, p50Ms: null, p95Ms: null }, corrections: { count: 0 } },
  )
  expect(missingAfter.minutesPerTask.after).toBeNull()
  expect(missingAfter.note).toContain('غير مسجل')
})

test('the release gate runs and reports an HONEST verdict — no auto-GO, never fake evidence', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pilot-gate-test-'))
  const reportPath = join(tmp, 'gate.json')
  const code = await new Promise<number>((res) => {
    const child = spawn(process.execPath, ['scripts/pilot-gate.mjs', '--report', reportPath], {
      cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.on('close', res)
  })
  try {
    const r = JSON.parse(readFileSync(reportPath, 'utf8'))
    // The gate process exits nonzero for NO-GO; that is a correct verdict, not
    // a failed test runner. Only GO_CANDIDATE returns zero, and never auto-GO.
    expect(code).toBe(r.overall === 'GO_CANDIDATE' ? 0 : 1)
    // the verdict is one of the two honest states — never an auto 'GO'
    expect(['NO-GO', 'GO_CANDIDATE']).toContain(r.overall)
    // this sandbox has a mock model endpoint → item 3 can never be 'met' here
    const item3 = r.items.find((i: { id: string }) => i.id === '3_model_acceptance_live')
    expect(item3.status).toBe('not_met')
    expect(item3.evidence.join(' ')).toContain('mock')
    // every item carries a status + evidence — nothing is asserted without proof
    for (const i of r.items) {
      expect(['met', 'not_met', 'not_evidenced']).toContain(i.status)
      expect(Array.isArray(i.evidence) && i.evidence.length > 0).toBe(true)
    }
    expect(r.met).toBe(`${r.items.filter((i: { status: string }) => i.status === 'met').length}/${r.items.length}`)
    // an honest verdict states what it is; NO-GO says the release stays NO-GO
    if (r.overall === 'NO-GO') expect(r.decision).toContain('NO-GO')
    if (r.overall === 'GO_CANDIDATE') expect(r.decision).toContain('DOCUMENTED OWNER APPROVAL')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
