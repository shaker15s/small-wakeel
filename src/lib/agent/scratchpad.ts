// وكيل — the agent's scratchpad («ورقة وقلم»).
//
// Claude Code's biggest lesson: an agent that writes his working notes down
// STICKS TO THE PLAN across turns. Every jot is fire-and-forget — a failed jot
// must never delay or break a turn. Notes live per conversation, capped at 50
// active rows (oldest non-pinned pruned on insert), and the newest ones are
// injected into future system prompts as «ورقة وكيل الحالية» so the employee
// remembers what HE himself wrote — item facts, customer balances, hypotheses
// for ambiguous requests, and todos for deferred sub-requests.

import { db } from '@/lib/db'
import type { NoteDTO, ResultCardDTO } from '@/lib/types'

// ---------------------------------------------------------------------------
// DEV-SERVER PRISMA HOT-RELOAD SEAM (R15, one-time self-heal)
// ---------------------------------------------------------------------------
// `prisma generate` can run while the dev server is alive (Phase-0 did). The
// running process then holds a client that predates the new models —
// AgentNote, Message.research/verified, UsageEvent telemetry columns — and
// hot reload alone can't fix it (both the globalThis singleton AND node's
// require cache for .prisma/client are stale). This seam busts the stale
// require-cache entries, constructs a fresh client from the CURRENT generated
// files, and GRAFTS the regenerated model delegates onto the live shared `db`
// object so every module holding the old import gets the new models at once.
// On a healthy/fresh process it is a no-op (single boolean check).

let prismaGrafted = false

export function ensurePrismaFresh(): void {
  if (prismaGrafted) return
  if ('agentNote' in db) {
    prismaGrafted = true
    return
  }
  try {
    // 1) node's require cache (reachable via the CJS entry module) — drop the
    //    stale .prisma/client + @prisma/client entries so the next require
    //    re-reads the regenerated files. Native .node engines stay cached
    //    (re-dlopen of the same binary would throw).
    const proc = process as NodeJS.Process & {
      mainModule?: { require: NodeJS.Require }
    }
    const req = proc.mainModule?.require
    if (!req?.cache) {
      console.error('[prisma-hotfix] require cache unreachable — المشكلة محتاجة ريستارت')
      return
    }
    for (const key of Object.keys(req.cache)) {
      if (key.endsWith('.node')) continue
      if (key.includes('/.prisma/client') || key.includes('@prisma/client-') || key.includes('/node_modules/@prisma/client/')) {
        delete req.cache[key]
      }
    }
    // 2) fresh client from the CURRENT generated files
    const mod = req('@prisma/client') as {
      PrismaClient: new (opts: { log: string[] }) => typeof db
    }
    const fresh = new mod.PrismaClient({ log: ['query'] })
    if (!('agentNote' in fresh)) {
      console.error('[prisma-hotfix] generated client still stale — هسيب المسار العادي')
      return
    }
    // 3) graft the regenerated delegates onto the LIVE shared instance
    const target = db as unknown as Record<string, unknown>
    const source = fresh as unknown as Record<string, unknown>
    for (const key of Object.keys(source)) {
      if (key === 'constructor' || key.startsWith('_') || key.startsWith('$')) continue
      if (source[key] != null) target[key] = source[key]
    }
    prismaGrafted = true
    console.log('[prisma-hotfix] regenerated prisma models grafted onto the live db (agentNote / research / telemetry جاهزين)')
  } catch (e) {
    console.error('[prisma-hotfix] failed (تجاهل):', e)
  }
}

/** Max active notes per conversation — the paper is one page, not a ledger. */
const MAX_ACTIVE_NOTES = 50
/** Hard text cap per note (matches the API contract). */
const NOTE_TEXT_MAX = 500

export interface JotNoteParams {
  businessId: string
  userId: string
  conversationId: string
  kind: NoteDTO['kind']
  text: string
  /** tool name / url / view the note came from */
  source?: string
  pinned?: boolean
}

/**
 * Fire-and-forget jot. NEVER throws, NEVER blocks the stream — callers may
 * ignore the returned promise entirely (`void jotNote({...})`).
 */
