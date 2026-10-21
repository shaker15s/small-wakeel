// R71 / PR-003 — الخطة النهائية v2 §20.4: «موافقة مالية مرتبطة بالـpayload».
//
// The approved bytes are the executed bytes:
//   • every draft carries a canonical payloadHash + an approval window;
//   • a draft that changed after it was recorded is REFUSED (recorded
//     FAILED_SAFE + audit) — no financial effect;
//   • a draft older than the window is CANCELLED on approval;
//   • the idempotency key is bound to ITS payload (replay yes, collision no);
//   • double / concurrent approvals produce exactly ONE effect.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Business, User } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { testDb } from '../helpers/test-db'
import { createDraft, executeOperation, DRAFT_TTL_MS } from '@/lib/domain/executors'
import { OperationConflictError, OperationValidationError } from '@/lib/domain/errors'
import { AuthorizationError } from '@/lib/security/permissions'

process.env.WAKIL_OFFLINE = '1'

let db: Awaited<ReturnType<typeof testDb>>
let business: Business
let foreign: Business
let owner: User
let outsider: User
const key = () => `approval-bind-${randomUUID()}`

beforeAll(async () => {
  db = await testDb()
  business = await db.business.create({ data: { name: key(), type: 'supermarket' } })
  foreign = await db.business.create({ data: { name: key(), type: 'supermarket' } })
  owner = await db.user.create({ data: { businessId: business.id, name: 'owner', role: 'owner' } })
  outsider = await db.user.create({ data: { businessId: foreign.id, name: 'outsider', role: 'owner' } })
})

afterAll(async () => {
  await db.business.deleteMany({ where: { id: { in: [business.id, foreign.id] } } })
  await db.$disconnect?.()
})

async function expense(total: number) {
  return createDraft({
    businessId: business.id, userId: owner.id, type: 'expense', summary: key(),
    payload: { total }, idempotencyKey: key(),
  })
}
async function cashCount(ref: string) {
  return db.cashEntry.count({ where: { businessId: business.id, ref } })
}

describe('draft binding — every draft carries its hash and window', () => {
  test('a fresh draft has a 64-hex payloadHash and a 20-minute window', async () => {
    const op = await expense(5000)
    expect(op.payloadHash).toMatch(/^[0-9a-f]{64}$/)
    expect(op.expiresAt).not.toBeNull()
    const ttl = (op.expiresAt as Date).getTime() - op.createdAt.getTime()
    expect(ttl).toBeGreaterThanOrEqual(DRAFT_TTL_MS - 2000)
    expect(ttl).toBeLessThanOrEqual(DRAFT_TTL_MS + 5000)
  })

  test('same key + same payload replays the SAME draft; different payload is refused', async () => {
    const first = await expense(7000)
    const replay = await createDraft({
      businessId: business.id, userId: owner.id, type: 'expense', summary: key(),
      payload: { total: 7000 }, idempotencyKey: first.idempotencyKey,
    })
    expect(replay.id).toBe(first.id)
    await expect(
      createDraft({
        businessId: business.id, userId: owner.id, type: 'expense', summary: key(),
        payload: { total: 999999 }, idempotencyKey: first.idempotencyKey,
      }),
    ).rejects.toBeInstanceOf(OperationValidationError)
    expect(await db.operation.count({ where: { idempotencyKey: first.idempotencyKey } })).toBe(1)
  })
})

describe('approval — bound to the recorded bytes, bounded in time', () => {
  test('a matching payload still executes (happy path anchor)', async () => {
    const op = await expense(3000)
    const { outcome } = await executeOperation(op.id, owner.id)
    expect(outcome.ok).toBe(true)
    expect(await cashCount(op.ref)).toBe(1)
  })

  test('changing the amount after the draft is recorded → approval refused, nothing written', async () => {
    const op = await expense(10000)
    // direct tamper of the stored draft (the attack the hash exists for)
    await db.operation.update({ where: { id: op.id }, data: { payload: JSON.stringify({ total: 1 }) } })
    const { op: after, outcome } = await executeOperation(op.id, owner.id)
    expect(outcome.ok).toBe(false)
    expect(String(outcome.failReason ?? '')).toContain('payloadHash')
    expect(after.status).toBe('FAILED_SAFE')
    expect(await cashCount(op.ref)).toBe(0) // no financial effect
    // the tamper is a recorded audit fact, not a silent no-op
    expect(after.failReason).toContain('معدلة')
  })

  test('a draft older than the window is CANCELLED on approval, nothing written', async () => {
    const op = await expense(4000)
    await db.operation.update({ where: { id: op.id }, data: { expiresAt: new Date(Date.now() - 60_000) } })
    const { op: after, outcome } = await executeOperation(op.id, owner.id)
    expect(outcome.ok).toBe(false)
    expect(String(outcome.failReason ?? '')).toContain('صلاحية')
    expect(after.status).toBe('CANCELLED')
    expect(await cashCount(op.ref)).toBe(0)
  })

  test('two approvals on two different operations — binding is per-operation', async () => {
    const a = await expense(2000)
    const b = await expense(2500)
    await db.operation.update({ where: { id: a.id }, data: { payload: JSON.stringify({ total: 1 }) } })
    const { op: aAfter } = await executeOperation(a.id, owner.id)
    const { op: bAfter, outcome: bOutcome } = await executeOperation(b.id, owner.id)
    expect(aAfter.status).toBe('FAILED_SAFE') // tampered one is dead
    expect(bOutcome.ok).toBe(true) // the clean one still executes
    expect(bAfter.status).toBe('SUCCEEDED')
    expect(await cashCount(a.ref)).toBe(0)
    expect(await cashCount(b.ref)).toBe(1)
  })

  test('an outsider tenant cannot approve', async () => {
    const op = await expense(6000)
    await expect(executeOperation(op.id, outsider.id)).rejects.toBeInstanceOf(AuthorizationError)
    expect((await db.operation.findUniqueOrThrow({ where: { id: op.id } })).status).toBe('AWAITING_APPROVAL')
  })

  test('double-press: a second approval after success is a conflict, ONE effect', async () => {
    const op = await expense(8000)
    const { outcome: first } = await executeOperation(op.id, owner.id)
    expect(first.ok).toBe(true)
    await expect(executeOperation(op.id, owner.id)).rejects.toBeInstanceOf(OperationConflictError)
    expect(await cashCount(op.ref)).toBe(1)
  })

  test('two concurrent approvals: exactly one wins, exactly one effect', async () => {
    const op = await expense(9000)
    const results = await Promise.allSettled([
      executeOperation(op.id, owner.id),
      executeOperation(op.id, owner.id),
    ])
    const ok = results.filter((r) => r.status === 'fulfilled' && (r as { value: { outcome: { ok: boolean } } }).value.outcome.ok)
    expect(ok.length).toBe(1)
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(rejected.length).toBe(1)
    expect((rejected[0] as { reason: Error }).reason).toBeInstanceOf(OperationConflictError)
    expect(await cashCount(op.ref)).toBe(1)
  })
})
