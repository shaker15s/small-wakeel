// GET /api/memories?businessId — agent memory entries (facts & preferences), newest first.
// POST /api/memories — save a new memory (fact/preference) for the business.
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { MemoryDTO } from '@/lib/types'
import { badRequest, searchParams, serverError } from '../_lib/http'
import { serializeMemory } from '../_lib/serialize'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      businessId?: string
      userId?: string
      text?: string
      kind?: string
    }
    if (!body.businessId) return badRequest('businessId مطلوب')
    if (!body.userId) return badRequest('userId مطلوب')
    if (!body.text?.trim()) return badRequest('نص الذاكرة مطلوب')

    const memory = await db.agentMemory.create({
      data: {
        businessId: body.businessId,
        userId: body.userId,
        kind: body.kind === 'preference' ? 'preference' : 'fact',
        text: body.text.trim().slice(0, 500),
      },
    })
    return NextResponse.json(serializeMemory(memory), { status: 201 })
  } catch (e) {
    return serverError('memories-post', e)
  }
}

export async function GET(req: Request) {
  try {
    const sp = searchParams(req)
    const businessId = sp.get('businessId')
    if (!businessId) return badRequest('businessId مطلوب')

    const memories = await db.agentMemory.findMany({
      where: { businessId },
      orderBy: { createdAt: 'desc' },
    })

    const dto: MemoryDTO[] = memories.map(serializeMemory)
    return NextResponse.json(dto)
  } catch (e) {
    return serverError('memories', e)
  }
}
