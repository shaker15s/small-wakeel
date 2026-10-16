// POST /api/providers/[id] — save the chosen subset of models (labels/tiers/enabled)
// DELETE /api/providers/[id] — remove provider + its models
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { badRequest, notFound, serverError } from '../../_lib/http'

export const dynamic = 'force-dynamic'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body = (await req.json()) as {
      models?: { remoteId?: string; label?: string; tier?: string; enabled?: boolean }[]
    }
    const provider = await db.modelProvider.findUnique({ where: { id }, include: { models: true } })
    if (!provider) return notFound('المزوّد غير موجود')
    if (!body.models) return badRequest('قايمة الموديلات مطلوبة')

    // Replace all model configs in a transaction-ish sequence
    await db.modelConfig.deleteMany({ where: { providerId: id } })
    if (body.models.length > 0) {
      await db.modelConfig.createMany({
        data: body.models.slice(0, 30).map((m) => ({
          providerId: id,
          remoteId: (m.remoteId ?? '').trim(),
          label: (m.label ?? m.remoteId ?? '').trim(),
          tier: m.tier === 'air' || m.tier === 'deep' ? m.tier : 'balanced',
          enabled: m.enabled !== false,
        })).filter((m: { remoteId: string }) => m.remoteId.length > 0),
      })
    }

    const updated = await db.modelProvider.findUniqueOrThrow({ where: { id }, include: { models: { orderBy: { label: 'asc' } } } })
    return NextResponse.json({
      provider: {
        id: updated.id,
        name: updated.name,
        baseUrl: updated.baseUrl,
        models: updated.models.map((m) => ({ id: m.id, remoteId: m.remoteId, label: m.label, tier: m.tier, enabled: m.enabled })),
      },
    })
  } catch (e) {
    return serverError('providers-id', e)
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const provider = await db.modelProvider.findUnique({ where: { id } })
    if (!provider) return notFound('المزوّد غير موجود')
    await db.modelProvider.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return serverError('providers-delete', e)
  }
}
