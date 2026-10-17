import { NextResponse } from 'next/server'
import {
  scanRunningApplications,
  bridgeApplicationWithCliAnything,
  executeBridgedTool,
} from '@/lib/agent/cli-anything/bridge'
import { db } from '@/lib/db'
import { guard } from '../../_lib/guard'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const gate = await guard(req, { scope: 'open' })
    if (!gate.ok) return gate.res

    const apps = await scanRunningApplications()
    return NextResponse.json({ ok: true, apps })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'failed to scan apps' },
      { status: 500 },
    )
  }
}

export async function POST(req: Request) {
  try {
    const gate = await guard(req, { scope: 'open' })
    if (!gate.ok) return gate.res

    const body = await req.json()
    const { appName, processName, businessId, userId, businessType, action, command, args } = body

    if (!appName) {
      return NextResponse.json({ ok: false, error: 'appName is required' }, { status: 400 })
    }

    // Resolve or fallback to active business if not provided
    let bId = businessId
    let uId = userId
    if (!bId) {
      const firstBiz = await db.business.findFirst()
      if (firstBiz) bId = firstBiz.id
    }
    if (!uId) {
      const firstUser = await db.user.findFirst()
      if (firstUser) uId = firstUser.id
    }

    // Execute live bridged tool query if requested
    if (action === 'execute' || command) {
      const executionResult = await executeBridgedTool({
        businessId: bId ?? 'system',
        appName,
        processName,
        command,
        args,
      })
      return NextResponse.json(executionResult)
    }

    // Synthesize autonomous harness and persist into PluginRegistry
    const bridgeResult = await bridgeApplicationWithCliAnything({
      businessId: bId ?? 'system',
      userId: uId ?? 'system',
      appName,
      processName,
      businessType,
    })

    return NextResponse.json(bridgeResult)
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'failed to bridge app' },
      { status: 500 },
    )
  }
}
