// GET /api/bootstrap — businesses (with users) + external model providers.
// Never exposes ModelProvider.apiKey.
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { BootstrapDTO, Role, Vertical } from '@/lib/types'
import { serverError } from '../_lib/http'

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
