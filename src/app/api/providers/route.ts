// GET /api/providers — list providers + models (no apiKey)
// POST /api/providers — add BYO OpenAI-compatible provider: validates the
// base URL by fetching {baseUrl}/models BEFORE saving, then saves provider +
// discovered models (all enabled by default).
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { badRequest, serverError } from '../_lib/http'
import { guard } from '../_lib/guard'
import { parseBody, providerCreateSchema } from '@/lib/security/validate'

export const dynamic = 'force-dynamic'

interface RemoteModel {
  id: string
  owned_by?: string
}

export async function GET() {
  try {
    const providers = await db.modelProvider.findMany({ include: { models: { orderBy: { label: 'asc' } } }, orderBy: { createdAt: 'asc' } })
    return NextResponse.json({
      providers: providers.map((p) => ({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        models: p.models.map((m) => ({ id: m.id, remoteId: m.remoteId, label: m.label, tier: m.tier, enabled: m.enabled })),
      })),
    })
  } catch (e) {
    return serverError('providers', e)
  }
}

export async function POST(req: Request) {
  try {
    const gate = await guard(req, { scope: 'open' })
    if (!gate.ok) return gate.res
    const parsed = await parseBody(req, providerCreateSchema)
    if (!parsed.ok) return badRequest(parsed.message)
    const body = parsed.data
    if (!body.name?.trim()) return badRequest('اسم المزوّد مطلوب')
    if (!body.baseUrl?.trim()) return badRequest('رابط الـ Base URL مطلوب')
    if (!body.apiKey?.trim()) return badRequest('مفتاح الـ API مطلوب')

    const baseUrl = body.baseUrl.trim().replace(/\/$/, '')
    if (!/^https?:\/\//.test(baseUrl)) return badRequest('الرابط لازم يبدأ بـ http:// أو https://')

    // Validate by fetching the model list BEFORE saving anything
    let models: RemoteModel[] = []
    try {
      const res = await fetch(`${baseUrl}/models`, {
        headers: { authorization: `Bearer ${body.apiKey.trim()}` },
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) {
        return NextResponse.json(
          { error: `المزوّد رد بـ ${res.status} — راجع الرابط والمفتاح` },
          { status: 422 },
        )
      }
      const json = (await res.json()) as { data?: RemoteModel[] }
      models = Array.isArray(json.data) ? json.data : []
    } catch {
      return NextResponse.json(
        { error: 'مش قادر أوصل للمزوّد — اتأكد إن الرابط شغال' },
        { status: 422 },
      )
    }
    if (models.length === 0) {
      return NextResponse.json({ error: 'المزوّد رجّع قايمة موديلات فاضية' }, { status: 422 })
    }

    const provider = await db.modelProvider.create({
      data: {
        name: body.name.trim(),
        baseUrl,
        apiKey: body.apiKey.trim(),
        models: {
          create: models.slice(0, 30).map((m) => ({
            remoteId: m.id,
            label: m.id,
            tier: guessTier(m.id),
            enabled: true,
          })),
        },
      },
      include: { models: true },
    })

    return NextResponse.json(
      {
        provider: {
          id: provider.id,
          name: provider.name,
          baseUrl: provider.baseUrl,
          models: provider.models.map((m) => ({ id: m.id, remoteId: m.remoteId, label: m.label, tier: m.tier, enabled: m.enabled })),
        },
      },
      { status: 201 },
    )
  } catch (e) {
    return serverError('providers-post', e)
  }
}

function guessTier(remoteId: string): 'air' | 'balanced' | 'deep' {
  const id = remoteId.toLowerCase()
  if (id.includes('mini') || id.includes('air') || id.includes('flash') || id.includes('fast') || id.includes('lite') || id.includes('small') || id.includes('nano')) return 'air'
  if (id.includes('deep') || id.includes('pro') || id.includes('max') || id.includes('opus') || id.includes('thinking') || id.includes('reason')) return 'deep'
  return 'balanced'
}
