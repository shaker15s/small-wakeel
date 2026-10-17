// GET /api/members?businessId — customers/members with membership expiry info (gym members).
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { CustomerDTO } from '@/lib/types'
import { badRequest, searchParams, serverError } from '../_lib/http'
import { guard } from '../_lib/guard'
import { serializeCustomer } from '../_lib/serialize'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const sp = searchParams(req)
    const businessId = sp.get('businessId')
    if (!businessId) return badRequest('businessId مطلوب')
    const gate = await guard(req, { businessId, scope: 'business' })
    if (!gate.ok) return gate.res

    const customers = await db.customer.findMany({
      where: { businessId },
      orderBy: { name: 'asc' },
    })

    const dto: CustomerDTO[] = customers.map(serializeCustomer)
    return NextResponse.json(dto)
  } catch (e) {
    return serverError('members', e)
  }
}
