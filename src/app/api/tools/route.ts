// /api/tools — «أدوات بتاعتك» (R16) — the user-extensible tool registry the
// agent actually uses during deep research.
// GET    ?businessId&userId → CustomToolDTO[] (ACTIVE tools only, name ASC).
// POST   {businessId,userId,name,kind,config} → 201 CustomToolDTO.
//        name 2..60 trimmed; kind ∈ web_source|webhook;
//        web_source: site REQUIRED (hostname, scheme/slashes stripped),
//          queryTemplate OPTIONAL; webhook: url REQUIRED valid http(s),
//          method GET|POST (default GET), bodyTemplate (if present) must
//          parse as JSON, note OPTIONAL.
//        Cap: max 8 ACTIVE tools per business.
// PATCH  {id, active?, name?, config?} → CustomToolDTO (toggle + edits).
// DELETE ?id= → hard delete — matches /api/quick-commands, the app's pattern
//        for user-created registry rows (owner confirmed via AlertDialog).
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { CustomToolDTO } from '@/lib/types'
import { parseToolConfig } from '@/lib/agent/userTools'
import { ensurePrismaFresh } from '@/lib/agent/scratchpad'
import { badRequest, notFound, searchParams, serverError } from '../_lib/http'
import { guard } from '../_lib/guard'

export const dynamic = 'force-dynamic'

const TOOL_KINDS: ReadonlySet<string> = new Set(['web_source', 'webhook'])
const NAME_MIN = 2
const NAME_MAX = 60
const MAX_ACTIVE_TOOLS = 8
const SITE_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i

/** Strip what a user pastes (scheme, path, query, port) down to the hostname. */
function cleanSite(raw: string): string {
  return raw
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') // https://  http://  ...
    .split('/')[0]
    .split('?')[0]
    .replace(/:\d+$/, '')
    .toLowerCase()
}

/** Normalized config for storage — or an Arabic error when invalid. */
function normalizeConfig(
  kind: string,
  raw: Record<string, unknown> | undefined | null,
): { ok: true; config: Record<string, string> } | { ok: false; error: string } {
  const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const str = (key: string): string | undefined => {
    const v = c[key]
    if (typeof v !== 'string') return undefined
    const t = v.trim()
    return t || undefined
  }
  if (kind === 'web_source') {
    const site = cleanSite(String(c.site ?? ''))
    if (!site) return { ok: false, error: 'اسم الموقع مطلوب — زي drogal.com' }
    if (!SITE_RE.test(site)) return { ok: false, error: 'اسم الموقع مش صحيح — اكتبه زي drogal.com من غير http' }
    const out: Record<string, string> = { site }
    const queryTemplate = str('queryTemplate')
    if (queryTemplate) out.queryTemplate = queryTemplate.slice(0, 200)
    return { ok: true, config: out }
  }
  // webhook
  const url = str('url')
  if (!url) return { ok: false, error: 'الرابط مطلوب' }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, error: 'الرابط مش مكتوب صح' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'الرابط لازم يبدأ بـ http أو https' }
  }
  const methodRaw = (str('method') ?? 'GET').toUpperCase()
  if (methodRaw !== 'GET' && methodRaw !== 'POST') {
    return { ok: false, error: 'الطريقة لازم تكون GET أو POST' }
  }
  const out: Record<string, string> = { url: parsed.toString(), method: methodRaw }
  const bodyTemplate = str('bodyTemplate')
  if (bodyTemplate) {
    try {
      JSON.parse(bodyTemplate) // must parse — a loose string body is rejected
    } catch {
      return { ok: false, error: 'الـbody لازم يكون JSON سليم — زي { }' }
    }
    out.bodyTemplate = bodyTemplate.slice(0, 2000)
  }
  const note = str('note')
  if (note) out.note = note.slice(0, 200)
  return { ok: true, config: out }
}

/** Validate that business + user exist AND the user belongs to that business. */
async function validatePair(
  businessId: string,
  userId: string,
): Promise<NextResponse | null> {
  const [business, user] = await Promise.all([
    db.business.findUnique({ where: { id: businessId }, select: { id: true } }),
    db.user.findUnique({ where: { id: userId }, select: { id: true, businessId: true } }),
  ])
  if (!business) return notFound('النشاط التجاري غير موجود')
  if (!user) return notFound('المستخدم غير موجود')
  if (user.businessId !== businessId) return badRequest('المستخدم مش تابع للنشاط ده')
  return null
}

function serialize(row: {
  id: string
  name: string
  kind: string
  config: string
  active: boolean
  usageCount: number
  lastUsedAt: Date | null
}): CustomToolDTO {
  return {
    id: row.id,
    name: row.name,
    kind: (TOOL_KINDS.has(row.kind) ? row.kind : 'web_source') as CustomToolDTO['kind'],
    config: parseToolConfig(row.config),
    active: row.active,
    usageCount: row.usageCount,
    ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt.toISOString() } : {}),
  }
}

