// POST /api/tasks/tick — runs due scheduled tasks (read tools only) and
// posts the result into the owner's conversation as an agent message.
import { NextResponse } from 'next/server'
import { requeueStuckTasks, runDueTasks } from '@/lib/tasks/runner'
import { serverError } from '../../_lib/http'
import { guard } from '../../_lib/guard'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    // System job (the in-process scheduler calls it too): token + origin +
    // rate limit apply, tenant scoping does not — it sweeps every business.
    const gate = await guard(req, { scope: 'open' })
    if (!gate.ok) return gate.res

    const requeued = await requeueStuckTasks()
    const summary = await runDueTasks(10)
    return NextResponse.json({
      ran: summary.ran,
      due: summary.due,
      failed: summary.failed,
      requeued,
      details: summary.details,
    })
  } catch (e) {
    return serverError('tasks-tick', e)
  }
}

