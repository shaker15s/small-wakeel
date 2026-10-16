// GET /api/usage?businessId&days=7 — the performance ledger.
//
// Every agent turn already writes a UsageEvent (kind, label, latency, TTFT,
// tokens, fallback). This route aggregates it so latency regressions, fallback
// storms and expensive tools are visible instead of anecdotal:
//   • per-kind totals, p50/p95 latency, TTFT p50, tokens, fallback rate
//   • slowest tools, most used tools, daily volume
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { badRequest, searchParams, serverError } from '../_lib/http'
import { guard } from '../_lib/guard'

export const dynamic = 'force-dynamic'

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

export async function GET(req: Request) {
  try {
    const sp = searchParams(req)
    const businessId = sp.get('businessId')
    if (!businessId) return badRequest('businessId مطلوب')
    const gate = await guard(req, { businessId, scope: 'business' })
    if (!gate.ok) return gate.res

    const days = Math.min(90, Math.max(1, Number(sp.get('days') ?? 7) || 7))
    const since = new Date(Date.now() - days * 86_400_000)

    const events = await db.usageEvent.findMany({
      where: { businessId, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    })

    const byKind = new Map<string, { count: number; latencies: number[]; ttfts: number[]; tokens: number; fallbacks: number }>()
    const byLabel = new Map<string, { count: number; latencies: number[] }>()
    const byDay = new Map<string, number>()

    for (const e of events) {
      const k = byKind.get(e.kind) ?? { count: 0, latencies: [], ttfts: [], tokens: 0, fallbacks: 0 }
      k.count += 1
      if (e.latencyMs != null) k.latencies.push(e.latencyMs)
      if (e.ttftMs != null) k.ttfts.push(e.ttftMs)
      if (e.tokens != null) k.tokens += e.tokens
      if (e.fallback) k.fallbacks += 1
      byKind.set(e.kind, k)

      const l = byLabel.get(e.label) ?? { count: 0, latencies: [] }
      l.count += 1
      if (e.latencyMs != null) l.latencies.push(e.latencyMs)
      byLabel.set(e.label, l)

      const day = e.createdAt.toISOString().slice(0, 10)
      byDay.set(day, (byDay.get(day) ?? 0) + 1)
    }

    const kinds = [...byKind.entries()]
      .map(([kind, v]) => {
        const sorted = [...v.latencies].sort((a, b) => a - b)
        const ttfts = [...v.ttfts].sort((a, b) => a - b)
        return {
          kind,
          count: v.count,
          latencyP50: percentile(sorted, 50),
          latencyP95: percentile(sorted, 95),
          ttftP50: percentile(ttfts, 50),
          tokens: v.tokens,
          fallbackRate: v.count > 0 ? Math.round((v.fallbacks / v.count) * 100) : 0,
        }
      })
      .sort((a, b) => b.count - a.count)

    const labels = [...byLabel.entries()]
      .map(([label, v]) => {
        const sorted = [...v.latencies].sort((a, b) => a - b)
        return { label, count: v.count, latencyP50: percentile(sorted, 50), latencyP95: percentile(sorted, 95) }
      })
      .sort((a, b) => b.count - a.count)

    return NextResponse.json({
      range: { days, since: since.toISOString(), events: events.length },
      kinds,
      slowest: [...labels]
        .filter((l) => l.latencyP50 != null)
        .sort((a, b) => (b.latencyP50 ?? 0) - (a.latencyP50 ?? 0))
        .slice(0, 8),
      mostUsed: labels.slice(0, 12),
      daily: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count })),
    })
  } catch (e) {
    return serverError('usage', e)
  }
}
