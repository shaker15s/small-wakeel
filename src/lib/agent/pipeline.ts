// وكيل — «الخطّة» (Plan) + «باحث» (isolated researcher sub-agent) + the guarded
// tool pipeline. This is the R28 harness layer, built from what the state of the
// art actually converges on:
//
//   • DeepSeek Harness (dsh): a tool call runs through a *pipeline* — policy →
//     execute (timeout/retry) → post-execute rewrite — and results that reach
//     the model must be reproducible from the log. Context compaction is a
//     listener on context pressure, not a special case inside the loop.
//   • Claude Code: context is the binding constraint, so (a) every tool result
//     has a size budget, (b) sub-agents return ONLY a summary into the parent
//     context, and (c) independent reads fan out in parallel.
//   • ChatGPT Work: long jobs are *planned* first, the plan is shown to the
//     human, and risk gates pause execution.
//
// Nothing here executes code or shells: a «plan» is data (a list of read-only
// tool calls) and the sub-agent is just another bounded reasoning loop with the
// same tool set. Fail-closed by construction: an unknown tool, a bad argument
// or a timeout becomes a reported failure, never a silent success.
import { db } from '@/lib/db'
import { READ_TOOLS, runReadTool, type ReadTool } from './tools'

/** Graduated backoff with jitter for transient SQLite contention. */
function backoffMs(attempt: number): number {
  const base = 250 * 2 ** attempt
  return Math.round(base * (0.7 + Math.random() * 0.6))
}

// ---------------------------------------------------------------------------
// The tool pipeline

export interface ToolPipelineOpts {
  /** hard per-tool wall-clock budget (the model must never hang a turn) */
  timeoutMs?: number
  /** result characters handed back to the MODEL (the UI always gets it whole) */
  budgetChars?: number
}

const DEFAULT_TIMEOUT_MS = 9_000
/** Claude Code's «budget reduction»: one verbose result must not own the
 *  context window. 1.6k chars ≈ 500 tokens — enough for a table's gist. */
const DEFAULT_BUDGET_CHARS = 1_600

export interface ToolRun {
  tool: string
  ok: boolean
  cards: Awaited<ReturnType<typeof runReadTool>>
  /** compact, budgeted text for the model */
  output: string
  ms: number
  error?: string
  /** true when the result was trimmed for the model's context */
  trimmed?: boolean
}

/** One-line digest of a result card — for the model, never for the human. */
export function digestCards(cards: Awaited<ReturnType<typeof runReadTool>>): string {
  return cards
    .map((c) => {
      if (c.kind === 'kv') return `${c.title}: ${c.rows.slice(0, 6).map((r) => `${r.label}=${r.value}`).join('، ')}`
      if (c.kind === 'table') {
        const head = c.rows
          .slice(0, 5)
          .map((r) => Object.values(r).join(' | '))
          .join(' ؛ ')
        const footer = c.footer?.map((f) => `${f.label}=${f.value}`).join('، ') ?? ''
        return `${c.title} (${c.rows.length} صف): ${head}${footer ? ` — ${footer}` : ''}`
      }
      if (c.kind === 'sources') return `${c.title}: ${c.sources.length} مصدر`
      return `${c.title}: ${c.body.slice(0, 200)}`
    })
    .join('\n')
}

/**
 * Run ONE read tool through the guarded pipeline.
 *
 * Never throws: a timeout, a bad argument or a DB hiccup is reported back as
 * `{ok:false}` so the model can tell the owner the truth instead of the turn
 * dying (fail-closed, not fail-silent).
 */
