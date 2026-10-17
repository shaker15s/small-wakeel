// GET /api/search?businessId&q&limit — one search box over the whole shop.
//
// WHY: the owner's mental model is «فين الطماطم؟» / «عملية WKL-1032» / «أم
// حسن» — not «which screen». This endpoint searches items, customers,
// suppliers, operations and notes in one round-trip and returns them grouped,
// so the command palette (and the agent) can answer instantly.
//
// Matching is Arabic-normalised (أحمد ≡ احمد, «ال» article ignored, Arabic-Indic
// digits folded) and diacritic-insensitive, which SQLite's LIKE alone can't do.
// SQL is used only as a cheap pre-filter where it helps; the authoritative
// match happens on the normalised form.
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { normalizeAr, toWesternDigits } from '@/lib/agent/arabic'
import { egp } from '@/lib/format'
import { guard } from '../_lib/guard'
import { badRequest, serverError, searchParams } from '../_lib/http'

export const dynamic = 'force-dynamic'

export interface SearchHit {
  kind: 'item' | 'customer' | 'supplier' | 'operation' | 'note'
  id: string
  title: string
  subtitle: string
  /** Optional deep ref the UI can jump to (operation ref, barcode…). */
  ref?: string
  tone?: 'good' | 'warn' | 'bad'
}

/** Fold a string for comparison: normalise + drop the article + collapse spaces. */
function fold(s: string): string {
  return normalizeAr(toWesternDigits(s)).replace(/\s+/g, ' ').trim()
}

function score(haystacks: string[], needle: string): number {
  let best = 0
  for (const raw of haystacks) {
    const hay = fold(raw)
    if (!hay) continue
    if (hay === needle) best = Math.max(best, 100)
    else if (hay.startsWith(needle)) best = Math.max(best, 80)
    else if (hay.includes(needle)) best = Math.max(best, 60)
    else {
      // multi-word: all tokens must appear somewhere
      const tokens = needle.split(' ').filter((t) => t.length > 1)
      if (tokens.length > 1 && tokens.every((t) => hay.includes(t))) best = Math.max(best, 40)
    }
  }
  return best
}

export async function GET(req: Request) {
  try {
    const sp = searchParams(req)
    const businessId = sp.get('businessId')
    if (!businessId) return badRequest('businessId مطلوب')
    const gate = await guard(req, { businessId, scope: 'business' })
    if (!gate.ok) return gate.res

    const rawQuery = (sp.get('q') ?? '').trim()
    if (rawQuery.length < 2) return badRequest('اكتب حرفين على الأقل للبحث')
    const needle = fold(rawQuery).replace(/^ال/, '')
    const limit = Math.min(50, Math.max(3, Number(sp.get('limit') ?? 12) || 12))
    // SQL pre-filter: cheaper than pulling the whole catalog for a big shop.
    const like = rawQuery.slice(0, 40)

    const [items, customers, suppliers, operations, notes] = await Promise.all([
      db.item.findMany({
        where: {
          businessId,
          OR: [{ name: { contains: like } }, { aliases: { contains: like } }, { barcode: { contains: like } }, { category: { contains: like } }],
        },
        take: 400,
      }),
      db.customer.findMany({
        where: { businessId, OR: [{ name: { contains: like } }, { phone: { contains: like } }] },
        take: 300,
      }),
      db.supplier.findMany({
        where: { businessId, OR: [{ name: { contains: like } }, { phone: { contains: like } }] },
        take: 200,
      }),
      db.operation.findMany({
        where: { businessId, OR: [{ ref: { contains: like } }, { summary: { contains: like } }] },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      db.agentNote.findMany({
        where: { businessId, active: true, text: { contains: like } },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    ])

    const hits: (SearchHit & { _score: number })[] = []

    for (const it of items) {
      const s = Math.max(
        score([it.name], needle),
        it.aliases ? score(it.aliases.split(','), needle) : 0,
        it.barcode && fold(it.barcode).includes(needle) ? 90 : 0,
        score([it.category], needle) * 0.5,
      )
      if (s <= 0) continue
      hits.push({
        kind: 'item',
        id: it.id,
        title: it.name,
        subtitle: `مخزون ${it.stockQty} ${it.unit} · بيع ${egp(it.sellPrice)}${it.stockQty <= it.lowStockThreshold ? ' · تحت الحد' : ''}`,
        ref: it.barcode ?? undefined,
        tone: it.stockQty <= 0 ? 'bad' : it.stockQty <= it.lowStockThreshold ? 'warn' : 'good',
        _score: s,
      })
    }

    for (const c of customers) {
      const s = Math.max(score([c.name], needle), c.phone?.includes(like) ? 85 : 0)
      if (s <= 0) continue
      hits.push({
        kind: 'customer',
        id: c.id,
        title: c.name,
        subtitle: c.balance > 0 ? `عليه ${egp(c.balance)}` : 'حسابه مقفول',
        ref: c.phone ?? undefined,
        tone: c.balance > 0 ? 'warn' : 'good',
        _score: s,
      })
    }

    for (const s of suppliers) {
      const sc = Math.max(score([s.name], needle), s.phone?.includes(like) ? 85 : 0)
      if (sc <= 0) continue
      hits.push({
        kind: 'supplier',
        id: s.id,
        title: s.name,
        subtitle: s.balance > 0 ? `لينا عليه ${egp(s.balance)}` : 'مفيش مستحقات',
        ref: s.phone ?? undefined,
        _score: sc,
      })
    }

    for (const op of operations) {
      const s = Math.max(colorScore(op.ref, needle), score([op.summary], needle))
      if (s <= 0) continue
      hits.push({
        kind: 'operation',
        id: op.id,
        title: op.ref,
        subtitle: op.summary,
        tone: op.status === 'SUCCEEDED' ? 'good' : op.status === 'AWAITING_APPROVAL' ? 'warn' : 'bad',
        _score: s,
      })
    }

    for (const n of notes) {
      const s = score([n.text], needle)
      if (s <= 0) continue
      hits.push({ kind: 'note', id: n.id, title: n.text.slice(0, 90), subtitle: 'ملاحظة على ورقة وكيل', _score: s * 0.8 })
    }

    hits.sort((a, b) => b._score - a._score)
    const top = hits.slice(0, limit)
    const groups = top.reduce<Record<string, number>>((acc, h) => {
      acc[h.kind] = (acc[h.kind] ?? 0) + 1
      return acc
    }, {})

    return NextResponse.json({
      query: rawQuery,
      total: hits.length,
      groups,
      results: top.map(({ _score, ...rest }) => ({ ...rest, score: _score })),
    })
  } catch (e) {
    return serverError('search', e)
  }
}

/** Operation refs are matched digit-by-digit: «1032» finds «WKL-1032». */
function colorScore(ref: string, needle: string): number {
  const f = fold(ref)
  if (f === needle) return 100
  if (f.includes(needle)) return 70
  const digits = needle.replace(/\D/g, '')
  if (digits.length >= 3 && f.replace(/\D/g, '').includes(digits)) return 65
  return 0
}
