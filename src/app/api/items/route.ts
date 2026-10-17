// GET /api/items?businessId — full catalog with computed daysToExpiry & valueAtCost.
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { ItemDTO } from '@/lib/types'
import { badRequest, searchParams, serverError } from '../_lib/http'
import { guard } from '../_lib/guard'
import { serializeItem } from '../_lib/serialize'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const sp = searchParams(req)
    const businessId = sp.get('businessId')
    if (!businessId) return badRequest('businessId مطلوب')
    const gate = await guard(req, { businessId, scope: 'business' })
    if (!gate.ok) return gate.res

    const items = await db.item.findMany({
      where: { businessId },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    })

    const dto: ItemDTO[] = items.map(serializeItem)
    return NextResponse.json(dto)
  } catch (e) {
    return serverError('items', e)
  }
}
