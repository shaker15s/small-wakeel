// GET /api/members?businessId — customers/members with membership expiry info (gym members).
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { CustomerDTO } from '@/lib/types'
import { badRequest, searchParams, serverError } from '../_lib/http'
import { serializeCustomer } from '../_lib/serialize'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const sp = searchParams(req)
    const businessId = sp.get('businessId')
    if (!businessId) return badRequest('businessId مطلوب')

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
