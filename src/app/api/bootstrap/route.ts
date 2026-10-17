// GET / POST /api/bootstrap — businesses (with users) + external model providers,
// plus dynamic business creation (POST). Never exposes ModelProvider.apiKey.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { BootstrapDTO, Role, Vertical } from '@/lib/types'
import { createNewBusinessWithDefaults } from '@/lib/domain/business-builder'
import { badRequest, serverError } from '../_lib/http'

export const dynamic = 'force-dynamic'

// Meaningful role order for user pickers: owner first, then supervisor, staff.
const ROLE_ORDER: Record<string, number> = { owner: 0, supervisor: 1, cashier: 2, reception: 3 }

export async function GET() {
  try {
    const [businesses, providers] = await Promise.all([
      db.business.findMany({
        orderBy: { createdAt: 'asc' },
        include: { users: true },
      }),
      db.modelProvider.findMany({
        orderBy: { createdAt: 'asc' },
        include: { models: { orderBy: { label: 'asc' } } },
      }),
    ])

    const dto: BootstrapDTO = {
      businesses: businesses.map((b) => ({
        id: b.id,
        name: b.name,
        type: b.type as Vertical,
        users: b.users
          .slice()
          .sort(
            (a, b2) =>
              (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b2.role] ?? 9) ||
              a.name.localeCompare(b2.name, 'ar'),
          )
          .map((u) => ({
            id: u.id,
            name: u.name,
            role: u.role as Role,
            title: u.title,
          })),
      })),
      providers: providers.map((p) => ({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        models: p.models.map((m) => ({
          id: m.id,
          remoteId: m.remoteId,
          label: m.label,
          tier: m.tier as 'air' | 'balanced' | 'deep',
          enabled: m.enabled,
        })),
      })),
    }

    return NextResponse.json(dto)
  } catch (e) {
    return serverError('bootstrap', e)
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      name?: string
      type?: string
      openingCashEgp?: number
      openingCash?: number
      ownerName?: string
      customItems?: string[]
    }
    const name = String(body.name ?? '').trim()
    if (!name) return badRequest('اسم المنشأة مطلوب')

    const cash =
      typeof body.openingCashEgp === 'number'
        ? body.openingCashEgp
        : typeof body.openingCash === 'number'
          ? body.openingCash
          : 15000

    const created = await createNewBusinessWithDefaults({
      name,
      type: String(body.type ?? 'supermarket').trim() || 'supermarket',
      openingCashEgp: cash,
      ownerName: body.ownerName,
      customItems: Array.isArray(body.customItems) ? body.customItems : undefined,
    })

    return NextResponse.json({ business: created })
  } catch (e) {
    return serverError('bootstrap-post', e)
  }
}
