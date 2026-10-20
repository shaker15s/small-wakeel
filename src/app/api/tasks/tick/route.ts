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
    const body = (await req.json().catch(() => ({}))) as {
      businessId?: string
      forceAll?: boolean
    }

    // First sweep back any work a dead worker left behind (task leases and
    // in-flight notifications), then run what is due, then deliver.
    const recovered = await requeueStuckTasks()
    const recoveredNotifications = await requeueStuckNotifications()
    const summary = await runDueTasks(10, {
      forceAll: body.forceAll === true,
      ...(body.businessId ? { businessId: body.businessId } : {}),
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