export async function jotNote(params: JotNoteParams): Promise<void> {
  try {
    const text = params.text.trim().replace(/\s+/g, ' ').slice(0, NOTE_TEXT_MAX)
    if (!text) return
    await db.agentNote.create({
      data: {
        businessId: params.businessId,
        userId: params.userId,
        conversationId: params.conversationId,
        kind: params.kind,
        text,
        ...(params.source ? { source: params.source.slice(0, 80) } : {}),
        ...(params.pinned ? { pinned: true } : {}),
      },
    })
    // Cap: 50 active notes per conversation — prune the OLDEST non-pinned ones.
    const active = await db.agentNote.findMany({
      where: { conversationId: params.conversationId, active: true },
      orderBy: { createdAt: 'desc' },
      select: { id: true, pinned: true },
    })
    if (active.length > MAX_ACTIVE_NOTES) {
      const removable = active
        .slice(MAX_ACTIVE_NOTES)
        .filter((n) => !n.pinned)
        .map((n) => n.id)
      if (removable.length > 0) {
        await db.agentNote.updateMany({ where: { id: { in: removable } }, data: { active: false } })
      }
    }
  } catch (e) {
    console.error('[scratchpad] jotNote failed (تجاهل):', e)
  }
}

/** Arabic labels for note kinds — what the user reads in «ورقة وكيل». */
export const NOTE_KIND_AR: Record<NoteDTO['kind'], string> = {
  fact: 'حقيقة',
  hypothesis: 'فرضية',
  todo: 'مهمة',
  plan: 'خطة',
  citation: 'مصدر',
}

/**
 * Compact context block of the CURRENT paper: every pinned note + the 10
 * newest active notes, ready to inject into the system prompt as the section
 * «ورقة وكيل الحالية». Returns null when the paper is empty.
 */
export async function notesContext(conversationId: string): Promise<string | null> {
  try {
    const notes = await db.agentNote.findMany({
      where: { conversationId, active: true },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      select: { kind: true, text: true, source: true, pinned: true },
    })
    if (notes.length === 0) return null
    const pinned = notes.filter((n) => n.pinned)
    const newest = notes.filter((n) => !n.pinned).slice(0, 10)
    const lines = [...pinned, ...newest].map(
      (n) => `- [${NOTE_KIND_AR[n.kind as NoteDTO['kind']] ?? 'حقيقة'}] ${n.text}${n.source ? ` (من ${n.source})` : ''}`,
    )
    return `## ورقة وكيل الحالية
دي ملاحظاتك الشغالة اللي كتبها بإيدك في المحادثة دي — لو ليها علاقة بالطلب استخدمها، ولو بقت قديمة تجاهلها:
${lines.join('\n')}`
  } catch (e) {
    console.error('[scratchpad] notesContext failed (تجاهل):', e)
    return null
  }
}

/**
 * Auto-jot facts straight out of tool result cards («بجمع» pass):
 *   - kv cards → one fact per row with a number («مبيعات: ١٬٢٣٤ ج.م»)
 *   - table cards → item/party facts («لبن جهينة: ٥٧ علبة @ ٤٥ ج.م») and
 *     the footer totals («إجمالي المديونيات: ٤٧٣ ج.م»)
 * Never throws; returns the number of jots it started (fire-and-forget writes).
 */
export async function jotFactsFromCards(
  ids: { businessId: string; userId: string; conversationId: string },
  cards: ResultCardDTO[],
): Promise<number> {
  let count = 0
  const jot = async (text: string, source: string): Promise<void> => {
    if (!text.trim() || count >= 4) return // cap 4 notes per tool run — no clutter
    count++
    await jotNote({ ...ids, kind: 'fact', text, source })
  }
  for (const c of cards) {
    if (c.kind === 'kv') {
      for (const r of c.rows) {
        if (/[\d٠-٩]/.test(r.value)) await jot(`${r.label}: ${r.value}`, c.title)
      }
    } else if (c.kind === 'table') {
      for (const f of c.footer ?? []) await jot(`${f.label}: ${f.value}`, c.title)
      for (const r of c.rows.slice(0, 4)) {
        const name = r.name ?? Object.values(r)[0] ?? ''
        const rest = Object.entries(r)
          .filter(([k]) => k !== 'name')
          .map(([, v]) => v)
          .filter(Boolean)
          .join(' @ ')
        if (name && rest) await jot(`${name}: ${rest}`, c.title)
      }
    }
  }
  return count
}