export async function runToolPipeline(
  tool: string,
  businessId: string,
  args: Record<string, unknown> = {},
  opts: ToolPipelineOpts = {},
): Promise<ToolRun> {
  const started = Date.now()
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const budget = opts.budgetChars ?? DEFAULT_BUDGET_CHARS
  if (!READ_TOOLS.has(tool)) {
    return { tool, ok: false, cards: [], output: '', ms: 0, error: 'أداة غير معروفة' }
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    const cards = await Promise.race([
      runReadTool(tool as ReadTool, businessId, args),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`الأداة ${tool} خدت وقت أطول من ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
    const full = digestCards(cards)
    const output = full.length > budget ? `${full.slice(0, budget)}… [+${full.length - budget} حرف — النتيجة الكاملة ظاهرة للمستخدم في الكارت]` : full
    return { tool, ok: true, cards, output, ms: Date.now() - started, trimmed: output.length < full.length }
  } catch (err) {
    return {
      tool,
      ok: false,
      cards: [],
      output: '',
      ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Fan-out: run several read tools CONCURRENTLY.
 *
 * Sequential reads were the biggest avoidable latency in a multi-question turn
 * (Claude Code streams reads while the model is still talking; dsh runs a step's
 * tool calls as a batch). Order is preserved in the returned array so callers
 * stay deterministic.
 */
export async function runToolBatch(
  calls: { tool: string; args?: Record<string, unknown> }[],
  businessId: string,
  opts: ToolPipelineOpts = {},
): Promise<ToolRun[]> {
  const capped = calls.slice(0, 6)
  return Promise.all(capped.map((c) => runToolPipeline(c.tool, businessId, c.args ?? {}, opts)))
}

// ---------------------------------------------------------------------------
// «الخطّة» — plan-then-act

export interface PlanStep {
  tool: string
  args?: Record<string, unknown>
  /** Arabic one-liner shown on the wire («هجيب مبيعات الأسبوع وربحه») */
  why?: string
}

/**
 * Normalise whatever the model called `run_plan` with into a safe step list.
 *
 * Accepts `{plan:[…]}`, a bare array, or `{steps:[…]}` (models are creative),
 * drops anything unknown, caps the batch, and refuses plans that contain a
 * write tool — a plan is a READ-ONLY construct by definition, so «خطة» can
 * never be a back door around the approval gate.
 */
export function normalizePlan(raw: unknown): PlanStep[] {
  const WRITE_TOOLS = new Set([
    'record_sale',
    'record_purchase',
    'record_collection',
    'record_payment',
    'record_expense',
    'register_member',
    'record_attendance',
    'adjust_stock',
    'reverse_operation',
    'schedule_task',
    'memory_save',
    'memory_forget',
    'set_persona',
    'run_plan',
    'deep_dive',
  ])
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { plan?: unknown }).plan)
      ? ((raw as { plan: unknown[] }).plan as unknown[])
      : raw && typeof raw === 'object' && Array.isArray((raw as { steps?: unknown }).steps)
        ? ((raw as { steps: unknown[] }).steps as unknown[])
        : []
  const out: PlanStep[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const tool = String((item as { tool?: unknown }).tool ?? '')
    if (!READ_TOOLS.has(tool) || WRITE_TOOLS.has(tool)) continue
    const args = (item as { args?: unknown }).args
    const why = (item as { why?: unknown }).why
    out.push({
      tool,
      args: args && typeof args === 'object' ? (args as Record<string, unknown>) : {},
      why: typeof why === 'string' ? why.slice(0, 80) : undefined,
    })
    if (out.length >= 6) break
  }
  return out
}

// ---------------------------------------------------------------------------
// «باحث» — the isolated researcher sub-agent

export interface SubAgentResult {
  summary: string
  facts: string[]
  rounds: number
  toolsUsed: string[]
  ms: number
}

export interface SubAgentDeps {
  /** the model call (injected so tests can run the loop without a provider) */
  complete: (messages: { role: 'system' | 'user' | 'assistant'; content: string }[]) => Promise<string>
  /** one Arabic line per tool call, streamed to the thinking trace */
  onStep?: (label: string, detail: string) => void
  businessId: string
  question: string
  /** business context the researcher may see (it does NOT see the chat) */
  context?: string
  maxRounds?: number
  budgetMs?: number
}

/** Pull a JSON tool call out of a sub-agent reply (same emulation protocol). */
export function parseSubAgentCall(raw: string): { tool: string; args: Record<string, unknown> } | null {
  const t = (raw ?? '').trim()
  const s = t.indexOf('{')
  const e = t.lastIndexOf('}')
  if (s < 0 || e <= s) return null
  try {
    const obj = JSON.parse(t.slice(s, e + 1)) as { tool?: unknown; args?: unknown }
    const tool = String(obj.tool ?? '')
    if (!READ_TOOLS.has(tool)) return null
    const args = obj.args && typeof obj.args === 'object' ? (obj.args as Record<string, unknown>) : {}
    return { tool, args }
  } catch {
    return null
  }
}

/**
 * Run an ISOLATED research loop and return only the summary.
 *
 * WHY isolation (Claude Code's summary-only return): a question like «ليه
 * المبيعات نزلت؟» needs 4-6 reads whose raw output would flood the main
 * conversation's context — the parent would then have less room to actually
 * answer. The sub-agent burns its own context, keeps every intermediate result
 * to itself, and hands back a few hundred characters.
 */
export async function runSubAgent(deps: SubAgentDeps): Promise<SubAgentResult> {
  const started = Date.now()
  const maxRounds = deps.maxRounds ?? 3
  const budgetMs = deps.budgetMs ?? 12_000
  const toolsUsed: string[] = []
  const facts: string[] = []
  const system = [
    'انت «باحث وكيل» — باحث منفصل شغلته يجمع الحقائق من سجل المحل ويرجّع خلاصة مركّزة.',
    'ممنوع تمامًا: أي عملية كتابة، أي مسودة، أي تخمين. قراءة بس.',
    'الأدوات المتاحة:',
    ...Array.from(READ_TOOLS).map((t) => `- ${t}({...})`),
    '',
    'القاعدة: لما تحتاج بيانات نادِ أداة واحدة كـ JSON صافي بالشكل {"tool":"اسم_الأداة","args":{…}} وبلا أي كلام تاني.',
    'لما تكون جمعت اللي يكفي، اكتب الخلاصة النهائية كنص عربي مركّز: أهم ٣ أرقام + السبب + التوصية (٣ أسطر كحد أقصى).',
  ].join('\n')
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `السؤال: ${deps.question}\n\nسياق المحل:\n${(deps.context ?? 'لا يوجد').slice(0, 1200)}`,
    },
  ]
  let rounds = 0
  let summary = ''
  while (rounds < maxRounds && Date.now() - started < budgetMs) {
    rounds++
    let raw = ''
    try {
      raw = await deps.complete(messages)
    } catch {
      break // fail-closed: the caller keeps whatever facts we already have
    }
    const call = parseSubAgentCall(raw)
    if (!call) {
      // A JSON-looking reply with an unknown/malformed tool is a FAILED CALL,
      // not a final answer — writing «{"tool":"nope"}» as the summary would
      // hand the parent raw noise. Correct it and let the loop try again.
      const looksLikeCall = /^\s*[{[]/.test(raw) || /"tool"\s*:/.test(raw)
      if (looksLikeCall) {
        messages.push({ role: 'assistant', content: raw.slice(0, 400) })
        messages.push({
          role: 'user',
          content:
            'الأداة دي مش موجودة أو الصيغة غلط. استخدم واحدة من قائمة الأدوات المتاحة بصيغة {"tool":"الاسم","args":{…}} أو اكتب الخلاصة النهائية كنص عربي.',
        })
        continue
      }
      summary = raw.trim().slice(0, 900)
      break
    }
    const run = await runToolPipeline(call.tool, deps.businessId, call.args, { budgetChars: 1_100 })
    toolsUsed.push(call.tool)
    deps.onStep?.(call.tool, run.ok ? 'لقيت بيانات' : (run.error ?? 'مشكلة'))
    facts.push(...extractNumbers(run.output))
    messages.push({ role: 'assistant', content: raw.slice(0, 600) })
    messages.push({
      role: 'user',
      content: run.ok
        ? `نتيجة ${call.tool}:\n${run.output}`
        : `أداة ${call.tool} فشلت (${run.error ?? 'خطأ'}) — جرّب أداة تانية أو اكتب الخلاصة باللي معاك.`,
    })
  }
  if (!summary) {
    summary = facts.length > 0 ? `جمعت ${facts.length} رقم من السجل — ${facts.slice(0, 4).join('، ')}` : 'ملقيتش بيانات كفاية للسؤال ده.'
  }
  return { summary, facts, rounds, toolsUsed, ms: Date.now() - started }
}

/** Numbers worth remembering from a tool digest (money/quantities). */
export function extractNumbers(text: string): string[] {
  const found = text.match(/[٠-٩0-9][٠-٩0-9٫.,]*\s?(?:ج\.م|%|يوم|قطعة|علبة|كيلو|جرام)?/g) ?? []
  const uniq: string[] = []
  for (const f of found) {
    const t = f.trim()
    if (t.length < 2) continue
    if (!uniq.includes(t)) uniq.push(t)
    if (uniq.length >= 12) break
  }
  return uniq
}

// ---------------------------------------------------------------------------
// Context pressure (DeepSeek's compaction listener, deterministically)

export interface ContextBudget {
  /** true when older tool results should be digested rather than kept whole */
  compressed: boolean
  keptFull: number
  digestedChars: number
}

/**
 * Decide how much of the tool conversation the model still gets to see.
 *
 * Deterministic on purpose: the first line of defence against context overflow
 * is arithmetic (keep the last N results whole, digest everything older), not
 * another model call. An LLM summariser is only worth its latency once this
 * cheap layer has already failed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function budgetToolHistory<T extends Record<string, any>>(
  history: T[],
  keepWhole = 3,
): { kept: T[]; budget: ContextBudget } {
  const kept = history.slice(-keepWhole)
  const older = history.slice(0, Math.max(0, history.length - keepWhole))
  let digestedChars = 0
  for (const h of older) digestedChars += JSON.stringify(h).length
  return { kept, budget: { compressed: older.length > 0, keptFull: kept.length, digestedChars } }
}

/** Retry helper used by the pipeline for transient DB contention (SQLITE_BUSY). */
export async function withDbRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const msg = err instanceof Error ? err.message : String(err)
      if (!/SQLITE_BUSY|database is locked|timeout/i.test(msg)) break
      await new Promise((r) => setTimeout(r, backoffMs(i)))
    }
  }
  throw lastErr
}

/** Counts for the audit trail — «context was compacted» is a fact worth logging. */
export async function logContextPressure(
  businessId: string,
  userId: string,
  detail: { keptFull: number; digestedChars: number; rounds: number },
): Promise<void> {
  try {
    await db.auditEvent.create({
      data: {
        businessId,
        actor: userId,
        action: 'context.compact',
        ref: `r${detail.rounds}`,
        detail: JSON.stringify(detail),
      },
    })
  } catch {
    // telemetry must never break a turn
  }
}
