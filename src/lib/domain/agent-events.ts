// R73 / PR-005 — الخطة النهائية v2 §20.6: append-only سجل أحداث الوكيل.
//
// The financial audit (AuditEvent) stays separate — this ledger answers the
// OTHER question: «from start to finish, what did the AGENT do this turn?»
// turn start, routing decision, plan, tool proposed/refused, task transition,
// correction, provider error, reply result.
//
// Rules (plan):
//   • APPEND-ONLY — no update/delete path exists in this module;
//   • every row carries traceId + businessId (tenant) + a per-trace sequence;
//   • the payload is REDACTED before storage — long opaque tokens, phone
//     numbers and email addresses never land in the ledger raw;
//   • sensitive content is REFERENCED (operationRef → WKL-#### → AuditEvent)
//     and hashed (payloadHash), never duplicated in full;
//   • every read is tenant-scoped (zero cross-tenant, SLO).

import { randomUUID } from 'node:crypto'
import { db } from '@/lib/db'
import { canonicalPayloadHash } from './payload-hash'

export type AgentEventActor = 'user' | 'model' | 'tool' | 'scheduler' | 'system'

export const AGENT_EVENT_TYPES = [
  'turn.started',
  'turn.ended',
  'route.decided',
  'plan.created',
  'tool.proposed',
  'tool.refused',
  'tool.executed',
  'tool.failed',
  'draft.created',
  'operation.decided',
  'task.transitioned',
  'memory.saved',
  'provider.error',
  'correction',
] as const
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number]

const MAX_PAYLOAD_CHARS = 2000

/** Secrets are masked BEFORE storage — the ledger must be readable by
 *  anyone who can see the business, without becoming a secret dump.
 *  Over-masking is the safe side: exact figures live in the financial
 *  audit (AuditEvent), which is the system of record for money. */
const REDACT_PATTERNS: Array<[RegExp, string]> = [
  [/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]'],
  // phone-like digit runs (Egyptian mobiles are 11 digits: 01x + 8)
  [/\b\d{10,}\b/g, '[phone]'],
  // long opaque strings (API tokens / keys / ids, 25+ base chars)
  [/\b[A-Za-z0-9+/=_-]{25,}\b/g, '[opaque]'],
]

/** Redact + truncate a value into a safe ledger string. Pure. */
export function redactPayload(value: unknown): string {
  let s = JSON.stringify(value ?? null)
  if (s === undefined) s = 'null'
  for (const [re, sub] of REDACT_PATTERNS) s = s.replace(re, sub)
  if (s.length <= MAX_PAYLOAD_CHARS) return s
  // never silently drop: keep head/tail + the full length (hash is stored separately)
  return JSON.stringify({ truncated: true, charCount: s.length, head: s.slice(0, 600), tail: s.slice(-200) })
}

/** Open a turn trace and log its first row (sequence 0). */
export async function startTrace(input: { businessId: string; conversationId?: string | null }): Promise<string> {
  const traceId = `trc_${randomUUID().replace(/-/g, '').slice(0, 24)}`
  // The append-only table is accessed through parameterized SQL rather
  // than Prisma's generated RETURNING path. The latter triggered SQLITE_IOERR
  // in the real LibSQL adapter test; no returned model instance is needed.
  await db.$executeRawUnsafe(
    'INSERT INTO "AgentEvent" ("id", "businessId", "traceId", "conversationId", "sequence", "type", "actor", "payload", "operationRef", "payloadHash") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    `evt_${randomUUID().replace(/-/g, '')}`,
    input.businessId,
    traceId,
    input.conversationId ?? null,
    0,
    'turn.started',
    'system',
    redactPayload({ conversationId: input.conversationId ?? null }),
    null,
    null,
  )
  return traceId
}

/** Safe wrapper: a failed trace never breaks a turn (returns null). */
export async function startTraceSafe(input: { businessId: string; conversationId?: string | null }): Promise<string | null> {
  try {
    return await startTrace(input)
  } catch (err) {
    console.error('[agent-events] failed to start trace:', err)
    return null
  }
}

/** Append ONE event to a trace. Sequence is computed atomically so
 *  concurrent appends in one turn never collide. Never throws for the
 *  ledger's own integrity: a failed trace must not break the turn. */
export async function logAgentEvent(input: {
  businessId: string
  traceId: string
  conversationId?: string | null
  type: AgentEventType
  actor: AgentEventActor
  payload?: unknown
  operationRef?: string | null
}): Promise<void> {
  // A single INSERT…SELECT computes the next sequence and appends the row
  // in one SQLite statement. It avoids Prisma's aggregate/create RETURNING
  // path and prevents a read-then-write gap between concurrent appenders.
  await db.$executeRawUnsafe(
    'INSERT INTO "AgentEvent" ("id", "businessId", "traceId", "conversationId", "sequence", "type", "actor", "payload", "operationRef", "payloadHash") SELECT ?, ?, ?, ?, COALESCE(MAX("sequence"), -1) + 1, ?, ?, ?, ?, ? FROM "AgentEvent" WHERE "businessId" = ? AND "traceId" = ?',
    `evt_${randomUUID().replace(/-/g, '')}`,
    input.businessId,
    input.traceId,
    input.conversationId ?? null,
    input.type,
    input.actor,
    redactPayload(input.payload ?? null),
    input.operationRef ?? null,
    input.payload == null ? null : canonicalPayloadHash(input.payload),
    input.businessId,
    input.traceId,
  )
}

/** Safe wrapper for harness wiring: trace problems are swallowed + logged,
 *  never allowed to fail a user turn. */
export async function safeLogAgentEvent(input: Parameters<typeof logAgentEvent>[0]): Promise<void> {
  try {
    await logAgentEvent(input)
  } catch (err) {
    console.error('[agent-events] failed to append event:', input.type, err)
  }
}

/** Reconstruct a turn: all rows of a trace, in sequence order,
 *  scoped to the tenant that owns it. */
export async function reconstructTurn(input: { businessId: string; traceId: string }) {
  type Row = {
    id: string
    businessId: string
    traceId: string
    conversationId: string | null
    sequence: number
    type: AgentEventType
    actor: AgentEventActor
    payload: string | null
    operationRef: string | null
    payloadHash: string | null
    createdAt: Date | string
  }
  const rows = await db.$queryRawUnsafe<Row[]>(
    'SELECT "id", "businessId", "traceId", "conversationId", "sequence", "type", "actor", "payload", "operationRef", "payloadHash", "createdAt" FROM "AgentEvent" WHERE "businessId" = ? AND "traceId" = ? ORDER BY "sequence" ASC, "createdAt" ASC',
    input.businessId,
    input.traceId,
  )
  return rows.map((row) => ({ ...row, createdAt: new Date(row.createdAt) }))
}

/** Recent traces of a tenant (newest first) — the dashboard entry point. */
export async function listRecentTraces(input: { businessId: string; limit?: number }) {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100)
  const rows = await db.$queryRawUnsafe<Array<{
    traceId: string
    conversationId: string | null
    createdAt: Date | string
  }>>(
    'SELECT "traceId", "conversationId", "createdAt" FROM "AgentEvent" WHERE "businessId" = ? AND "type" = ? ORDER BY "createdAt" DESC LIMIT ?',
    input.businessId,
    'turn.started',
    limit,
  )
  return rows.map((r) => ({
    traceId: r.traceId,
    conversationId: r.conversationId,
    startedAt: r.createdAt,
  }))
}
