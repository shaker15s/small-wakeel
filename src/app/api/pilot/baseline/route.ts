// /api/pilot/baseline — the OWNER-REPORTED «سجل خط أساس» (PR-015 / plan §13).
//
// POST records the BEFORE numbers for one agreed workflow, as measured by the
// owner (tasks count, minutes per task the old way, mistakes/rework). These
// are human-measured facts with a named recorder — they are never confused
// with ledger-measured post numbers, and any unknown field stays null
// («غير مسجل»), never a silent 0.
import { NextResponse } from 'next/server'
import { guard } from '../../_lib/guard'
import { badRequest, serverError } from '../../_lib/http'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

function toNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      businessId?: string
      workflow?: string
      tasksCount?: number | null
      minutes?: number | null
      errors?: number | null
      note?: string | null
    }
    if (!body.businessId) return badRequest('businessId مطلوب')
    if (!body.workflow || typeof body.workflow !== 'string' || body.workflow.trim() === '')
      return badRequest('اسم النشاط (workflow) مطلوب — النشاط المتفق عليه في القياس')
    const gate = await guard(req, { businessId: body.businessId }) // actor scope: recordedBy needs the user
    if (!gate.ok) return gate.res

    const tasksCount = toNumberOrNull(body.tasksCount)
    const minutes = toNumberOrNull(body.minutes)
    const errors = toNumberOrNull(body.errors)
    if (tasksCount !== null && (!Number.isInteger(tasksCount) || tasksCount < 0)) return badRequest('tasksCount عدد صحيح ≥ 0 أو غير مسجل')
    if (minutes !== null && minutes < 0) return badRequest('minutes عدد ≥ 0 أو غير مسجل')
    if (errors !== null && (!Number.isInteger(errors) || errors < 0)) return badRequest('errors عدد صحيح ≥ 0 أو غير مسجل')

    const row = await db.pilotBaseline.create({
      data: {
        businessId: gate.actor.business.id,
        workflow: body.workflow.trim(),
        tasksCount,
        minutes,
        errors,
        note: typeof body.note === 'string' && body.note.trim() !== '' ? body.note.trim() : null,
        recordedBy: gate.actor.user.id,
      },
    })
    return NextResponse.json({ id: row.id, source: 'owner_reported', recorded: true }, { status: 201 })
  } catch (e) {
    return serverError('pilot-baseline', e)
  }
}
