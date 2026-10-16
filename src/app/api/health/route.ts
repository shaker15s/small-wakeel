// GET /api/health — liveness + readiness in one payload.
//
// Used by the deployment platform, the `bun run health` script and the
// «حالة النظام» panel. It answers the questions an operator actually asks:
//   • is the process up and which version is it?         → version/uptime
//   • can it reach the database, and how fast?          → db.latencyMs
//   • are the model providers reachable?                → models[]
//   • is the background scheduler alive and sweeping?    → scheduler
//   • is anything queued that nobody is working on?      → backlog
//
// Status codes: 200 healthy/degraded, 503 unhealthy (database unreachable).
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { guard } from '../_lib/guard'
import { schedulerStatus } from '@/lib/scheduler'
import { catalogCacheStats } from '@/lib/agent/catalog'
import { BUILTIN_MODELS } from '@/lib/agent/llm'
import pkg from '../../../../package.json'

export const dynamic = 'force-dynamic'

const bootAt = Date.now()

export async function GET(req: Request) {
  const gate = await guard(req, { scope: 'open' })
  if (!gate.ok) return gate.res

  const dbStarted = Date.now()
  let dbOk = true
  let dbError: string | null = null
  let counts = { businesses: 0, items: 0, operations: 0, pendingOps: 0, scheduledPending: 0, messages: 0 }
  try {
    const [businesses, items, operations, pendingOps, scheduledPending, messages] = await Promise.all([
      db.business.count(),
      db.item.count(),
      db.operation.count(),
      db.operation.count({ where: { status: 'AWAITING_APPROVAL' } }),
      db.scheduledTask.count({ where: { status: { in: ['pending', 'running'] } } }),
      db.message.count(),
    ])
    counts = { businesses, items, operations, pendingOps, scheduledPending, messages }
  } catch (err) {
    dbOk = false
    dbError = err instanceof Error ? err.message : 'database unreachable'
  }
  const dbLatencyMs = Date.now() - dbStarted

  // Model providers: registered (enabled) model configs, without ever leaking
  // an API key — counts and labels only.
  let models: { id: string; label: string; tier: string; source: string; provider: string }[] = []
  try {
    const configs = await db.modelConfig.findMany({
      where: { enabled: true },
      include: { provider: { select: { name: true } } },
      take: 50,
    })
    models = [
      ...BUILTIN_MODELS.map((m) => ({ id: m.key, label: m.label, tier: m.tier, source: 'builtin', provider: 'z-ai' })),
      ...configs.map((c) => ({
        id: `ext:${c.id}`,
        label: c.label,
        tier: c.tier,
        source: 'external',
        provider: c.provider.name,
      })),
    ]
  } catch {
    // a missing provider table must not fail the health check
  }

  const status = !dbOk ? 'unhealthy' : counts.pendingOps > 25 ? 'degraded' : 'healthy'
  const body = {
    status,
    version: pkg.version,
    uptimeSec: Math.round((Date.now() - bootAt) / 1000),
    time: new Date().toISOString(),
    runtime: { node: process.version, env: process.env.NODE_ENV ?? 'development' },
    db: { ok: dbOk, latencyMs: dbLatencyMs, error: dbError, counts },
    scheduler: schedulerStatus(),
    catalog: catalogCacheStats(),
    models,
    security: {
      accessTokenRequired: Boolean(process.env.WAKIL_ACCESS_TOKEN?.trim()),
      allowedOrigins: (process.env.WAKIL_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean).length,
      localWebhooksAllowed: process.env.ALLOW_LOCAL_WEBHOOKS === '1',
    },
  }

  return NextResponse.json(body, { status: dbOk ? 200 : 503 })
}
