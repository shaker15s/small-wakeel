// R84 / PR-015 (plan v2 §13 pilot — «سجل خط أساس وبعدي لكل نشاط يوضح الوقت
// الفعلي للمهام، السجلات الناقصة، التصحيحات، حالات المتابعة، الأخطاء، وتكلفة
// التشغيل»):
//
// The pilot VALUE report. Every number here is MEASURED from an existing
// append-only ledger or an owner-reported baseline record — nothing is
// estimated, averaged into existence, or zero-filled:
//   • a category the ledgers cannot measure is `null` with a reason
//     («غير مسجل»), NEVER 0-as-unknown
//   • baseline (before) numbers are owner_reported; post numbers are
//     ledger_measured — the two are never mixed
//   • every query is tenant-scoped (zero cross-tenant, same SLO)

import { db } from '@/lib/db'
import type { AgentEvent, Operation, PilotBaseline } from '@prisma/client'

export interface PilotValueReport {
  businessId: string
  window: { since: string; until: string; days: number }
  // — measured from the AgentEvent ledger —
  turns: { count: number; p50Ms: number | null; p95Ms: number | null; note?: string }
  toolsExecuted: { count: number; byLabel: Record<string, number> }
  toolRefusals: { count: number }
  toolFailures: { count: number }
  providerErrors: { count: number }
  corrections: { count: number }
  // — clarifications: measured from PendingRequest (the follow-up queue) —
  clarifications: { count: number; awaiting: number; resolved: number; cancelled: number }
  // — financial safety (the pilot gate's core invariant) —
  operations: {
    total: number
    byStatus: Record<string, number>
    succeededWithoutApproval: number // MUST stay 0; >0 is a release blocker
  }
  // — stuck work —
  stuckTasks: { count: number; byStatus: Record<string, number> }
  // — model telemetry (UsageEvent) —
  fallbacks: { count: number; totalEvents: number }
  // — cost: measured only when a price is on file; honest null otherwise —
  costUsd: { value: number | null; measured: boolean; note: string }
  // — owner-reported baselines (before) —
  baselines: Array<{
    id: string
    workflow: string
    tasksCount: number | null
    minutes: number | null
    errors: number | null
    note: string | null
    recordedBy: string
    createdAt: string
    source: 'owner_reported'
  }>
  generatedAt: string
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

function parsePayload(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Turn durations: pair turn.started ↔ turn.ended per trace within the window. */
function turnDurations(events: AgentEvent[]): number[] {
  const started = new Map<string, Date>()
  const out: number[] = []
  for (const e of events) {
    if (e.type === 'turn.started') started.set(e.traceId, e.createdAt)
    else if (e.type === 'turn.ended') {
      const s = started.get(e.traceId)
      if (s) {
        const d = e.createdAt.getTime() - s.getTime()
        if (d >= 0) out.push(d)
        started.delete(e.traceId)
      }
    }
  }
  return out.sort((a, b) => a - b)
}

/**
 * Every SUCCEEDED operation must have a human `operation.approved` audit row
 * for the same ref. Count the violations — the pilot gate blocks on >0.
 * (Pre-R71 rows have null payloadHash; the audit trail is still the check:
 * an approval row is the proof of a human decision.)
 */
async function succeededWithoutApproval(businessId: string, ops: Operation[]): Promise<number> {
  // Reversals are formal financial operations too; do not exempt them from
  // the same proof-of-approval requirement as sales, expenses or payments.
  const succeeded = ops.filter((o) => o.status === 'SUCCEEDED')
  if (succeeded.length === 0) return 0
  const refs = [...new Set(succeeded.map((o) => o.ref))]
  const approved = await db.auditEvent.findMany({
    where: { businessId, action: 'operation.approved', ref: { in: refs } },
    select: { ref: true },
  })
  const approvedRefs = new Set(approved.map((a) => a.ref))
  return succeeded.filter((o) => !approvedRefs.has(o.ref)).length
}

export async function pilotValueReport(businessId: string, days = 30): Promise<PilotValueReport> {
  const until = new Date()
  const since = new Date(until.getTime() - Math.min(365, Math.max(1, days)) * 86_400_000)

  const [agentEvents, operations, pendingRequests, usageEvents, tasks, baselines] = await Promise.all([
    db.agentEvent.findMany({ where: { businessId, createdAt: { gte: since, lte: until } }, orderBy: { createdAt: 'asc' }, take: 20000 }),
    db.operation.findMany({ where: { businessId, createdAt: { gte: since, lte: until } } }),
    db.pendingRequest.findMany({ where: { businessId, createdAt: { gte: since, lte: until } } }),
    db.usageEvent.findMany({ where: { businessId, createdAt: { gte: since, lte: until } }, take: 20000 }),
    db.scheduledTask.findMany({ where: { businessId, status: { in: ['pending', 'retry_wait', 'failed'] } } }),
    db.pilotBaseline.findMany({ where: { businessId }, orderBy: { createdAt: 'desc' }, take: 100 }),
  ])

  const byType = (t: string) => agentEvents.filter((e) => e.type === t)
  const durations = turnDurations(agentEvents)

  const byStatus: Record<string, number> = {}
  for (const o of operations) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1

  const byTool = new Map<string, number>()
  for (const e of byType('tool.executed')) {
    const p = parsePayload(e.payload)
    const label = (p?.tool as string) || (p?.label as string) || 'unknown'
    byTool.set(label, (byTool.get(label) ?? 0) + 1)
  }

  const byTaskStatus: Record<string, number> = {}
  for (const t of tasks) byTaskStatus[t.status] = (byTaskStatus[t.status] ?? 0) + 1

  const fallbacks = usageEvents.filter((u) => u.fallback).length

  // cost: honest null. The ledgers record TOKENS, not money — converting
  // tokens to USD requires a price on file (model registry). With no measured
  // spend in this window we say so instead of inventing a number.
  const costUsd = {
    value: null as number | null,
    measured: false,
    note: 'التكلفة بالمال غير مقاسة في السجلات الحالية (سجلات التوكنز فقط) — «غير مسجل» وليس صفرًا',
  }

  const clarificationByStatus: Record<string, number> = {}
  for (const r of pendingRequests) clarificationByStatus[r.status] = (clarificationByStatus[r.status] ?? 0) + 1

  return {
    businessId,
    window: { since: since.toISOString(), until: until.toISOString(), days },
    turns: {
      count: durations.length,
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      note: durations.length === 0 ? 'لا جولات مكتملة في النافذة (started بلا ended لا تُحسب)' : undefined,
    },
    toolsExecuted: { count: byType('tool.executed').length, byLabel: Object.fromEntries(byTool) },
    toolRefusals: { count: byType('tool.refused').length },
    toolFailures: { count: byType('tool.failed').length },
    providerErrors: { count: byType('provider.error').length },
    corrections: { count: byType('correction').length },
    clarifications: {
      count: pendingRequests.length,
      awaiting: clarificationByStatus['awaiting'] ?? 0,
      resolved: clarificationByStatus['resolved'] ?? 0,
      cancelled: clarificationByStatus['cancelled'] ?? 0,
    },
    operations: {
      total: operations.length,
      byStatus,
      succeededWithoutApproval: await succeededWithoutApproval(businessId, operations),
    },
    stuckTasks: { count: tasks.length, byStatus: byTaskStatus },
    fallbacks: { count: fallbacks, totalEvents: usageEvents.length },
    costUsd,
    baselines: baselines.map((b: PilotBaseline) => ({
      id: b.id,
      workflow: b.workflow,
      tasksCount: b.tasksCount,
      minutes: b.minutes,
      errors: b.errors,
      note: b.note,
      recordedBy: b.recordedBy,
      createdAt: b.createdAt.toISOString(),
      source: 'owner_reported' as const,
    })),
    generatedAt: new Date().toISOString(),
  }
}

/**
 * The plan's before/after comparison, kept HONEST: baseline rows are
 * owner_reported, post numbers are ledger_measured, and a missing side is
 * reported as missing — the comparison is never padded with zeros.
 */
export function compareBaselineToPost(
  baseline: PilotBaseline | null,
  post: { turns: PilotValueReport['turns']; corrections: PilotValueReport['corrections'] },
): {
  workflow: string
  baselineSource: 'owner_reported' | null
  minutesPerTask: { before: number | null; after: number | null }
  note: string
} {
  if (!baseline) {
    return {
      workflow: '',
      baselineSource: null,
      minutesPerTask: { before: null, after: null },
      note: 'لا خط أساس مسجل — لا مقارنة قبل/بعد حتى يسجل المالك خط أساسه',
    }
  }
  const after = post.turns.count > 0 && post.turns.p50Ms != null ? post.turns.p50Ms / 60000 : null
  return {
    workflow: baseline.workflow,
    baselineSource: 'owner_reported',
    minutesPerTask: { before: baseline.minutes, after },
    note:
      baseline.minutes == null || after == null
        ? 'جانب ناقص — يُعرض «غير مسجل» ولا يُملأ صفرًا'
        : 'قبل = قياس المالك؛ بعد = p50 من سجل الجولات (قياس نظام). القرار بمقارنة الطرفين للمالك — النظام لا يحسب «وفراً» ذاتيًا',
  }
}
