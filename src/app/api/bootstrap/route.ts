import { providerUrl } from '@/lib/security/provider-network'
// GET / POST /api/bootstrap — businesses (with users) + external model providers,
// plus dynamic business creation (POST). Never exposes ModelProvider.apiKey.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { BootstrapDTO, Role, Vertical } from '@/lib/types'
import { createNewBusinessWithDefaults } from '@/lib/domain/business-builder'
import { badRequest, serverError } from '../_lib/http'
import { guard } from '../_lib/guard'

export const dynamic = 'force-dynamic'

// Meaningful role order for user pickers: owner first, then supervisor, staff.
const ROLE_ORDER: Record<string, number> = { owner: 0, supervisor: 1, cashier: 2, reception: 3 }

export async function GET(req: NextRequest) {
  try {
    const gate = await guard(req, { scope: 'open' })
    if (!gate.ok) return gate.res
    const [businesses, providers] = await Promise.all([
      db.business.findMany({
        where: gate.principal ? { id: gate.principal.business.id } : undefined,
        orderBy: { createdAt: 'asc' },
        include: { users: gate.principal ? { where: { id: gate.principal.user.id } } : true },
      }),
      db.modelProvider.findMany({
        orderBy: { createdAt: 'asc' },
        include: { models: { orderBy: { label: 'asc' } } },
      }),
    ])

    const dto: BootstrapDTO = {
      deploymentAdmin: gate.deploymentAdmin === true,
      businesses: businesses.map((b) => ({
        id: b.id,
        name: b.name,
        type: b.type as Vertical,
        workflowMode: b.workflowMode,
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
      // Legacy localhost fixture providers stay inspectable to deployment admins,
      // but are never offered as live model choices in a real workspace.
      providers: providers.filter((p) => { try { providerUrl(p.baseUrl); return true } catch { return false } }).map((p) => ({
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
    const gate = await guard(req, { scope: 'admin' })
    if (!gate.ok) return gate.res
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
          : 0

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
