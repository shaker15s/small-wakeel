// GET /api/reports?businessId&range=7d|30d — aggregates for the Reports view.
// Daily buckets (Cairo days), totals, top items by sold qty, and count/amount per type.
// All money is integer piastres from SUCCEEDED operations' payload.total.
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { ReportsDTO } from '@/lib/types'
import { badRequest, searchParams, serverError } from '../_lib/http'
import { cairoDayIndex, cairoIsoDay, cairoIsoDayOffset, startOfCairoDay } from '../_lib/dates'
import { parseJson, payloadTotalPiastres } from '../_lib/serialize'

export const dynamic = 'force-dynamic'

type DailyBucket = {
  date: string
  sales: number
  purchases: number
  expenses: number
  collections: number
  payments: number
}

type SaleLine = { name: string; qty: number; revenue: number }

function toNonNegativeNumber(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Pull per-line {name, qty, revenue} out of a sale payload (defensive to seed shapes). */
function extractSaleLines(payload: Record<string, unknown>): SaleLine[] {
  const lines: SaleLine[] = []
  const raw = payload.items ?? payload.lines
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) continue
      const e = entry as Record<string, unknown>
      const name =
        typeof e.name === 'string' && e.name.trim() !== ''
          ? e.name
          : typeof e.label === 'string' && e.label.trim() !== ''
            ? e.label
            : null
      if (!name) continue
      const qty = toNonNegativeNumber(e.qty ?? e.quantity)
      let revenue = toNonNegativeNumber(e.total)
      if (revenue === 0) revenue = toNonNegativeNumber(e.price) * qty
      lines.push({ name, qty, revenue })
    }
  }
  // Flat single-item shape fallback: { item: 'اسم', qty, total }
  if (lines.length === 0 && typeof payload.item === 'string' && payload.item.trim() !== '') {
    lines.push({
      name: payload.item,
      qty: toNonNegativeNumber(payload.qty),
      revenue: toNonNegativeNumber(payload.total),
    })
  }
  // Single line without line-level pricing: attribute the operation total.
  if (lines.length === 1 && lines[0].revenue === 0) {
    const opTotal = toNonNegativeNumber(payload.total)
    if (opTotal > 0) lines[0].revenue = opTotal
  }
  return lines
}

export async function GET(req: Request) {
  try {
    const sp = searchParams(req)
    const businessId = sp.get('businessId')
    if (!businessId) return badRequest('businessId مطلوب')

    const range = sp.get('range') === '30d' ? '30d' : '7d'
    const days = range === '30d' ? 30 : 7
    const rangeStart = startOfCairoDay(days - 1)

    const ops = await db.operation.findMany({
      where: { businessId, createdAt: { gte: rangeStart }, status: 'SUCCEEDED' },
    })

    // DST-safety: only count ops whose Cairo calendar day is inside the window.
    const todayIndex = cairoDayIndex(new Date())
    const inRange = ops.filter((op) => cairoDayIndex(op.createdAt) >= todayIndex - (days - 1))

    // — Daily buckets (oldest → today), every day present even when empty
    const buckets = new Map<string, DailyBucket>()
    const daily: DailyBucket[] = []
    for (let back = days - 1; back >= 0; back--) {
      const date = cairoIsoDayOffset(back)
      const bucket: DailyBucket = {
        date,
        sales: 0,
        purchases: 0,
        expenses: 0,
        collections: 0,
        payments: 0,
      }
      buckets.set(date, bucket)
      daily.push(bucket)
    }

    const totals = { sales: 0, purchases: 0, expenses: 0, collections: 0, payments: 0, net: 0 }
    const topMap = new Map<string, { name: string; qty: number; revenue: number }>()
    const typeMap = new Map<string, { type: string; count: number; amount: number }>()

    for (const op of inRange) {
      // byType: every operation type, count + amount from payload.total
      const typeEntry = typeMap.get(op.type) ?? { type: op.type, count: 0, amount: 0 }
      typeEntry.count += 1
      typeEntry.amount += payloadTotalPiastres(op.payload)
      typeMap.set(op.type, typeEntry)

      // daily buckets: the five money movement types
      const bucket = buckets.get(cairoIsoDay(op.createdAt))
      if (bucket) {
        const total = payloadTotalPiastres(op.payload)
        switch (op.type) {
          case 'sale':
            bucket.sales += total
            break
          case 'purchase':
            bucket.purchases += total
            break
          case 'expense':
            bucket.expenses += total
            break
          case 'collection':
            bucket.collections += total
            break
          case 'payment':
            bucket.payments += total
            break
        }
      }

      // topItems: qty per item name across sale payloads
      if (op.type === 'sale') {
        const payload = parseJson<Record<string, unknown>>(op.payload, {})
        for (const line of extractSaleLines(payload)) {
          const cur = topMap.get(line.name) ?? { name: line.name, qty: 0, revenue: 0 }
          cur.qty += line.qty
          cur.revenue += line.revenue
          topMap.set(line.name, cur)
        }
      }
    }

    for (const b of daily) {
      totals.sales += b.sales
      totals.purchases += b.purchases
      totals.expenses += b.expenses
      totals.collections += b.collections
      totals.payments += b.payments
    }
    totals.net = totals.sales + totals.collections - (totals.purchases + totals.expenses + totals.payments)

    const topItems = [...topMap.values()].sort((a, b) => b.qty - a.qty).slice(0, 5)
    const byType = [...typeMap.values()].sort((a, b) => b.amount - a.amount || b.count - a.count)

    const dto: ReportsDTO = { range, daily, totals, topItems, byType }
    return NextResponse.json(dto)
  } catch (e) {
    return serverError('reports', e)
  }
}
