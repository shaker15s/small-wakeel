// /api/background-tasks — Concurrent Background Task Manager & Proactive Risk/Opportunity Radar
// GET  ?businessId= → { jobs: BackgroundJobDTO[], proactiveAlerts: ProactiveAlertDTO[] }
// POST { businessId, userId, conversationId?, jobKinds?, catalogUpdates?, postToChat? } → BackgroundBatchResultDTO

import { NextRequest, NextResponse } from 'next/server'
import {
  dispatchConcurrentBackgroundJobs,
  getRecentBackgroundJobs,
  scanRisksAndOpportunities,
} from '@/lib/agent/task-engine'
import type { BackgroundJobKind } from '@/lib/types'
import { badRequest, serverError } from '../_lib/http'
import { guard } from '../_lib/guard'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    const businessId = req.nextUrl.searchParams.get('businessId')
    if (!businessId) return badRequest('businessId مطلوب')
    const gate = await guard(req, { businessId, scope: 'business' })
    if (!gate.ok) return gate.res

    const [jobs, scan] = await Promise.all([
      getRecentBackgroundJobs(businessId),
      scanRisksAndOpportunities(businessId),
    ])

    return NextResponse.json({
      jobs,
      proactiveAlerts: scan.alerts,
    })
  } catch (e) {
    return serverError('background-tasks-get', e)
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      businessId?: string
      userId?: string
      conversationId?: string | null
      jobKinds?: BackgroundJobKind[]
      catalogUpdates?: { name: string; sellPriceEgp?: number; buyPriceEgp?: number; stockQty?: number; minQty?: number }[]
      postToChat?: boolean
    }
    if (!body.businessId) return badRequest('businessId مطلوب')
    if (!body.userId) return badRequest('userId مطلوب')

    const gate = await guard(req, { businessId: body.businessId, userId: body.userId })
    if (!gate.ok) return gate.res

    const result = await dispatchConcurrentBackgroundJobs({
      businessId: body.businessId,
      userId: body.userId,
      conversationId: body.conversationId,
      jobKinds: body.jobKinds,
      catalogUpdates: body.catalogUpdates,
      postToChat: body.postToChat ?? true,
    })

    return NextResponse.json(result, { status: 201 })
  } catch (e) {
    return serverError('background-tasks-post', e)
  }
}
