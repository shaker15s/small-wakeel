// /api/plugins — Dynamic AI-Powered Plugin Harness API
// GET    ?businessId= → { plugins: AgentPluginDTO[] }
// POST   { businessId, userId, prompt?, slug?, name?, runImmediately? } → synthesizes/installs plugin & optionally runs it
// PATCH  { id, active } → toggles plugin active state
// DELETE ?id= → removes an installed plugin

import { NextRequest, NextResponse } from 'next/server'
import {
  deletePlugin,
  executePlugin,
  getBusinessPlugins,
  installOrUpdatePlugin,
  rollbackPlugin,
  STARTER_PLUGIN_CATALOG,
  synthesizePluginWithAI,
  togglePluginActive,
} from '@/lib/agent/plugin-harness'
import { badRequest, notFound, serverError } from '../_lib/http'
import { guard } from '../_lib/guard'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    const businessId = req.nextUrl.searchParams.get('businessId')
    if (!businessId) return badRequest('businessId مطلوب')
    const gate = await guard(req, { businessId, scope: 'business' })
    if (!gate.ok) return gate.res

    const plugins = await getBusinessPlugins(businessId)
    return NextResponse.json({ plugins })
  } catch (e) {
    return serverError('plugins-get', e)
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      businessId?: string
      userId?: string
      action?: 'install' | 'run'
      prompt?: string
      slug?: string
      name?: string
      runImmediately?: boolean
    }
    if (!body.businessId) return badRequest('businessId مطلوب')

    // Action: run an existing or starter plugin
    if (body.action === 'run' && body.slug) {
      const gate = await guard(req, { businessId: body.businessId, scope: 'business' })
      if (!gate.ok) return gate.res

      const result = await executePlugin({
        businessId: body.businessId,
        pluginOrSlug: body.slug,
      })
      return NextResponse.json(result)
    }

    if (!body.userId) return badRequest('userId مطلوب')

    const gate = await guard(req, { businessId: body.businessId, userId: body.userId, permission: 'tools.manage' })
    if (!gate.ok) return gate.res

    let plugin
    if (body.slug) {
      const starter = STARTER_PLUGIN_CATALOG.find((s) => s.slug === body.slug)
      if (!starter) return notFound('البلاجن غير موجود في الكتالوج')
      plugin = await installOrUpdatePlugin({
        businessId: body.businessId,
        userId: body.userId,
        spec: starter,
      })
    } else if (body.prompt?.trim()) {
      plugin = await synthesizePluginWithAI({
        businessId: body.businessId,
        userId: body.userId,
        prompt: body.prompt.trim(),
        preferredName: body.name?.trim(),
      })
    } else {
      return badRequest('يرجى إدخال وصف الميزة أو اختيار بلاجن من الكتالوج')
    }

    if (body.runImmediately !== false) {
      const execution = await executePlugin({
        businessId: body.businessId,
        pluginOrSlug: plugin,
      })
      return NextResponse.json({
        plugin: execution.plugin,
        cards: execution.cards,
        alerts: execution.alerts,
        summaryText: execution.summaryText,
      }, { status: 201 })
    }

    return NextResponse.json({ plugin }, { status: 201 })
  } catch (e) {
    return serverError('plugins-post', e)
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const gate = await guard(req, { permission: 'tools.manage' })
    if (!gate.ok) return gate.res

    const body = (await req.json().catch(() => ({}))) as {
      id?: string
      active?: boolean
      action?: 'rollback'
    }
    if (!body.id) return badRequest('id مطلوب')
    // R78 / PR-009: one-step rollback to the previous installed version.
    if (body.action === 'rollback') {
      const rolled = await rollbackPlugin(body.id, gate.actor.business.id, gate.actor.user.id)
      if (!rolled) return notFound('مفيش نسخة سابقة للرجوع ليها')
      return NextResponse.json({ plugin: rolled })
    }
    if (typeof body.active !== 'boolean') {
      return badRequest('id و active مطلوبين')
    }
    const updated = await togglePluginActive(body.id, body.active, gate.actor.business.id, gate.actor.user.id)
    if (!updated) return notFound('البلاجن غير موجود')
    return NextResponse.json({ plugin: updated })
  } catch (e) {
    return serverError('plugins-patch', e)
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const gate = await guard(req, { permission: 'tools.manage' })
    if (!gate.ok) return gate.res

    const id = req.nextUrl.searchParams.get('id')
    if (!id) return badRequest('id مطلوب')
    const ok = await deletePlugin(id, gate.actor.business.id, gate.actor.user.id)
    if (!ok) return notFound('البلاجن غير موجود')
    return NextResponse.json({ ok: true })
  } catch (e) {
    return serverError('plugins-delete', e)
  }
}

