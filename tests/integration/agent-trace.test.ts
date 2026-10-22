// R73 / PR-005 — الخطة النهائية v2 §20.6: append-only سجل أحداث الوكيل.
//
// Gates accepted here:
//   • a request is traceable from start to finish (trace + sequence + types);
//   • secrets are REDACTED before they reach the ledger;
//   • the ledger is APPEND-ONLY — no mutation surface exists;
//   • zero cross-tenant: one business can never read another's trace;
//   • the live turn path really writes the trace (wiring, not a promise).
process.env.WAKIL_OFFLINE = '1'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { testDb } from '../helpers/test-db'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let events: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let harness: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let business: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let other: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let owner: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let conv: any

beforeAll(async () => {
  db = await testDb()
  // import AFTER the shared test DB is wired (src/lib/db is a singleton)
  events = await import('../../src/lib/domain/agent-events')
  harness = await import('../../src/lib/agent/harness')
  business = await db.business.create({ data: { name: `trace-${randomUUID()}`, type: 'supermarket' } })
  other = await db.business.create({ data: { name: `trace-${randomUUID()}`, type: 'supermarket' } })
  owner = await db.user.create({ data: { businessId: business.id, name: 'owner', role: 'owner' } })
  conv = await db.conversation.create({ data: { businessId: business.id, userId: owner.id } })
})

afterAll(async () => {
  await db.business.deleteMany({ where: { id: { in: [business.id, other.id] } } })
  await db.$disconnect?.()
})

describe('redaction — the ledger is readable, never a secret dump', () => {
  test('phone / email / long opaque tokens are masked before storage', () => {
    const s = events.redactPayload({
      phone: '01012345678',
      email: 'owner@example.com',
      token: '9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c1234567890',
      note: 'سداد دفعة',
    })
    expect(s).not.toContain('01012345678')
    expect(s).not.toContain('owner@example.com')
    expect(s).not.toContain('9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c1234567890')
    expect(s).toContain('[phone]')
    expect(s).toContain('[email]')
    expect(s).toContain('[opaque]')
    expect(s).toContain('سداد دفعة') // business text survives
  })

  test('overlong non-secret payloads are truncated visibly (head/tail + charCount), never silently', () => {
    // spaces break the runs so this is long TEXT, not a single opaque token
    const s = events.redactPayload({ note: 'كلمة '.repeat(900) })
    const obj = JSON.parse(s)
    expect(obj.truncated).toBe(true)
    expect(obj.charCount).toBeGreaterThan(2000)
    expect(obj.head.length).toBeGreaterThan(0)
    expect(obj.tail.length).toBeGreaterThan(0)
  })

  test('a long opaque token is redacted to a marker, not truncated-and-stored-raw', () => {
    const s = events.redactPayload({ blob: 'x'.repeat(5000) })
    expect(s).not.toContain('x'.repeat(30))
    expect(s).toContain('[opaque]')
  })
})

describe('trace lifecycle — start to finish is reconstructable', () => {
  test('Prisma can read the fixture integrity before touching the event ledger', async () => {
    const integrity = await db.$queryRawUnsafe('PRAGMA integrity_check') as { integrity_check: string }[]
    expect(integrity).toEqual([{ integrity_check: 'ok' }])
    const foreignKeys = await db.$queryRawUnsafe('PRAGMA foreign_key_check') as unknown[]
    expect(foreignKeys).toHaveLength(0)
  })

  test('a turn trace carries ordered, typed rows', async () => {
    const traceId = await events.startTrace({ businessId: business.id, conversationId: conv.id })
    expect(traceId).toMatch(/^trc_/)
    await events.logAgentEvent({ businessId: business.id, traceId, conversationId: conv.id, type: 'tool.proposed', actor: 'model', payload: { tool: 'get_cash_position' } })
    await events.logAgentEvent({ businessId: business.id, traceId, conversationId: conv.id, type: 'tool.executed', actor: 'tool', payload: { tool: 'get_cash_position' } })
    await events.logAgentEvent({ businessId: business.id, traceId, type: 'turn.ended', actor: 'system', payload: { replyChars: 42 } })

    const rows = await events.reconstructTurn({ businessId: business.id, traceId })
    expect(rows.map((r: any) => r.sequence)).toEqual([0, 1, 2, 3])
    expect(rows[0].type).toBe('turn.started')
    expect(rows[1].type).toBe('tool.proposed')
    expect(rows[1].actor).toBe('model')
    expect(rows[3].type).toBe('turn.ended')
  })

  test('concurrent appends in one trace never collide on sequence', async () => {
    const traceId = await events.startTrace({ businessId: business.id, conversationId: conv.id })
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        events.logAgentEvent({ businessId: business.id, traceId, type: 'tool.executed', actor: 'tool', payload: { n: i } }),
      ),
    )
    const rows = await events.reconstructTurn({ businessId: business.id, traceId })
    const seqs = rows.map((r: any) => r.sequence).sort((a: number, b: number) => a - b)
    expect(new Set(seqs).size).toBe(seqs.length) // no duplicate sequence
    expect(rows.length).toBe(6) // start + 5
  })

  test('the ledger is append-only: no mutation surface, count only grows', async () => {
    const mutating = Object.keys(events).filter(
      (k) => /update|delete|remove|patch|clear|reset/i.test(k),
    )
    expect(mutating).toEqual([])
    const traceId = await events.startTrace({ businessId: business.id, conversationId: conv.id })
    const before = (await events.reconstructTurn({ businessId: business.id, traceId })).length
    await events.logAgentEvent({ businessId: business.id, traceId, type: 'correction', actor: 'user', payload: { note: 'صححت المبلغ' } })
    const after = (await events.reconstructTurn({ businessId: business.id, traceId })).length
    expect(after).toBe(before + 1)
  })
})

describe('tenant scope — zero cross-tenant (SLO)', () => {
  test('another business can neither read the trace nor see it in its list', async () => {
    const traceId = await events.startTrace({ businessId: business.id, conversationId: conv.id })
    await events.logAgentEvent({ businessId: business.id, traceId, type: 'tool.executed', actor: 'tool', payload: { tool: 'get_daily_summary' } })
    expect((await events.reconstructTurn({ businessId: other.id, traceId })).length).toBe(0)
    expect(await events.listRecentTraces({ businessId: other.id })).toEqual([])
    const mine = await events.listRecentTraces({ businessId: business.id })
    expect(mine.some((t: any) => t.traceId === traceId)).toBe(true)
  })
})

describe('live wiring — a real turn writes its trace', () => {
  test('runAgentTurn appends turn.started … turn.ended (offline deterministic path)', async () => {
    const before = await events.listRecentTraces({ businessId: business.id })
    const out = await harness.runAgentTurn(
      { business, user: owner, conversationId: conv.id, modelKey: null, text: 'ملخص النهارده', history: [], turnId: randomUUID() },
      () => {},
    )
    expect(out.replyText.length).toBeGreaterThan(0)
    const after = await events.listRecentTraces({ businessId: business.id })
    const fresh = after.find((t: any) => !before.some((p: any) => p.traceId === t.traceId))
    expect(fresh, 'a new trace must appear for the turn').toBeTruthy()
    const rows = await events.reconstructTurn({ businessId: business.id, traceId: fresh.traceId })
    const types = rows.map((r: any) => r.type)
    expect(types[0]).toBe('turn.started')
    expect(types).toContain('turn.ended')
    // sequences strictly ordered
    const seqs = rows.map((r: any) => r.sequence)
    expect(seqs.every((s: number, i: number) => i === 0 || s > seqs[i - 1])).toBe(true)
  })
})
