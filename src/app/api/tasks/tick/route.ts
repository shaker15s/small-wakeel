// POST /api/tasks/tick — runs due scheduled tasks through the DURABLE runner
// (PR-010). This route used to carry its own non-atomic run loop, which could
// execute the same task twice when it raced the in-process scheduler —
// duplicating reminder messages. Everything now goes through runDueTasks(),
// whose claim is an atomic conditional UPDATE, so any number of tick sources
// (external cron + scheduler + manual hits) are safe by construction.
import { NextRequest, NextResponse } from 'next/server'
import { runDueTasks, requeueStuckTasks, requeueStuckNotifications } from '@/lib/tasks/runner'
import { serverError } from '../../_lib/http'
import { guard } from '../../_lib/guard'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const gate = await guard(req, { scope: 'admin' })
    if (!gate.ok) return gate.res
    const rawBody: unknown = await req.json().catch(() => ({}))
    if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
      return NextResponse.json({ error: 'Body must be a JSON object' }, { status: 400 })
    }
    const body = rawBody as { businessId?: unknown; forceAll?: unknown }
    if (body.businessId !== undefined &&
        (typeof body.businessId !== 'string' || !body.businessId.trim())) {
      return NextResponse.json({ error: 'businessId must be a non-empty string' }, { status: 400 })
    }
    const businessId = typeof body.businessId === 'string' ? body.businessId.trim() : undefined
    const scope = businessId ? { businessId } : {}

    // First sweep back only work in the requested business scope. The same
    // scope is passed through recovery, task execution, and outbox delivery.
    const recovered = await requeueStuckTasks(undefined, scope)
    const recoveredNotifications = await requeueStuckNotifications(undefined, scope)
    const summary = await runDueTasks(10, {
      forceAll: body.forceAll === true,
      ...scope,
    })

    return NextResponse.json({
      ran: summary.ran,
      due: summary.due,
      failed: summary.failed,
      delivered: summary.delivered,
      recovered,
      recoveredNotifications,
      details: summary.details,
    })
  } catch (e) {
    return serverError('tasks-tick', e)
  }
}