/** GET: the owner's ACTIVE tools (the research pipeline runs exactly these). */
export async function GET(req: Request) {
  ensurePrismaFresh()
  try {
    const sp = searchParams(req)
        const businessId = sp.get('businessId')
    if (!businessId) return badRequest('businessId مطلوب')
    const userId = sp.get('userId')
    if (!userId) return badRequest('userId مطلوب')
    const gate = await guard(req, { businessId, userId, permission: 'tools.manage' })
    if (!gate.ok) return gate.res

    const invalid = await validatePair(businessId, userId)
    if (invalid) return invalid

    const rows = await db.customTool.findMany({
      where: { businessId, active: true, kind: { in: ['web_source', 'webhook'] } },
      orderBy: { name: 'asc' },
    })
    return NextResponse.json(rows.map(serialize))
  } catch (e) {
    return serverError('tools', e)
  }
}

/** POST: the owner adds one of his own tools (max 8 active per business). */
export async function POST(req: Request) {
  ensurePrismaFresh()
  try {
    const body = (await req.json()) as {
      businessId?: string
      userId?: string
      name?: string
      kind?: string
      config?: Record<string, unknown>
    }
    if (!body.businessId) return badRequest('businessId مطلوب')
    if (!body.userId) return badRequest('userId مطلوب')

    const gate = await guard(req, { businessId: body.businessId, userId: body.userId, permission: 'tools.manage' })
    if (!gate.ok) return gate.res

    const name = String(body.name ?? '').trim().replace(/\s+/g, ' ')
    if (name.length < NAME_MIN || name.length > NAME_MAX) {
      return badRequest(`اسم الأداة لازم من حرفين لـ٦٠ حرف`)
    }
    const kind = String(body.kind ?? '')
    if (!TOOL_KINDS.has(kind)) return badRequest('نوع الأداة لازم يكون web_source أو webhook')

    const normalized = normalizeConfig(kind, body.config)
    if (!normalized.ok) return badRequest(normalized.error)

    // Cap: 8 ACTIVE tools per business (paused ones don't count)
    const activeCount = await db.customTool.count({
      where: { businessId: body.businessId, active: true, kind: { in: ['web_source', 'webhook'] } },
    })
    if (activeCount >= MAX_ACTIVE_TOOLS) {
      return badRequest(`وصلت للحد الأقصى ٨ أدوات — امسح واحدة أو وقّفها الأول`)
    }

    const created = await db.customTool.create({
      data: {
        businessId: body.businessId,
        userId: body.userId,
        name,
        kind,
        config: JSON.stringify(normalized.config),
      },
    })
    return NextResponse.json(serialize(created), { status: 201 })
  } catch (e) {
    return serverError('tools-post', e)
  }
}

/** PATCH: toggle active, or edit name/config. */
export async function PATCH(req: Request) {
  ensurePrismaFresh()
  try {
    const body = (await req.json()) as {
      id?: string
      active?: boolean
      name?: string
      config?: Record<string, unknown>
    }
    if (!body.id) return badRequest('id مطلوب')

    const gate = await guard(req, { permission: 'tools.manage' })
    if (!gate.ok) return gate.res
    const existing = await db.customTool.findFirst({ where: { id: body.id, businessId: gate.actor.business.id } })
    if (!existing) return notFound('الأداة مش موجودة')

    const data: { active?: boolean; name?: string; kind?: string; config?: string } = {}

    if (body.active !== undefined) {
      data.active = body.active === true
      if (data.active === true) {
        // re-activating counts against the 8-active cap
        const activeCount = await db.customTool.count({
          where: { businessId: existing.businessId, active: true, id: { not: existing.id } },
        })
        if (activeCount >= MAX_ACTIVE_TOOLS) {
          return badRequest(`وصلت للحد الأقصى ٨ أدوات — امسح واحدة أو وقّفها الأول`)
        }
      }
    }

    if (body.name !== undefined) {
      const name = String(body.name).trim().replace(/\s+/g, ' ')
      if (name.length < NAME_MIN || name.length > NAME_MAX) {
        return badRequest(`اسم الأداة لازم من حرفين لـ٦٠ حرف`)
      }
      data.name = name
    }

    if (body.config !== undefined) {
      const normalized = normalizeConfig(existing.kind, body.config)
      if (!normalized.ok) return badRequest(normalized.error)
      data.config = JSON.stringify(normalized.config)
    }

    const updated = await db.customTool.update({ where: { id: body.id }, data })
    return NextResponse.json(serialize(updated))
  } catch (e) {
    return serverError('tools-patch', e)
  }
}

/** DELETE: hard delete — same pattern as /api/quick-commands for user tools. */
export async function DELETE(req: Request) {
  ensurePrismaFresh()
  try {
    const sp = searchParams(req)
    const id = sp.get('id')
    if (!id) return badRequest('id مطلوب')

    const gate = await guard(req, { permission: 'tools.manage' })
    if (!gate.ok) return gate.res
    const existing = await db.customTool.findFirst({ where: { id: id, businessId: gate.actor.business.id } })
    if (!existing) return notFound('الأداة مش موجودة')

    await db.customTool.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return serverError('tools-delete', e)
  }
}
