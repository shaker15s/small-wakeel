// وكيل — THE AGENT HARNESS (multi-pass, deterministic, stream-first).
//
// Pass 0 (Instant): identity questions («انت مين»), memory-save requests
//   («احفظ اني...»), BUSINESS_DNA rules («لما أقولك... اكتبها بس متزودش عن...»)
//   and FORGET («انسى...») are answered deterministically from REAL DB data
//   with zero LLM calls — sub-second turns.
// Pass 1 (Understand): LLM extracts intent+fields as JSON — MAY return an
//   "intents" array for compound messages (multi-intent). A deterministic
//   Arabic splitter (و / ، / و بعدين) finds sub-requests with zero LLM too.
//   Rule-based fallback keeps the harness alive if the model is unreachable.
// Pass 2 (Resolve): server resolves entities/units/prices from the REAL
//   database — LEXICON memories (dialect aliases) are checked FIRST. The model
//   is never trusted with money. BUSINESS_DNA rules are enforced here
//   (credit-limit danger notes on drafts). عطارة reverse-selling («بعت بـ20
//   جنيه فلفل») computes weight from the real per-gram price.
// Pass 3 (Act): read tools run directly (R0); writes become drafts awaiting
//   approval (R2/R3) with a full action card. Multi-intent executes every
//   sub-request sequentially in ONE turn with «١/٣ …» thinking labels.
// Pass 4 (Explain): the reply streams letter-by-letter with ADAPTIVE pacing —
//   a 1.5s pacing budget from the first delta, never stacking delay on top of
//   a provider that is already slow. Advisory free-chat («موظف حقيقي») is a
//   real LLM conversation grounded in the live business snapshot.
// Pass 5 (Buttons): deterministic per-tool deep-link actions are emitted after
//   the reply deltas and persisted with the message.
//
// R15 «الموظف الحقيقي» additions:
//   Pass 0d (Research): explicit deepResearch toggle OR Arabic auto-detect →
//     plan-first pipeline (خطة → جمع من السجل → بحث ويب → مصادر مرقمة →
//     تقرير الخلاصة/التحليل/التوصيات) with self-verification BEFORE any delta.
//   Scratchpad («ورقة وقلم»): every tool run jots facts on the AgentNote paper
//     (fire-and-forget) and the newest notes are injected into every prompt.
//   Self-verification: numeric claims in the reply cross-checked against the
//     turn's ground-truth facts — wrong digits deterministically replaced.
//   Telemetry: ONE UsageEvent per turn (latency/ttft/tokens/fallback) + retry
//     ladder + circuit breaker on every LLM call (via ./llm wiring).
//
// Every turn writes a UsageEvent (tool/chat/advisory/research) so the
// suggestions engine and fraud radar learn from REAL usage.

import type { AgentMemory, Business, User, Item, Customer, Supplier } from '@prisma/client'
import { db } from '@/lib/db'
import type {
  ActionCardDTO,
  ChatActionDTO,
  OpType,
  ResearchDTO,
  ResultCardDTO,
  Risk,
  ThinkingStep,
  VerifyDTO,
} from '@/lib/types'
import type { VerticalDef } from '@/lib/verticals'
import { egp, qty as fmtQty, arDate } from '@/lib/format'
import { arUnit, getVertical } from '@/lib/verticals'
import { wordBoundedAt, convertToBaseUnit, matchEntity, normalizeAr, parseQuantity, toWesternDigits, unitToCode } from './arabic'
import { parseSinceClause } from './since'
import { createDraft } from '@/lib/domain/executors'
import { auditDraft } from '@/lib/domain/audit'
import { getCatalog } from './catalog'
import type { AuditFindingDTO } from '@/lib/types'
import { canDraft, computeRisk, RISK_META } from '@/lib/domain/risk'
import { completeChat, llmHealth, modelLabelFor, resolveModel, streamChat, type LLMMessage } from './llm'
import { RESEARCH_TRIGGER_RE, isActionableIntent, runDeepResearch } from './research'
import { ensurePrismaFresh, jotFactsFromCards, jotNote, notesContext } from './scratchpad'
import { activeTools, userToolsPromptLine } from './userTools'
import { factsFromCards, verifyReply, type VerifyFact } from './verify'
import { buildAdvisoryPrompt, buildAgentSystemPrompt, buildReplyPrompt, buildSystemPrompt, roleTitle, TONE_AR } from './prompt'
import { READ_TOOLS, runReadTool, TYPE_AR, type ReadTool } from './tools'
import {
  budgetToolHistory,
  logContextPressure,
  normalizePlan,
  runSubAgent,
  runToolPipeline,
  type ToolRun,
} from './pipeline'
import {
  bumpMemoryUsage,
  creditLimitFor,
  extractForgetRequest,
  extractRuleRequest,
  extractSaveRequest,
  findMemoryByReference,
  getSnapshot,
  isRuleText,
  learnableAlias,
  lexiconResolve,
  parseLexicon,
  pruneLexicon,
  preferenceCategory,
  ruleCategory,
  saveLexiconMemory,
  type LexiconEntry,
} from './memory'

export interface TurnEmit {
  (ev:
    | { event: 'thinking'; steps: ThinkingStep[] }
    | { event: 'step'; label: string; state: 'active' | 'done' }
    | { event: 'card'; card: ActionCardDTO }
    | { event: 'cards'; cards: ResultCardDTO[] }
    /** R28: a plan the agent is about to execute, shown before it runs */
    | { event: 'plan'; steps: string[] }
    | { event: 'actions'; actions: ChatActionDTO[] }
    | { event: 'delta'; text: string }): void
}

interface TurnContext {
  business: Business
  user: User
  conversationId: string
  text: string
  modelKey: string | null
  history: { role: string; text: string }[]
  /** R15: user-toggled deep research («بحث عميق») — forces the research pipeline */
  deepResearch?: boolean
}

/** Context handed to entity resolution — lexicon + active rules + usage side-effects. */
interface MemoryContext {
  lexicon: LexiconEntry[]
  rules: AgentMemory[]
  /** ids of memories actually referenced this turn (bumped as usageCount after the reply) */
  referencedIds: string[]
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Pacing — ADAPTIVE: a fixed budget from the first delta, 1-2 char pieces,
// and a hard floor so a slow provider never gets delay stacked on top of it.
// ---------------------------------------------------------------------------
const REPLY_PACING_BUDGET_MS = 1500
const PIECE_DELAY_MIN_MS = 3
const PIECE_DELAY_MAX_MS = 26

interface PacerState {
  t0: number | null
  emitted: number
}

/** Per-piece delay = clamp(remaining_budget / remaining_pieces, 3, 26)ms.
 * The moment elapsed time eats the whole budget (the provider itself is slow),
 * the delay collapses to the 3ms floor — never stack delay on a slow provider. */
function adaptivePieceDelay(p: PacerState, remainingInChunk: number): number {
  const now = Date.now()
  if (p.t0 == null) p.t0 = now
  const remainingBudget = REPLY_PACING_BUDGET_MS - (now - p.t0)
  if (remainingBudget <= 0) return PIECE_DELAY_MIN_MS
  // Estimate the pieces still coming: at least the rest of this chunk, and at
  // least as many as we've already emitted (replies rarely stop abruptly).
  const estimatedRemaining = Math.max(remainingInChunk, p.emitted, 1)
  return Math.min(PIECE_DELAY_MAX_MS, Math.max(PIECE_DELAY_MIN_MS, remainingBudget / estimatedRemaining))
}

/** Stream a fully-known deterministic reply in 1-2 char pieces within `budgetMs`
 * (identity/memory replies: whole text known upfront, exact remaining count). */
async function streamDeterministic(text: string, emit: TurnEmit, budgetMs = REPLY_PACING_BUDGET_MS): Promise<void> {
  // [\s\S] (not `.` + dotAll `s` flag) is CRITICAL: plain `.` never matches
  // \n, so a multi-line template would lose its line breaks mid-stream (and the
  // project targets ES2017, where the `s` flag is a tsc error).
  const pieces = text.match(/[\s\S]{1,2}/g) ?? []
  const t0 = Date.now()
  for (let i = 0; i < pieces.length; i++) {
    emit({ event: 'delta', text: pieces[i] })
    const remainingPieces = pieces.length - i - 1
    if (remainingPieces <= 0) break
    const remainingBudget = budgetMs - (Date.now() - t0)
    if (remainingBudget <= 0) {
      await sleep(PIECE_DELAY_MIN_MS)
      continue
    }
    await sleep(Math.min(PIECE_DELAY_MAX_MS, Math.max(PIECE_DELAY_MIN_MS, remainingBudget / remainingPieces)))
  }
}

// ---------------------------------------------------------------------------
// Usage events — REAL usage feeds the suggestions engine + fraud radar
// ---------------------------------------------------------------------------
async function trackUsage(businessId: string, userId: string, kind: 'tool' | 'chat' | 'advisory', label: string): Promise<void> {
  try {
    await db.usageEvent.create({ data: { businessId, userId, kind, label: label.slice(0, 80) } })
  } catch (e) {
    console.error('[harness] usageEvent failed:', e)
  }
}

// ---------------------------------------------------------------------------
// R15 per-turn telemetry — ONE UsageEvent with latency / TTFT / tokens /
// fallback, so the «100-expert council» observability gap closes for real.
// ---------------------------------------------------------------------------

interface TurnTelemetry {
  latencyMs: number
  ttftMs: number | null
  tokens: number
  fallback: boolean
}

async function trackTurnUsage(
  businessId: string,
  userId: string,
  kind: 'chat' | 'advisory' | 'research',
  label: string,
  t: TurnTelemetry,
): Promise<void> {
  try {
    await db.usageEvent.create({
      data: {
        businessId,
        userId,
        kind,
        label: label.trim().slice(0, 40),
        latencyMs: Math.max(0, Math.round(t.latencyMs)),
        ttftMs: t.ttftMs == null ? null : Math.max(0, Math.round(t.ttftMs)),
        tokens: t.tokens,
        fallback: t.fallback,
      },
    })
  } catch (e) {
    console.error('[harness] turn usageEvent failed:', e)
  }
}

/** Small auxiliary event kinds (verify: label = the verification status). */
async function trackKindEvent(businessId: string, userId: string, kind: 'verify', label: string): Promise<void> {
  try {
    await db.usageEvent.create({ data: { businessId, userId, kind, label: label.slice(0, 40) } })
  } catch (e) {
    console.error('[harness] kind usageEvent failed:', e)
  }
}

// ---------------------------------------------------------------------------
// Deep-link action buttons — deterministic per-tool, NEVER model-generated.
// وكيل بيفهم التطبيق كله: كل أداة بتفتح الشاشة اللي بتناسبها.
// ---------------------------------------------------------------------------
const TOOL_ACTIONS: Record<string, ChatActionDTO[]> = {
  get_daily_summary: [
    { id: 'act-get_daily_summary', label: 'افتح الإحصائيات', view: 'stats', icon: 'chart', tone: 'primary' },
    { id: 'act-get_daily_summary-today', label: 'لوحة اليوم', view: 'today', icon: 'today', tone: 'outline' },
  ],
  get_cash_position: [{ id: 'act-get_cash_position', label: 'لوحة اليوم', view: 'today', icon: 'wallet', tone: 'primary' }],
  list_low_stock: [{ id: 'act-list_low_stock', label: 'افتح المخزون', view: 'inventory', icon: 'boxes', tone: 'primary' }],
  list_expiring: [{ id: 'act-list_expiring', label: 'افتح المخزون', view: 'inventory', icon: 'boxes', tone: 'primary' }],
  list_receivables: [{ id: 'act-list_receivables', label: 'حسابات العملاء', view: 'accounts', icon: 'users', tone: 'primary' }],
  list_payables: [{ id: 'act-list_payables', label: 'حسابات الموردين', view: 'accounts', icon: 'users', tone: 'primary' }],
  get_activity_history: [{ id: 'act-get_activity_history', label: 'سجل العمليات', view: 'journal', icon: 'journal', tone: 'primary' }],
  search_catalog: [{ id: 'act-search_catalog', label: 'افتح المخزون', view: 'inventory', icon: 'boxes', tone: 'primary' }],
  get_item_stock: [{ id: 'act-get_item_stock', label: 'افتح المخزون', view: 'inventory', icon: 'boxes', tone: 'primary' }],
  get_supplier_balance: [{ id: 'act-get_supplier_balance', label: 'حسابات الموردين', view: 'accounts', icon: 'users', tone: 'primary' }],
  get_member_status: [{ id: 'act-get_member_status', label: 'حسابات العملاء', view: 'accounts', icon: 'users', tone: 'primary' }],
  get_transaction_status: [{ id: 'act-get_transaction_status', label: 'سجل العمليات', view: 'journal', icon: 'journal', tone: 'primary' }],
}

const DRAFT_ACTIONS: ChatActionDTO[] = [
  { id: 'act-journal', label: 'سجل العمليات', view: 'journal', icon: 'journal', tone: 'outline' },
]

/** Short Arabic labels per tool — multi-intent step labels «١/٣: ملخص اليوم». */
const TOOL_LABEL_AR: Record<string, string> = {
  get_daily_summary: 'ملخص اليوم',
  get_cash_position: 'وضع الخزنة',
  list_low_stock: 'النواقص في المخزون',
  list_receivables: 'الحسابات المستحقة',
  list_payables: 'مستحقات الموردين',
  list_expiring: 'الصلاحيات القريبة',
  search_catalog: 'بحث في الكتالوج',
  get_item_stock: 'رصيد صنف',
  get_supplier_balance: 'رصيد مورد',
  get_member_status: 'حالة عضو',
  get_activity_history: 'آخر الحركات',
  get_transaction_status: 'حالة عملية',
  // R28 superpowers
  get_profit_margin: 'حساب الربح',
  forecast_stockout: 'توقّع النقص',
  get_customer_history: 'ملف العميل',
  compare_periods: 'مقارنة الفترات',
  expense_breakdown: 'تفصيل المصروفات',
  run_plan: 'خطة متعددة الخطوات',
  deep_dive: 'تحقيق عميق',
  search_web: 'بحث في الويب',
  business_advice: 'قراءة شغلك',
  sale: 'مسودة بيع',
  purchase: 'مسودة شرا',
  expense: 'مسودة مصروف',
  collection: 'مسودة تحصيل',
  payment: 'مسودة سداد',
  stock_adjustment: 'مسودة تسوية مخزون',
  membership: 'مسودة اشتراك',
  attendance: 'مسودة حضور',
  reversal: 'مسودة عكس عملية',
}

const AR_ORDINALS = ['١', '٢', '٣', '٤', '٥', '٦']

/** 3 → «٣» — every number the user READS in replies/steps is an Arabic numeral. */
function toArabicNum(n: number): string {
  return String(n).replace(/[0-9]/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)])
}

// ---------------------------------------------------------------------------
// Instant intents — zero LLM, zero latency
// ---------------------------------------------------------------------------

/** «انت مين» / «اسمك ايه» / «بتعمل ايه»… (run on normalizeAr'd text).
 * NOTE: \b doesn't work with Arabic letters — use (^|\s)…(\s|$) patterns. */
const IDENTITY_QUESTION_RES: RegExp[] = [
  /(^|\s)(انت|انتا|انتي)\s*(مين|من)\s*(انت|انتي|يعني)?(\s|$|؟|\?)/,
  /(^|\s)مين\s*(انت|انتا|انتي)(\s|$|؟|\?)/,
  /(^|\s)اسمك(\s|$)/,
  /بتاع\s*(مين|ايه)/,
  /عرفني\s*بنفسك/,
  /بتعمل\s*(ايه|اد\s*ايه)/,
  /(^|\s)انت\s*(ايه|مين)(\s|$|؟|\?)/,
]

/** Strong business keywords mean the message is NOT about the agent's identity. */
const IDENTITY_BLOCK_RE =
  /(بعت|بيع|شرا|اشتري|خزن|كاش|مخزون|ناقص|ملخص|صلاحيه|مديون|مورد|تحصيل|مصروف|سدد|اشتراك|حضور|تسويه|عكس|احفظ|تسجل|سجل بيع)/

function isIdentityQuestion(norm: string): boolean {
  if (norm.length > 80 || IDENTITY_BLOCK_RE.test(norm)) return false
  return IDENTITY_QUESTION_RES.some((re) => re.test(norm))
}

/** Persona self-introduction, grounded 100% in real DB data. 3 variants so
 * repeat asks don't feel robotic. */
function buildIdentityReply(params: {
  business: Business
  user: User
  verticalLabel: string
  memoryText: string | null
  lowStockCount: number
  pendingCount: number
  receivablesTotal: number
}): string {
  const { business, user, verticalLabel, memoryText, lowStockCount, pendingCount, receivablesTotal } = params
  const who = `${user.name} — ${roleTitle(user)}`
  const mem = memoryText ? `«${memoryText.slice(0, 120)}${memoryText.length > 120 ? '…' : ''}»` : null
  const parts: string[] = []
  if (lowStockCount > 0) parts.push(`${lowStockCount} صنف ناقص`)
  if (pendingCount > 0) parts.push(`${pendingCount} عملية مستنية اعتماد`)
  if (receivablesTotal > 0) parts.push(`${egp(receivablesTotal)} عند العملاء`)
  const follow =
    parts.length > 0
      ? `ودلوقتي بتابع: ${parts.join('، ')}.`
      : 'ودلوقتي بتابع: كل حاجة مستقرة — مفيش أصناف ناقصة ولا عمليات مستنية.'

  const templates = [
    `أنا «وكيل» — الموظف الرقمي بتاع «${business.name}» (${verticalLabel})، وجزء من تطبيق «وكيل»: مساعد شغل يومي للمنشآت الصغيرة في مصر، بيسجّل ويحسب ويتابع ويتحقق.\nباشتغل مع ${who} على مدار الوقت${mem ? ` — وبفتكر من كلامك: ${mem}` : '، ولّسه بجمع ذاكرتي عنك'}.\nشغلي موثوق: أي عملية بتتحول لمسودة معتمدة، وبعد التنفيذ بتحقق منها — عمره ما رقم يدخل من غير ما يتوثق.\n${follow}\nقولي أي حاجة في شغلك وأنا أتصرف.`,
    `يا ${user.name}، أنا وكيل — مساعدك الرقمي في «${business.name}» (${verticalLabel})، وجزء من تطبيق «وكيل» للمنشآت الصغيرة.\nمش شات عام — أنا موظف شغل: بيسجّل ويحسب ويتابع ويتحقق، وبتعامل مع ${who}${mem ? ` وبفتكر: ${mem}` : '، ولسّه ذاكرتي عنك بتجمع'}.\nأي عملية هنا: مسودة معتمدة ← تنفيذ ← تحقق، والأرقام كلها من سجلك الحقيقي.\n${follow}\nتحت أمرك — قول وأنا أتصرف.`,
    `اسمي وكيل، وجزء من تطبيق «وكيل» — مساعد شغل يومي للمنشآت الصغيرة في مصر، بيسجّل ويحسب ويتابع ويتحقق. شغّال هنا في «${business.name}» (${verticalLabel}) مع ${who}.\n${mem ? `وبفتكر عنك: ${mem}.` : 'ولسّه بجمع ذاكرتي عنك.'}\nبنظام: كل عملية مسودة معتمدة الأول، وبعد التنفيذ بتحقق منها — مفيش رقم بيدخل من غير توثيق.\n${follow}\nقولي أي حاجة وأنا أجهزهالك.`,
  ]
  return templates[Math.floor(Math.random() * templates.length)]
}

// ---------------------------------------------------------------------------
// Rule-based intent fallback (keeps the agent alive even with zero LLM)
// ---------------------------------------------------------------------------
interface ExtractedIntent {
  intent: 'read' | 'write' | 'chat'
  tool?: string
  opType?: OpType
  fields: Record<string, unknown>
  question?: string
  replyHint?: string
}

/**
 * The deterministic rule ladder. Exported under a test-only name because the
 * ladder IS the offline contract: when every provider is down, these rules are
 * what still answers the owner. `tests/integration/superpowers.test.ts` pins the
 * routing of the five superpower questions to this function.
 */
export function ruleBasedIntentForTest(text: string, businessType: string): ExtractedIntent {
  return ruleBasedIntent(text, businessType)
}

function ruleBasedIntent(text: string, businessType: string): ExtractedIntent {
  const s = normalizeAr(text)
  const isGym = businessType === 'gym'

  if (/(السلام|اهلا|هلا|صباح|مساء|ازيك|عامل ايه|شكرا)/.test(s) && s.length < 25) {
    return { intent: 'chat', fields: {}, replyHint: 'تحية' }
  }
  // ---- R29 (1) WEB SEARCH beats every local keyword: the owner EXPLICITLY asked
  // the internet, and answering him from the catalog is a wrong-answer class.
  const webAsk =
    /(ابحث|ادور|دور|فتش|فتّش|شوف)\s*(لي|ليا|ليّ)?\s*(في|على|ع|ف)?\s*(النت|نت|الويب|الانترنت|الإنترنت|جوجل|google|اونلاين|online)/.test(s) ||
    /(في|على|ع)\s*(النت|الويب|الانترنت|جوجل)/.test(s) ||
    /(اخبار|اسعار)\s*(السوق|الدولار|العالم)/.test(s) ||
    /سعر\s*السوق/.test(s)
  if (webAsk) {
    const q = s
      .replace(/^(ابحث|ادور|دور|فتش|فتّش|شوف)\s*(لي|ليا|ليّ)?\s*(في|على|ع|ف)?\s*(النت|نت|الويب|الانترنت|الإنترنت|جوجل|google|اونلاين|online)\s*(عن|على)?\s*/, '')
      .replace(/[؟?].*$/, '')
      .trim()
    return { intent: 'read', tool: 'search_web', fields: q.length >= 2 ? { query: q.slice(0, 80) } : {} }
  }
  // ---- R29 (2) «انصحني / حلل / إزاي أطوّر» → the ADVISOR, grounded in the
  // ledger. It must beat «مصاريف» (else «إزاي أقلل المصاريف» returns a table and
  // no advice — the R29 sweep caught exactly that).
  if (
    /(انصحني|انصح|انصحي|نصيحه|نصائح|نصايح|ازاي اطور|ازاي ازود|ازاي اقلل|ازاي احسن|ازاي اكسب|حلل|حللي|راجعلي|راجع لي|قيم|تقييم شغلي|قراءه شغلي|شايف شغلي|خطط ليا|اقترح عليا)/.test(s) &&
    !/(بعت|بيع|سجل بيع|اشتريت|حصلت)/.test(s)
  ) {
    return { intent: 'read', tool: 'business_advice', fields: {} }
  }
  // ---- R29 (3) GROW THE LEDGER: «ضيف/اضف (...) أحمد ...» is a WRITE and must
  // beat the receivables read («من اللي عليهم فلوس»).
  if (/(^|\s)(ضيف|اضف|اضيف|ضف)\s/.test(s) && /(عميل|عضو|زبون|مورد|راجل|ست|حاج|من اللي عليهم|من اللي علينا|جديد)/.test(s)) {
    const parsed = parsePartyAdd(s)
    const kind: 'customer' | 'supplier' = /مورد/.test(s) ? 'supplier' : 'customer'
    const opType: OpType = kind === 'supplier' ? 'supplier_add' : 'customer_add'
    const fields: Record<string, unknown> = {
      ...(parsed ? { name: parsed.name } : {}),
      ...(parsed?.balance != null ? { balance: parsed.balance } : {}),
      ...(parsed?.phone ? { phone: parsed.phone } : {}),
      ...(parsed?.plan ? { plan: parsed.plan } : {}),
      ...(parsed?.months ? { months: parsed.months } : {}),
      ...(parsed?.since ? { since: parsed.since } : {}),
    }
    return { intent: 'write', opType, fields }
  }
  // Opinion/decision-seeking → ADVISORY free-chat (the real-employee mode).
  // Must beat the price-query rule below so «رأيك أزود سعر الكمون؟» is a
  // conversation about the decision, never a bare catalog scan.
  if (/(رايك|رأيك|ايه رايك|تنصحني|نصيحه|اعمل ايه لو|تشوف ايه|رايك ايه|استشاره)/.test(s) && !/(بعت|بيع|سجل بيع|تحصيل|اشتري)/.test(s)) {
    return { intent: 'chat', fields: {}, replyHint: 'استشارة شغل' }
  }
  // Stock ADJUSTMENT write («عدل مخزون البيض يبقى ٥٠») must beat the low-stock READ
  if (/(مخزون|استوك)/.test(s) && /(عدل|ظبط|خلي|زود|نقص|صحح|سوي|يبقى|تسويه|اضبط)/.test(s)) {
    return { intent: 'write', opType: 'stock_adjustment', fields: {} }
  }
  if (/(وضع|رصيد|حاله) الخزنه|الخزنه|كاش/.test(s)) return { intent: 'read', tool: 'get_cash_position', fields: {} }
  // «النواقص» / «نواقص» are the broken plurals an Egyptian owner actually uses —
  // a substring test for «ناقص» misses them entirely.
  if (/(مخزون|ناقص|نواقص|استوك|تحت الحد)/.test(s) && !/(بعت|بيع|شرا|اشتري)/.test(s)) return { intent: 'read', tool: 'list_low_stock', fields: {} }
  if (/(صلاحيت|صلاحيه|منتهي|قربت|تنتهي|ينتهي|بينتهي|هينتهي|قربت تخلص|هتخلص صلاحيت|قرب يخلص)/.test(s)) {
    return { intent: 'read', tool: 'list_expiring', fields: {} }
  }
  // ---- R29: a NAME + «عليه/عليها كام» → that customer's real statement, not
  // the whole receivables list. «أحمد عليه كام؟» is the owner's most common
  // question and it used to fall through to free chat.
  const mWhose = s.match(/(?:^|\s)((?:[^\s،,؟?]+\s+){0,2}[^\s،,؟?]+)\s+(?:عليه|عليها|عليهم|عليا|علينا)\s*(?:كام|قد ايه|قدايه|بكام|فلوس|الف|اد ايه)/)
  if (mWhose) {
    const name = mWhose[1].replace(/^(و|هو|هي|العميل|العميله|بتاع|بتاعت)\s+/, '').trim()
    if (name.length >= 2 && name.length <= 30 && !/^(على|مين|اللي|هما|هو|هي)$/.test(name)) {
      return { intent: 'read', tool: 'get_customer_history', fields: { name } }
    }
    return { intent: 'read', tool: 'list_receivables', fields: {} }
  }
  if (/(مديون|اللي ليا|تحصيلات|مين عليها|عليها فلوس|عليهم فلوس|العملاء)/.test(s)) return { intent: 'read', tool: 'list_receivables', fields: {} }
  if (/(اللي علينا|للمورد|الموردين|مستحق)/.test(s)) return { intent: 'read', tool: 'list_payables', fields: {} }
  if (/(ملخص|كويس اليوم|حال اليوم|عملت ايه النهارده)/.test(s)) return { intent: 'read', tool: 'get_daily_summary', fields: {} }
  // ---- R28 superpowers: money & future questions (deterministic, offline-safe)
  // «بربح كام؟ / الهامش؟ / إيه اللي مش مربح؟»
  if (/(بربح|بكسب|مكسب|ربح|هامش|مربح|بيكسب)/.test(s) && !/(بعت|بيع|شرا|اشتري)/.test(s)) {
    return { intent: 'read', tool: 'get_profit_margin', fields: {} }
  }
  // «إيه اللي هيخلص؟ / هينقص إمتى؟ / توقّع»
  if (/(هيخلص|هينقص|هتخلص|توقع|متوقع|نفض|معدل البيع|كم يوم باقي)/.test(s)) {
    return { intent: 'read', tool: 'forecast_stockout', fields: {} }
  }
  // «بيحاسب إزاي؟ / بيسدد كل قد إيه؟ / ملف العميل»
  if (/(بيسدد|بيحاسب|ملف العميل|تاريخ العميل|بيدفع كل)/.test(s)) {
    // name = the words after «العميل»/«ملف» or after the verb, e.g.
    // «ملف العميل أم حسن» / «أم حسن بتسدد كل قد إيه؟»
    const mName = s.match(/(?:ملف|تاريخ)\s+(?:العميل\s+)?([^ ،,؟?]+(?:\s+[^ ،,؟?]+)?)/) ?? s.match(/^\s*([^ ،,؟?]+(?:\s+[^ ،,؟?]+)?)\s+(?:بتسدد|بيسدد|بيحاسب|بيدفع)/)
    const name = mName ? mName[1].replace(/^(العميل|بتاع|من)\s*/, '').trim() : ''
    return { intent: 'read', tool: 'get_customer_history', fields: name && name.length >= 2 ? { name } : {} }
  }
  // «أنا أحسن من الأسبوع اللي فات؟ / قارن»
  if (/(احسن من|أحسن من|قارن|مقارنه|مقارنة|اللي فات|الشهر اللي فات|الاسبوع اللي فات)/.test(s)) {
    return { intent: 'read', tool: 'compare_periods', fields: {} }
  }
  // «فلوسي بتتصرف في إيه؟ / المصروفات على إيه؟»
  if (/(بتتصرف|بيتصرف|مصاريف|مصروفات|بنصرف)/.test(s) && !/(سجل|دفعت|مصروف جديد)/.test(s)) {
    return { intent: 'read', tool: 'expense_breakdown', fields: {} }
  }
  // «الجبنة الرومي عندي كام كيلو؟» / «رصيد اللبن كام؟» → THAT item's stock.
  // Live R29: this fell through to free chat and the owner got «قولّي تحب نعمل
  // إيه» for the most ordinary question in the shop.
  if (/(عندي|معايا|فاضل|باقي|رصيد)\s+(كام|قد ايه|قدايه)/.test(s) || /كام\s+(كيلو|علبه|كرتونه|قطعه|شريط|جرام)/.test(s)) {
    const mItem = s
      .replace(/\?|؟/g, ' ')
      .match(/(?:^|\s)(?:رصيد|مخزون)\s+([^\s،,]+(?:\s+[^\s،,]+)?)/) ??
      s.match(/(?:^|\s)([^\s،,؟?]+(?:\s+[^\s،,؟?]+)?)\s+(?:عندي|معايا|فاضل|باقي)/)
    const q = mItem?.[1]?.replace(/^(اللي|اللي\s)/, '').trim() ?? ''
    if (q.length >= 2) return { intent: 'read', tool: 'get_item_stock', fields: { name: q.slice(0, 40) } }
  }
  // Price query («ايه سعر عود كمبودي؟» / «بكام المسك؟») → catalog search (R0 read)
  if (/(سعر|بكام)/.test(s) && !/(بعت|بيع|بع |خرج|سلف|دفع|سجل)/.test(s)) {
    const q = s
      .replace(/^.*?(?:سعر|بكام)\s*/, '')
      .replace(/[؟?].*$/, '')
      .replace(/\s*(?:سعر|بكام|ايه|هو)\s*/g, ' ')
      .replace(/^\s*(?:في|من)\s*/, '')
      .trim()
    if (q.length >= 2) return { intent: 'read', tool: 'search_catalog', fields: { query: q.slice(0, 40) } }
  }
  // Attendance (gym): noun «حضور» + Egyptian verb forms («كريم حضر»,
  // «لعب حصة PT», «خلص تدريب») — a member WORKED OUT today.
  if (/(حضور|(^| )حضر(ت)?( |$)|لعب حصه?|خلص (تدريب|حصه?)|اتمرن|اتدرب|عمل تمرين)/.test(s)) return { intent: 'write', opType: 'attendance', fields: {} }
  // Membership STATUS question — a READ, must beat the renewal WRITE below:
  // «عضوية عمر باقي قد ايه؟» → get_member_status for عمر (name word follows
  // عضويه/اشتراك); renewal verbs (جدد/تجديد/سجل) keep the WRITE path.
  if (isGym && !/(جدد|تجديد|سجل|اعمل)/.test(s)) {
    // «عمر الشناوي عضويته باقي قد إيه؟» — Egyptian owners put the NAME first and
    // the noun after it («عضويته»), which the old «عضوية X» pattern read as the
    // member «باقي». Both orders are tried, name-first wins when it is a name.
    const mBefore = s.match(/(^|\s)([^\s،,؟?]+(?:\s+[^\s،,؟?]+)?)\s+(?:عضويته|اشتراكه|عضويته\s*باقي|عضويه|اشتراك)(\s|$)/)
    const mMember = s.match(/(?:عضويه|اشتراك)\s+([^ ،,؟?]+)/)
    const candidate = mBefore?.[2]?.trim() || mMember?.[1]
    const name = candidate && !/^(اللي|التي|بتاع|دي|ده|الاشتراكات|باقي|قد|كام|فاضل|قربت|خلص|حاله|وضع)$/.test(candidate) ? candidate : ''
    const isQuestion = /(باقي|قد ايه|متبقي|فاضل|تنتهي|خلص|حاله|وضع|اوضه)/.test(s)
    if (name && (isQuestion || /عضويه/.test(s))) {
      return { intent: 'read', tool: 'get_member_status', fields: { name } }
    }
  }
  // Word-boundary forms only: «اشتراك عمر شهرية» matches, but a QUESTION like
  // «الاشتراكات اللي هتنتهي» (plural الاشتراكات) must NOT fire a membership write.
  // Verb forms count: «اشتركت سارة يناير» / «جددت لعمر» — a bare noun test missed
  // every sentence that uses the past tense, which is how owners talk.
  if (isGym && (/(^| )(اشتراك|تجديد|جديد لـ)( |$)/.test(s) || /جدد|جددت|اشتركت|تجدد/.test(s))) {
    return { intent: 'write', opType: 'membership', fields: {} }
  }
  if (/(مصروف|صرفت)/.test(s)) return { intent: 'write', opType: 'expense', fields: { label: 'مصروف' } }
  // Sale FIRST so a partial payment («بع لبن لأحمد بس دفع ٢٠ بس») never looks
  // like a collection. «بع» is the Egyptian imperative — standalone word.
  if (/(^| )(بعت|بيع|بع|خرج|سلفت)( |$)/.test(s)) return { intent: 'write', opType: 'sale', fields: {} }
  if (/(^| )(اشتريت|شرا|جبت|دخلت)( |$)/.test(s)) return { intent: 'write', opType: 'purchase', fields: {} }
  // Collection: «تحصيل ١٠٠ من أحمد» / «حصلت ١٠٠ من أحمد» / «أحمد دفع ١٠٠»
  // NOTE: «خلص» must be word-initial — «تخلص صلاحيته» (expiry) must NEVER
  // fire a collection (caught by the expiring rule above instead).
  if (/(تحصيل|(?:^| )خلص|سدد|دفع|حصل|قبض|استلم)/.test(s) && /(من|لـ|ل)/.test(s)) {
    return { intent: 'write', opType: 'collection', fields: {} }
  }
  if (/^(حصلت|قبضت|استلمت|خدت)/.test(s)) return { intent: 'write', opType: 'collection', fields: {} }
  if (/^(\S+)\s+(دفع|سدد|خلص|حصل)/.test(s)) return { intent: 'write', opType: 'collection', fields: {} }
  return { intent: 'chat', fields: {} }
}

// ---------------------------------------------------------------------------
// MULTI-INTENT — «لو طلبت منه اكتر من طلب يجاوب علي الكل»
// Deterministic Arabic compound splitter (و / ، / و بعدين) + LLM intents array.
// ---------------------------------------------------------------------------

interface SubIntent {
  intent: 'read' | 'write'
  tool?: string
  opType?: OpType
  fields: Record<string, unknown>
  replyHint?: string
  sourceText: string
}

interface RawIntentJson {
  intent?: string
  tool?: string
  opType?: string
  fields?: Record<string, unknown>
  question?: string
  replyHint?: string
  sourceText?: string
}

const VALID_OP_TYPES: ReadonlySet<string> = new Set([
  'sale', 'purchase', 'expense', 'collection', 'payment', 'stock_adjustment', 'membership', 'attendance', 'reversal',
  // R29: the owner grows the ledger by talking
  'customer_add', 'supplier_add',
])

/** Parse the LLM JSON contract: single intent OR the "intents" array (multi). */
function parseIntentJsonMulti(raw: string): { intents: RawIntentJson[]; single: ExtractedIntent | null } {
  const cleaned = raw.replace(/```json|```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return { intents: [], single: null }
  try {
    const json = JSON.parse(cleaned.slice(start, end + 1)) as Partial<ExtractedIntent> & { intents?: RawIntentJson[] }
    if (Array.isArray(json.intents)) {
      const valid = json.intents.filter((r) => r && typeof r.intent === 'string')
      if (valid.length >= 2) return { intents: valid, single: null }
      if (valid.length === 1) return { intents: [], single: rawToSingle(valid[0]) }
      return { intents: [], single: null }
    }
    if (!json.intent) return { intents: [], single: null }
    return { intents: [], single: rawToSingle(json as RawIntentJson) }
  } catch {
    return { intents: [], single: null }
  }
}

function rawToSingle(json: RawIntentJson): ExtractedIntent | null {
  const intent = json.intent === 'read' || json.intent === 'write' || json.intent === 'chat' ? json.intent : null
  if (!intent) return null
  return {
    intent,
    tool: json.tool,
    opType: json.opType as OpType | undefined,
    fields: (json.fields as Record<string, unknown>) ?? {},
    question: json.question,
    replyHint: json.replyHint,
  }
}

/** Read-request trigger keywords → tool (used by the deterministic splitter). */
const READ_SPLITTERS: [RegExp, string][] = [
  [/ملخص|حال اليوم|كويس اليوم|عملت ايه النهارده|اقفل الورديه/, 'get_daily_summary'],
  [/وضع الخزنه|رصيد الخزنه|الخزنه|الكاش/, 'get_cash_position'],
  [/النواقص|المخزون الناقص|الناقص|المخزون|استوك/, 'list_low_stock'],
  [/صلاحيه?|منتهي|قربت تخلص|تنتهي/, 'list_expiring'],
  [/مين عليها|عليها فلوس|عليهم فلوس|مديون|تحصيلات|اللي ليا/, 'list_receivables'],
  [/اللي علينا|للموردين|الموردين|مستحقات/, 'list_payables'],
  [/آخر الحركات|اخر الحركات|سجل العمليات|آخر العمليات|اخر العمليات|العمليات المستنيه/, 'get_activity_history'],
  [/سعر|بكام/, 'search_catalog'],
]

/** Sequence verbs that START a new request mid-message (never paid-clauses). */
const WRITE_CUT_RE = /بعت|اشتريت|اشتري|سجل|حصلت|قبضت|استلمت|سدد|صرفت|مصروف|تسويه|عكسها|اعكس/

/**
 * Deterministic compound splitter — «ملخص اليوم ومين عليها فلوس وايه الناقص
 * في المخزون» → 3 read sub-intents. Cuts at read-trigger keywords, sequence
 * verbs (بعت/سجل/…) and connectors (و بعدين/كمان) — never inside a multi-item
 * basket («بعت ٢ لبن و ١٠ بيض» stays ONE write). Zero LLM.
 */
function splitSubIntents(text: string, businessType: string): SubIntent[] {
  const norm = toWesternDigits(normalizeAr(text))
  if (norm.length < 8) return []
  type Hit = { at: number; len: number; tool: string | null }
  const hits: Hit[] = []
  for (const [re, tool] of READ_SPLITTERS) {
    const g = new RegExp(re.source, 'g')
    let m: RegExpExecArray | null
    while ((m = g.exec(norm)) != null) {
      hits.push({ at: m.index, len: m[0].length, tool })
      if (m.index === g.lastIndex) g.lastIndex++
    }
  }
  // sequence verbs — only when a و/، actually precedes them (mid-message cut)
  {
    const g = new RegExp(WRITE_CUT_RE.source, 'g')
    let m: RegExpExecArray | null
    while ((m = g.exec(norm)) != null) {
      const at = m.index
      const prev = at > 0 ? norm[at - 1] : ''
      const prev2 = at > 1 ? norm[at - 2] : ''
      const prev3 = at > 2 ? norm[at - 3] : ''
      const isBoundary =
        prev === 'و' || prev === '،' || prev === ',' || prev === '؛' || (prev === ' ' && (prev2 === 'و' || prev2 === '،')) || (prev === ' ' && prev2 === ' ' && prev3 === 'و')
      if (isBoundary) hits.push({ at, len: m[0].length, tool: null })
      if (m.index === g.lastIndex) g.lastIndex++
    }
  }
  // connectors «و بعدين» — cut at the connector itself
  {
    const g = /(بعدين|بعد كده|كمان)/g
    let m: RegExpExecArray | null
    while ((m = g.exec(norm)) != null) {
      hits.push({ at: m.index, len: m[0].length, tool: null })
      if (m.index === g.lastIndex) g.lastIndex++
    }
  }
  hits.sort((a, b) => a.at - b.at)
  if (hits.length === 0) return []

  // dedupe overlaps + same-tool continuations, build cut points
  const cuts: { at: number; tool: string | null }[] = []
  let coveredEnd = -1
  let currentTool: string | null = null
  for (const h of hits) {
    if (h.at < coveredEnd) continue // overlapping keyword (الخزنه inside وضع الخزنه)
    if (h.tool != null && h.tool === currentTool) {
      // same tool still talking — «سعر العنبر بكام؟» is ONE search, and
      // «سعر العود وبكام المسك» is one question about two items (the catalog
      // matcher is bidirectional-includes, so both still show in one card)
      coveredEnd = Math.max(coveredEnd, h.at + h.len)
      continue
    }
    // cut position: include a glued و in the PREVIOUS segment
    const cutAt = h.at > 0 && norm[h.at - 1] === 'و' ? h.at - 1 : h.at
    cuts.push({ at: cutAt, tool: h.tool })
    coveredEnd = h.at + h.len
    currentTool = h.tool
  }
  if (cuts.length === 0) return []

  // build segments
  const segments: { text: string; tool: string | null }[] = []
  const seg0 = norm.slice(0, cuts[0].at).replace(/[\s،,؛]+$/, '').trim()
  if (seg0.length > 0) segments.push({ text: seg0, tool: null })
  for (let i = 0; i < cuts.length; i++) {
    const end = i + 1 < cuts.length ? cuts[i + 1].at : norm.length
    const seg = norm.slice(cuts[i].at, end).replace(/^[\s،,؛و]+/, '').replace(/[\s،,؛]+$/, '').trim()
    if (seg.length > 0) segments.push({ text: seg, tool: cuts[i].tool })
  }

  // map segments → sub-intents
  const subs: SubIntent[] = []
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    // politeness prefixes («قوللي», «اط») — skip chat-y tiny segments
    if (seg.tool == null) {
      if (i === 0 && seg.text.length <= 6) continue
      const mapped = ruleBasedIntent(seg.text, businessType)
      if (mapped.intent === 'read' && mapped.tool) subs.push({ ...mapped, intent: 'read', tool: mapped.tool, sourceText: seg.text })
      else if (mapped.intent === 'write' && mapped.opType) subs.push({ ...mapped, intent: 'write', sourceText: seg.text })
      continue
    }
    // tool-owned segment
    if (seg.tool === 'search_catalog') {
      const q = seg.text
        .replace(/^(?:ايه|ايه هو|هو)?\s*(?:سعر|بكام)\s*/, '')
        .replace(/[؟?].*$/, '')
        .replace(/\s*(?:سعر|بكام|ايه|هو)\s*/g, ' ')
        .replace(/^\s*(?:في|من)\s*/, '')
        .trim()
      subs.push({ intent: 'read', tool: 'search_catalog', fields: q.length >= 2 ? { query: q.slice(0, 40) } : {}, sourceText: seg.text })
    } else {
      subs.push({ intent: 'read', tool: seg.tool, fields: {}, sourceText: seg.text })
    }
  }

  // merge CONSECUTIVE same-opType writes into one basket (multi-item scan)
  const merged: SubIntent[] = []
  for (const s of subs) {
    const last = merged[merged.length - 1]
    if (s.intent === 'write' && last && last.intent === 'write' && last.opType === s.opType) {
      last.sourceText = `${last.sourceText} و ${s.sourceText}`
      last.fields = { ...last.fields, ...s.fields }
      continue
    }
    if (s.intent === 'read' && last && last.intent === 'read' && last.tool === s.tool && s.tool !== 'search_catalog') {
      continue // duplicate read
    }
    merged.push({ ...s })
  }
  return merged
}

/** Normalize LLM multi-intents: validate, merge consecutive same-opType writes. */
function normalizeMultiIntents(raws: RawIntentJson[], fullText: string): SubIntent[] {
  const subs: SubIntent[] = []
  for (const r of raws) {
    if (r.intent === 'read' && r.tool && READ_TOOLS.has(r.tool)) {
      const source = typeof r.sourceText === 'string' && r.sourceText.trim().length > 0 ? r.sourceText.trim() : fullText
      subs.push({ intent: 'read', tool: r.tool as ReadTool, fields: (r.fields as Record<string, unknown>) ?? {}, replyHint: r.replyHint, sourceText: source })
    } else if (r.intent === 'write' && r.opType && VALID_OP_TYPES.has(r.opType)) {
      const source = typeof r.sourceText === 'string' && r.sourceText.trim().length > 0 ? r.sourceText.trim() : fullText
      subs.push({ intent: 'write', opType: r.opType as OpType, fields: (r.fields as Record<string, unknown>) ?? {}, replyHint: r.replyHint, sourceText: source })
    }
  }
  const merged: SubIntent[] = []
  for (const s of subs) {
    const last = merged[merged.length - 1]
    if (s.intent === 'write' && last && last.intent === 'write' && last.opType === s.opType) {
      // consecutive same-type writes = ONE basket; full-text scan finds the lines
      last.sourceText = fullText
      last.fields = { ...last.fields, ...s.fields }
      continue
    }
    if (s.intent === 'read' && last && last.intent === 'read' && last.tool === s.tool && s.tool !== 'search_catalog') {
      continue // duplicate read
    }
    merged.push(s)
  }
  return merged
}

// ---------------------------------------------------------------------------
// Proactive hints — when a read tool surfaced real counts worth attention,
// the reply closes with one short heads-up (numbers only from real data).
// ---------------------------------------------------------------------------
function tableFooterCount(cards: ResultCardDTO[]): number | null {
  for (const c of cards) {
    if (c.kind !== 'table' || !c.footer) continue
    for (const f of c.footer) {
      const m = String(f.value).match(/[\d٠-٩]+/)
      if (m) {
        const west = m[0].replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
        const n = Number(west)
        if (Number.isFinite(n)) return n
      }
    }
  }
  return null
}

function proactiveHintFor(tool: string, cards: ResultCardDTO[]): string {
  if (tool === 'list_low_stock') {
    const n = tableFooterCount(cards)
    if (n != null && n > 0) return `قفل جملة قصيرة تنبّه على ${n} صنف ناقص من غير ما تكرر الأرقام كلها.`
  }
  if (tool === 'list_expiring') {
    const n = tableFooterCount(cards)
    if (n != null && n > 0) return `قفل جملة قصيرة تنبّه على ${n} صنف صلاحيته قربت تخلص من غير ما تكرر الأرقام كلها.`
  }
  if (tool === 'get_activity_history') {
    const pending = cards
      .flatMap((c) => (c.kind === 'table' ? c.rows : []))
      .filter((r) => String(r.status ?? '').includes('مستنية')).length
    if (pending > 0) return `قفل جملة قصيرة تنبّه على ${pending} عملية مستنية اعتماد من غير ما تكرر الأرقام كلها.`
  }
  return ''
}

/**
 * Deterministic reply for read turns when the LLM reply stream fails
 * (rate-limit / network). NEVER generic — quotes the REAL numbers the tools
 * just fetched, so the owner still gets a useful answer with the data below.
 */
function deterministicReadReply(cards: ResultCardDTO[]): string {
  for (const c of cards) {
    // «مفيش عميل بالاسم ده» — an ABSENCE is the answer; padding it with «دي
    // أرقام من سجلك» makes the agent sound like it did not listen (live R29).
    if (c.kind === 'kv') {
      const verdict = c.rows.find((r) => r.label === 'النتيجة')
      if (verdict) {
        const extra = c.rows.find((r) => r.label === 'قصدت؟' || r.label === 'الخطوة')
        return `${verdict.value}${extra ? ` — ${extra.value}` : ''}.`
      }
    }
    if (c.kind === 'kv' && c.rows.length > 0) {
      const parts = c.rows.slice(0, 4).map((r) => `${r.label} ${r.value}`).join(' · ')
      return `دي أرقام «${c.title}» من سجلك: ${parts}.`
    }
  }
  const table = cards.find((c) => c.kind === 'table') as Extract<ResultCardDTO, { kind: 'table' }> | undefined
  if (table) {
    const n = table.rows.length
    return `دي «${table.title}» من سجلك — ${toArabicNum(n)} ${n === 1 ? 'صف' : n === 2 ? 'صفين' : 'صفوف'}، التفاصيل في الكارت تحت.`
  }
  const text = cards.find((c) => c.kind === 'text') as Extract<ResultCardDTO, { kind: 'text' }> | undefined
  if (text && text.body.trim()) return text.body.trim().slice(0, 220)
  return 'دي النتايج من سجل الشغل، التفاصيل في الكارت تحت.'
}

/**
 * «الدقة» — does the spoken reply actually reference the cards it ships with?
 *
 * Live evidence (2026-10-17): the screen showed a real profit table AND a real
 * sale draft while the reply said «من رسالتك مفيش عملية محددة». A model that
 * ignores the numbers its own tools produced must not get to phrase the answer:
 * the deterministic composer says «دي أرقام «الربح الحقيقي» من سجلك: …» instead.
 *
 * Grounding is checked on normalized text, by EITHER a shared figure (a number
 * of ≥2 digits that appears in both the reply and the card) OR a distinctive
 * word (≥4 letters) taken from the card's title/rows. Deliberately permissive:
 * a fluent reply that mentions any real figure passes.
 */
/**
 * A reply that answers a satisfied lookup with «تحب نعمل إيه؟» is wrong by
 * construction — it is the canned chip-wall, not an answer. Detected by shape so
 * the fix holds whatever phrasing a provider invents.
 */
export function isCannedReply(text: string): boolean {
  const t = normalizeAr(text)
  return /(تحب نعمل ايه|تحب نجرب|مفيش عمليه محدده|تحت امرك يا فندم|مش لاقي حاجه محدده|قوليلي ايه اللي محتاجه|مفيش عمليه واضحه)/.test(t)
}

/**
 * Exported for tests: the «spoken reply ↔ its cards» contract.
 *
 * `question` (optional) is what the OWNER asked. Evidence that only echoes the
 * question is not evidence: «مصطفى الجزار 9215 عليه كام؟» was answered with
 * «أكيد … وفيها أرقام زي 9215» and the check passed because the 9215 came from
 * the name the owner himself typed. A reply must add the CARD's information.
 */
export function replyGroundsCards(text: string, cards: ResultCardDTO[], question = ''): boolean {
  const t = toWesternDigits(normalizeAr(text))
  const q = toWesternDigits(normalizeAr(question))
  const questionedNums = new Set((q.match(/\d[\d.,]*/g) ?? []).map((n) => n.replace(/[.,]/g, '')))
  const questionedWords = new Set(
    q
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 4)
      .map((w) => w.replace(/^(ال|و)/, '')),
  )
  const keys: string[] = []
  for (const c of cards.slice(0, 2)) {
    keys.push(c.title)
    if (c.kind === 'kv') for (const r of c.rows.slice(0, 4)) keys.push(String(r.value), r.label)
    else if (c.kind === 'table')
      for (const row of c.rows.slice(0, 3)) for (const val of Object.values(row)) keys.push(String(val))
    else if (c.kind === 'sources') keys.push(c.sources[0]?.title ?? '')
    else if (c.kind === 'text') keys.push(c.body.slice(0, 60))
  }
  const norm = keys.map((k) => toWesternDigits(normalizeAr(k))).join(' ')
  const replyNums = new Set(t.match(/\d[\d.,]*/g) ?? [])
  for (const num of norm.match(/\d[\d.,]*/g) ?? []) {
    if (num.replace(/[.,]/g, '').length < 2) continue
    if (!replyNums.has(num)) continue
    if (questionedNums.has(num.replace(/[.,]/g, ''))) continue // the owner's own number
    return true
  }
  // ---- VERDICT RULE: a card that says «ملقيتش» / «مفيش» IS the answer ----
  // Live R29: «أحمد عليه كام؟» returned a «ملقيتش عميل بالاسم» card while the
  // spoken reply said «أكيد — دي بيانات السجل الحقيقي». The owner reads the text
  // first, so a NEGATIVE verdict must be echoed as a negative — the reply may
  // not chat past its own finding.
  const VERDICT_MARKERS = ['ملقيتش', 'مفيش', 'معرفش', 'مش', 'ممنوع', 'فشل', 'مرفوض', 'غير', 'ماتسجلتش', 'ناقص']
  const verdicts = cards
    .filter((c): c is Extract<ResultCardDTO, { kind: 'kv' }> => c.kind === 'kv')
    .flatMap((c) => c.rows.filter((r) => r.label === 'النتيجة' || r.label === 'الحالة').map((r) => r.value))
  for (const v of verdicts) {
    const vn = toWesternDigits(normalizeAr(v))
    const marker = VERDICT_MARKERS.find((m) => vn.includes(m))
    if (marker && !t.includes(marker)) return false
  }
  // Generic nouns are NOT evidence of grounding: «أكيد — دي بيانات السجل الحقيقي»
  // shares «بيانات» with almost any card and used to pass the check while saying
  // nothing (live R29). A real grounding word is specific: a name, an item, a
  // label — never the vocabulary of the UI itself.
  const GENERIC = new Set([
    'بيانات', 'سجل', 'كارت', 'كروت', 'تفاصيل', 'نتيجه', 'نتائج', 'حاله', 'تقرير',
    'معلومات', 'الرد', 'تحت', 'جاهز', 'تمام', 'اكيد', 'طبعا', 'اقول', 'قول',
    'الشغل', 'شغل', 'صفحه', 'شاشه', 'ملف', 'مرفق', 'جاهزه', 'موجود', 'متاح',
    // operation vocabulary: «تحصيل» sits in every ledger table, so a chip-wall
    // sentence offering «بيع، شرا، تحصيل» used to look «grounded» (live R29).
    'تحصيل', 'تحصيلات', 'بيع', 'مبيعات', 'شرا', 'مشتريات', 'مصروف', 'مصروفات', 'سداد',
    'حضور', 'اشتراك', 'خزنه', 'مخزون', 'نواقص', 'مستحقات', 'مديونيه', 'عملاء', 'موردين', 'مورد',
  ])
  const shared = new Set(
    norm
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 4)
      .map((w) => w.replace(/^(ال|و)/, '')),
  )
  return t
    .split(/[^\p{L}\p{N}]+/u)
    .map((w) => w.replace(/^(ال|و)/, ''))
    .some((w) => w.length >= 4 && !GENERIC.has(w) && shared.has(w) && !questionedWords.has(w))
}

/** Deterministic numbered multi-intent reply — answers EVERY sub-request, no LLM. */
function deterministicMultiReply(parts: string[], overflow: number): string {
  const sections = parts.map((p, i) => `${AR_ORDINALS[i] ?? i + 1}. ${p}`)
  const overflowNote = overflow > 0 ? `\n\n${toArabicNum(overflow)} ${overflow === 1 ? 'طلب' : 'طلبات'} تانية بعد دول — قولي نكمل فيهم؟` : ''
  const closer = sections.some((s) => s.includes('مسودة') || s.includes('مستنية'))
    ? '\n\nالمسودات تحت مستنية اعتمادك.'
    : '\n\nتحب تفاصيل أكتر على أي جزء؟'
  return sections.join('\n\n') + overflowNote + closer
}

/** Multi-intent LLM reply must answer every part with numbered sections — verify. */
function replyAnswersAllParts(reply: string, expected: number): boolean {
  const numbered = (reply.match(/^[٠-٩][.،)]/gm) ?? []).length + (reply.match(/^[1-4][.،)]/gm) ?? []).length
  if (expected >= 2 && numbered < 2) return false
  return true
}

/** Advisory fallback when the LLM stream dies — warm, NOT a chip wall. */
function advisoryFallback(v: VerticalDef): string {
  const two = v.chips.slice(0, 2)
  return `معلش النت شكله تقيل دلوقتي 😅 — سؤالك مهم ومش هضيعه. جرّب تبعتله تاني بعد شوية، أو اسألني حاجة من الشغل زي: «${two.join('» · «')}».`
}

// ---------------------------------------------------------------------------
// Field resolution — all money from the REAL database
// ---------------------------------------------------------------------------
interface ResolvedWrite {
  ok: boolean
  opType: OpType
  payload: Record<string, unknown>
  summary: string
  card: ActionCardDTO
  missing?: string
  failMessage?: string
  /** Multi-item drafts: lines that could NOT be drafted (stock/unit), shown to the user. */
  issues?: string[]
}

/**
 * Deterministic Egyptian-phrasing party scan for sales/purchases on the
 * rule-fallback path (no LLM): «بع لبن لأحمد», «بيع للعميل أحمد»,
 * «اشتريت من شركة الألبان». Only a preposition/role-word directly attached
 * to a name-word counts, so an item brand like «قهوة أحمد» never becomes a
 * customer — the ل/من marker is what marks the ROLE.
 */
/**
 * Remove an ITEM'S OWN NAME from a sentence before quantity/unit parsing.
 *
 * WHY (R27 accuracy fix): a catalog name routinely carries a package size —
 * «ديتول مطهر 750 مل», «شاي العروسة 250 جرام». If the quantity parser reads the
 * whole sentence, that size becomes the USER'S measurement: qty=750, unit=milli,
 * which either inflates the sale 750× or trips the unit-compatibility guard and
 * refuses a perfectly ordinary sale. The item name is identity, not measurement.
 *
 * Both sides are westernised so «٧٥٠ مل» in a message matches a «750 مل» name.
 * Tokens shorter than 4 characters are skipped — «مل»/«كيلو» alone are units,
 * never names (stripping them would eat the user's real measurement).
 */
/**
 * A human, code-free «which unit?» question.
 *
 * The old text leaked internal unit codes into the owner's chat
 * («الوحدة «box» مش متوافقة مع وحدة جبنة رومي كيلو (كيلو)») — accurate and
 * useless. Say it the way the shop says it, and give an example of the answer.
 */
function unitQuestionText(item: { name: string; unit: string }, rawUnit: string): string {
  const it = arUnit(item.unit)
  const heard = arUnit(rawUnit)
  const heardPart = heard && heard !== it ? ` سمعت «${heard}» — بس ده مش بيتقاس بيه.` : ''
  return `«${item.name}» بيتقاس بالـ${it} — قولي الكمية بالـ${it} وأنا أحسبها لك.${heardPart}`
}

/**
 * Units that NAME A COUNT rather than a measurement.
 *
 * «٢ علبة فول» for an item the catalog counts in pieces is the same request in
 * shop Arabic — a container word on a counted item is a count, not a unit
 * conflict, and refusing it («الوحدة مش متوافقة») makes the agent useless for
 * everyday speech. Measured items (كيلو/جرام/لتر) keep the strict conversion,
 * because «علبة شاي» genuinely has to be disambiguated by the user.
 */
const COUNT_UNITS = new Set(['piece', 'box', 'strip', 'capsule', 'session'])

/** Convert a quantity to the item's base unit, tolerating container wording. */
function baseQtyFor(qty: number, fromUnit: string, item: { unit: string }): number | null {
  const direct = convertToBaseUnit(qty, fromUnit, item.unit)
  if (direct != null) return direct
  if (COUNT_UNITS.has(fromUnit) && COUNT_UNITS.has(item.unit)) return qty
  return null
}

function stripItemName(text: string, item: { name: string; aliases?: string | null }): string {
  let out = toWesternDigits(text)
  const names = [item.name, ...(item.aliases ? item.aliases.split(',').map((a) => a.trim()) : [])]
  for (const n of names) {
    const norm = toWesternDigits(normalizeAr(n))
    if (norm.length < 4) continue
    if (out.includes(norm)) out = out.split(norm).join(' ')
  }
  return out
}

function findPartyMention<T extends { name: string }>(
  text: string,
  parties: T[],
  marker: 'ل' | 'من' = 'ل',
): T | null {
  const norm = normalizeAr(text)
  const hasRoleWord = marker === 'ل' ? norm.includes('عميل') || norm.includes('زبون') : norm.includes('مورد')
  for (const p of parties) {
    const words = normalizeAr(p.name)
      .split(' ')
      .flatMap((w) => (w.startsWith('ال') && w.length > 4 ? [w, w.slice(2)] : [w]))
      .filter((w) => w.length >= 2)
    for (const w of words) {
      // glued («لأحمد» / «منشركة») or spaced («من محمد») marker
      if (norm.includes(marker + w) || norm.includes(marker + ' ' + w)) return p
      // «العميل أحمد» — role word anywhere in the message + the name standalone
      if (w.length >= 3 && hasRoleWord && norm.includes(' ' + w + ' ')) return p
    }
  }
  return null
}

function fieldsToCard(ref: string, type: OpType, risk: Risk, summary: string, fields: { label: string; value: string; hint?: string }[], effects: { label: string; value: string; tone?: 'good' | 'bad' | 'neutral' }[], dangerNote?: string): ActionCardDTO {
  return {
    kind: 'draft',
    ref,
    type,
    risk,
    title: TYPE_AR[type] ?? type,
    summary,
    fields,
    effects,
    status: 'AWAITING_APPROVAL',
    dangerNote,
  }
}

/** عطارة «البيع بالمبلغ»: «بـ20 جنيه فلفل أسود» → (amount, in EGP) or null.
 * Runs on WESTERN-digit normalized text (normalizeAr already ate the ـ tatweel
 * in «بـ20»). Requires a real money word (جنيه/ج) after the number so a bare
 * quantity («بعت 20 فلفل») can never fire it. */
/**
 * «ضيف أحمد كمان من اللي عليهم فلوس وعليه ٢٥٠ من أيام كذا» → the party and the
 * opening balance. Deterministic because this is the ONE sentence an owner uses
 * to grow the ledger, and a wrong name/amount here corrupts real accounting.
 * Runs on normalizeAr'd text (Arabic-Indic digits already folded to western).
 */
function parsePartyAdd(rawNorm: string): { name: string; balance?: number; phone?: string; plan?: string; months?: number; since?: string; kind: 'customer' | 'supplier' } | null {
  const norm = toWesternDigits(rawNorm)
  const m = norm.match(/(?:^|\s)(?:ضيف|اضف|اضيف|ضف|سجل)\s+(?:لي\s+|ليا\s+)?(?:عميل(?:ه)?\s+|مورد\s+|موردين\s+|عضو\s+|زبون\s+)?(.+)$/)
  if (!m) return null
  const tail = m[1]
  const STOP = /\s+(?:كمان|كمان\s+عشان|من\s+اللي|من\s+الذين|وعليه|وعليها|عليه|عليها|وبيدفع|وبيتعامل|لحد|عشان)\s+/
  let name = tail.split(STOP)[0]
  name = name.replace(/[،,؟?].*$/, '').replace(/\s+/g, ' ').trim()
  const mb = norm.match(/(?:وعليه|وعليها|عليه|عليها|مديونيته|رصيده|الرصيد|بمديونيه)\s*(?:بـ|ب)?\s*([0-9]+(?:[.,][0-9]+)?)/)
  const mM = norm.match(/([0-9]{2,})\s*(?:جنيه|ج\b)/)
  const raw = mb?.[1] ?? mM?.[1] ?? null
  const balance = raw != null ? Number(raw.replace(',', '.')) : undefined
  const phone = norm.match(/(01[0-9]{9})/)?.[1]
  const plan = norm.match(/(?:اشتراك|باقه|خطه)\s+([^\s،,؟?]{2,20})/)?.[1]
  const months = Number(norm.match(/([0-9]{1,2})\s*(?:شهر|شهور)/)?.[1] ?? 0) || undefined
  if (name.length < 2 || name.length > 40) return null
  // «وعليه ٤٥٠ من أيام ١٠ أكتوبر» — the debt is OLD; the date must survive the
  // draft, not silently become today (request-3 acceptance test).
  const since = parseSinceClause(norm)
  return {
    name,
    balance,
    ...(phone ? { phone } : {}),
    ...(plan ? { plan } : {}),
    ...(months ? { months } : {}),
    ...(since ? { since: since.toISOString() } : {}),
    kind: /مورد/.test(norm) ? 'supplier' : 'customer',
  }
}

function matchReverseSellAmount(normWestern: string): number | null {
  const m = normWestern.match(/(?:^|\s)(?:بال|بمبلغ|ب)([0-9]+(?:[.,][0-9]+)?)\s*(?:جنيه|جنيهات|ج)(?=\s|$)/)
  if (!m) return null
  const amount = parseFloat(m[1].replace(',', '.'))
  return Number.isFinite(amount) && amount > 0 ? amount : null
}

/** Remove the «بـN جنيه» clause so the money number can never masquerade as a
 * weight in ANY quantity parser downstream (segment scan / parseQuantity). */
function stripReverseSellAmount(normWestern: string): string {
  return normWestern.replace(/(?:^|\s)(?:بال|بمبلغ|ب)[0-9]+(?:[.,][0-9]+)?\s*(?:جنيه|جنيهات|ج)(?=\s|$)/g, ' ')
}

/** Paid amount: LLM field → explicit «دفع 20» clause → آجل = 0 → default cash (total). */
function resolvePaid(norm: string, f: Record<string, unknown>, total: number): number {
  if (typeof f.paid === 'number' && f.paid > 0) return Math.min(Math.round(f.paid * 100), total)
  const paidWord = norm.match(/(?:دفع|دفعت|خلاص|ادفع)\s*(?:الي\s*)?([٠-٩0-9.,]+|\S+)?/)
  if (paidWord?.[1]) {
    const n = parseQuantity(paidWord[1], null).qty
    if (n != null && n > 0) return Math.min(Math.round(n * 100), total)
  }
  if (/(?:بال)?اجل|علي الحساب|نسيون/.test(norm)) return 0
  return total
}

async function resolveWrite(ctx: TurnContext, intent: ExtractedIntent, emit: TurnEmit, memCtx: MemoryContext): Promise<ResolvedWrite> {
  const { business, user } = ctx
  const type = (intent.opType ?? 'sale') as OpType
  const f = intent.fields ?? {}
  const items: Item[] = await db.item.findMany({ where: { businessId: business.id } })
  const customers: Customer[] = await db.customer.findMany({ where: { businessId: business.id } })
  const suppliers: Supplier[] = await db.supplier.findMany({ where: { businessId: business.id } })

  const text = ctx.text
  const norm = normalizeAr(text)
  const normW = toWesternDigits(norm)

  switch (type) {
    case 'sale':
    case 'purchase': {
      // Paid clauses are stripped BEFORE quantity parsing so a payment like
      // «دفع ٢٠ بس» can never be misread as the sold quantity.
      const textNoPaid = norm.replace(/(?:دفع|دفعت|خلاص|ادفع)\s*(?:الي\s*)?[٠-٩0-9][٠-٩0-9.,]*\s*(?:بس|فقط|تمام)?/g, ' ')
      // ---- عطارة reverse-selling («بعت بـ20 جنيه فلفل») ----
      // The money clause MUST be detected and stripped BEFORE any quantity
      // parsing: a bare «20» in «بـ20 جنيه» is the AMOUNT, not a weight. The
      // deterministic scanners and the LLM both tend to read it as qty=20 —
      // the pattern match on «بـN جنيه» is the ground truth.
      const reverseAmountEgp = business.type === 'attar' && type === 'sale' ? matchReverseSellAmount(normW) : null
      const scanText = reverseAmountEgp != null ? stripReverseSellAmount(toWesternDigits(textNoPaid)) : textNoPaid
      // ---- Multi-item scan (deterministic — works with or without the LLM) ----
      // «سجّل بيع ٢ لبن و ١٠ بيض» → segments → per-item quantity. When TWO or
      // more distinct catalog items are mentioned we draft ONE multi-line
      // operation (a single basket the cashier approves once), like the real POS.
      // Longest-alias-first + overlap rejection: «بانادول» alone can never fan
      // out into «بانادول أكتيف» + «بانادول شرائط» — the more specific name wins.
      const segments = scanText.split(/\s*(?:،|,|\+|؛|;)\s*|\s+و\s+|\s+و(?=[٠-٩0-9])/).filter(Boolean)
      const byItem = new Map<string, { item: Item; qty: number | null; unit: string | null }>()
      for (const seg of segments) {
        const segNorm = normalizeAr(seg)
        const hits: { item: Item; token: string; at: number }[] = []
        for (const it of items) {
          // canonical names + column aliases + LEXICON dialect aliases (boost)
          const lexAl = memCtx.lexicon.filter((l) => l.entityRef === it.id).map((l) => l.alias)
          const names = [it.name, ...(it.aliases ? it.aliases.split(',').map((a) => a.trim()) : []), ...lexAl]
          let best: { token: string; at: number } | null = null
          for (const n of names) {
            const nn = normalizeAr(n)
            if (nn.length >= 3) {
              // WORD-BOUNDED: «شوكولاتة» contains the letters of «كولا», so a raw
              // indexOf scanned a chocolate sentence as a Coca-Cola sale (live R29)
              const at = wordBoundedAt(segNorm, nn)
              if (at >= 0 && (!best || nn.length > best.token.length)) best = { token: nn, at }
            }
          }
          if (best) hits.push({ item: it, ...best })
        }
        hits.sort((a, b) => b.token.length - a.token.length)
        const taken: Array<[number, number]> = []
        for (const h of hits) {
          if (taken.some(([s, e]) => h.at < e && h.at + h.token.length > s)) continue
          taken.push([h.at, h.at + h.token.length])
          // the matched name is stripped first: «٢ لبن كرتونة جهينة ١ لتر» must
          // not read the «١ لتر» package size as the requested unit/qty
          const q = parseQuantity(stripItemName(seg, h.item), null)
          const prev = byItem.get(h.item.id)
          byItem.set(h.item.id, {
            item: h.item,
            qty: q.qty != null && q.qty > 0 ? (prev?.qty ?? 0) + q.qty : prev?.qty ?? null,
            unit: prev?.unit ?? unitToCode(q.unit) ?? null,
          })
        }
      }
      const multi = byItem.size >= 2

      if (multi) {
        // ---- Multi-line draft: one basket, real prices per line ----
        const lines: { item: Item; qty: number; unitPrice: number; total: number }[] = []
        const issues: string[] = []
        for (const { item, qty, unit } of byItem.values()) {
          const rawUnit = unit ?? item.unit // default = the item's own canonical unit
          const baseQty = baseQtyFor(qty ?? 1, rawUnit, item)
          if (baseQty == null || !(baseQty > 0)) {
            issues.push(unitQuestionText(item, rawUnit))
            continue
          }
          const qtyN = Math.round(baseQty * 1000) / 1000
          // R27: a sale bigger than the recorded shelf is DRAFTED, not refused —
          // the shelf count is usually stale and the owner must still be able to
          // record what actually happened. «تأمل وكيل» already flags it as an
          // oversell finding (and escalates to R3 when there is nothing on the
          // shelf at all), so the doubt reaches the human instead of the bin.
          const unitPrice = type === 'sale' ? item.sellPrice : item.costPrice
          lines.push({ item, qty: qtyN, unitPrice, total: Math.round(qtyN * unitPrice) })
        }
        if (lines.length === 0) {
          return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'الكمية', failMessage: issues.join('؛ ') || 'الكمية قد إيه لكل صنف؟', issues }
        }
        const total = lines.reduce((s, l) => s + l.total, 0)
        // Paid (clamped to the basket total; آجل = 0)
        const paid = resolvePaid(norm, f, total)
        // Party (lexicon first, then LLM field, then deterministic phrasing)
        const lexCustomer = type === 'sale' ? lexiconResolve(norm, memCtx.lexicon, customers)?.entity : null
        if (lexCustomer) memCtx.referencedIds.push(...memCtx.lexicon.filter((l) => l.entityRef === lexCustomer.id).map((l) => l.id))
        const customer = lexCustomer ?? (f.customerName ? matchEntity(String(f.customerName), customers)?.entity : null) ?? (type === 'sale' ? findPartyMention(text, customers) : null)
        const supplier = (f.supplierName ? matchEntity(String(f.supplierName), suppliers)?.entity : null) ?? (type === 'purchase' ? findPartyMention(text, suppliers, 'من') : null)

        const payload: Record<string, unknown> = {
          lines: lines.map((l) => ({ itemId: l.item.id, name: l.item.name, qty: l.qty, unit: l.item.unit, unitPrice: l.unitPrice, total: l.total })),
          total,
          paid,
          ...(type === 'sale' && customer ? { customerId: customer.id, customerName: customer.name } : {}),
          ...(type === 'purchase' && supplier ? { supplierId: supplier.id, supplierName: supplier.name } : {}),
        }
        const ref = `WKL-DRAFT` // replaced by real ref from createDraft
        const risk = computeRisk(type, total)
        const summary = `${type === 'sale' ? 'بيع' : 'شرا'} ${lines.map((l) => `${fmtQty(l.qty, arUnit(l.item.unit))} ${l.item.name}`).join(' + ')} بـ${egp(total)}${type === 'sale' && customer ? ` — ${customer.name}` : ''}${type === 'purchase' && supplier ? ` — من ${supplier.name}` : ''}`
        // BUSINESS_DNA credit-limit enforcement (آجل on a capped party)
        let dangerNote: string | undefined
        let creditField: { label: string; value: string; hint?: string } | undefined
        if (type === 'sale' && customer && total - paid > 0 && memCtx.rules.length > 0) {
          const check = creditLimitFor(memCtx.rules, customer, customer.balance + (total - paid))
          if (check) {
            dangerNote = check.warning
            creditField = { label: '⚠️ قانون المحل', value: `هيوصل رصيد ${customer.name} لـ${egp(check.projectedPiastres)} — القانون: ${egp(check.limitPiastres)}` }
            memCtx.referencedIds.push(check.rule.id)
          }
        }
        const card = fieldsToCard(ref, type, risk, summary, [
          ...lines.map((l) => ({ label: l.item.name, value: `${fmtQty(l.qty, arUnit(l.item.unit))} × ${egp(l.unitPrice)} = ${egp(l.total)}` })),
          { label: 'الإجمالي', value: egp(total) },
          { label: 'مدفوع', value: egp(paid) },
          ...(total - paid > 0 ? [{ label: 'باقي (آجل)', value: egp(total - paid) }] : []),
          ...(type === 'sale' && customer ? [{ label: 'العميل', value: customer.name }] : []),
          ...(type === 'purchase' && supplier ? [{ label: 'المورد', value: supplier.name }] : []),
          ...(creditField ? [creditField] : []),
          ...issues.map((i) => ({ label: '⚠ مش ضمن المسودة', value: i })),
        ], [
          ...lines.map((l) => ({ label: `مخزون ${l.item.name}`, value: `${fmtQty(l.item.stockQty, arUnit(l.item.unit))} ← ${fmtQty(l.item.stockQty + (type === 'sale' ? -l.qty : l.qty), arUnit(l.item.unit))}`, tone: 'neutral' as const })),
          { label: 'الخزنة', value: egp(type === 'sale' ? paid : -paid), tone: type === 'sale' ? 'good' as const : 'bad' as const },
        ], dangerNote ?? RISK_META[risk].hint)
        return { ok: true, opType: type, payload, summary, card, issues: issues.length > 0 ? issues : undefined }
      }

      // ---- Single-item draft (original path) ----
      // Item: lexicon (dialect alias) → LLM field → text mention → fuzzy whole-text match
      const rawItemName = String(f.itemName ?? '')
      const mentioned = byItem.size === 1 ? [...byItem.values()][0] : null
      const lexHit = lexiconResolve(norm, memCtx.lexicon, items)
      const item = lexHit?.entity ?? (rawItemName ? matchEntity(rawItemName, items)?.entity : null) ?? mentioned?.item ?? matchEntity(text, items)?.entity ?? null
      if (lexHit) {
        memCtx.referencedIds.push(lexHit.entry.id)
      } else if (item) {
        // LEXICON learning: a dialect token that overlaps the canonical name
        const alias = learnableAlias(text, item, {
          others: items
            .filter((i) => i.id !== item.id)
            .flatMap((i) => [i.name, ...(i.aliases ? i.aliases.split(',').map((a) => a.trim()) : [])]),
          partyNames: [...customers.map((c) => c.name), ...suppliers.map((s) => s.name)],
        })
        if (alias) await saveLexiconMemory({ businessId: business.id, userId: user.id }, alias, item)
      }
      if (!item) {
        return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'الصنف', failMessage: `مش لاقي الصنف — ممكن تكتبه بالاسم اللي في الكتالوج؟` }
      }

      // ---- عطارة reverse selling: «بعت بـ20 جنيه فلفل أسود» → وزن بالجرام ----
      if (reverseAmountEgp != null) {
        // scanText already has the money clause stripped, so ANY number still
        // left in it is a real weight («بعت 100 جرام كركديه بـ20 جنيه» → qty wins)
        const qtyAfterStrip = parseQuantity(stripItemName(scanText, item), null).qty
        const digitsAfterStrip = /[0-9]/.test(scanText)
        // The LLM tends to echo the money as qty — only a qty that ALSO has a
        // real number left in the stripped text (or a word-number like نص) counts
        const llmQtyIsReal =
          typeof f.qty === 'number' && f.qty > 0 && f.qty !== reverseAmountEgp && (digitsAfterStrip || (f.unit && unitToCode(String(f.unit)) != null))
        const noExplicitQty = qtyAfterStrip == null && mentioned?.qty == null && !llmQtyIsReal
        if (noExplicitQty) {
          if (item.unit !== 'gram' && item.unit !== 'kg') {
            return { ok: false, opType: type, payload: {}, summary: '', card: null as never, failMessage: `«${item.name}» بيتاع بـ${arUnit(item.unit)} مش بالوزن — قولي الكمية بالوحدة بتاعته وأنا أحسبها لك` }
          }
          const amountEgp = reverseAmountEgp
          const perGram = item.unit === 'gram' ? item.sellPrice : Math.round(item.sellPrice / 1000) // kg → per gram
          const amountPiastres = Math.round(amountEgp * 100)
          if (perGram > 0 && amountPiastres > 0) {
            const grams = Math.round(amountPiastres / perGram)
            if (grams < 1) {
              return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'المبلغ', failMessage: `${egp(amountPiastres)} أقل من سعر الجرام (${egp(perGram)}) — الزبون ده عايز ياخد حاجة تانية؟` }
            }
            if (grams > item.stockQty) {
              return { ok: false, opType: type, payload: {}, summary: '', card: null as never, failMessage: `المتاح من ${item.name} ${fmtQty(item.stockQty, arUnit(item.unit))} بس — ${egp(amountPiastres)} يعني ${fmtQty(grams, 'جرام')}` }
            }
            // revenue = the money the customer asked to buy with (integer piastres)
            const total = amountPiastres
            const paid = resolvePaid(norm, f, total)
            const customer = (f.customerName ? matchEntity(String(f.customerName), customers)?.entity : null) ?? findPartyMention(text, customers)
            const payload: Record<string, unknown> = {
              itemId: item.id,
              itemName: item.name,
              qty: grams,
              unit: 'gram',
              unitPrice: perGram,
              total,
              paid,
              reverseSell: true,
              requestedAmount: amountPiastres,
              ...(customer ? { customerId: customer.id, customerName: customer.name } : {}),
            }
            const risk = computeRisk(type, total)
            const summary = `بيع بالوزن: ${fmtQty(grams, 'جرام')} ${item.name} بمبلغ ${egp(total)}${customer ? ` — ${customer.name}` : ''}`
            let dangerNote: string | undefined
            let creditField: { label: string; value: string; hint?: string } | undefined
            if (customer && total - paid > 0 && memCtx.rules.length > 0) {
              const check = creditLimitFor(memCtx.rules, customer, customer.balance + (total - paid))
              if (check) {
                dangerNote = check.warning
                creditField = { label: '⚠️ قانون المحل', value: `هيوصل رصيد ${customer.name} لـ${egp(check.projectedPiastres)} — القانون: ${egp(check.limitPiastres)}` }
                memCtx.referencedIds.push(check.rule.id)
              }
            }
            const card = fieldsToCard('', type, risk, summary, [
              { label: 'الصنف', value: item.name },
              { label: 'الوزن المحسوب', value: fmtQty(grams, 'جرام'), hint: `⚖️ اوزن ${fmtQty(grams, 'جرام')} للزبون` },
              { label: 'سعر الجرام', value: egp(perGram) },
              { label: 'المبلغ (بيع بـ)', value: egp(total) },
              { label: 'مدفوع', value: egp(paid) },
              ...(total - paid > 0 ? [{ label: 'باقي (آجل)', value: egp(total - paid) }] : []),
              ...(customer ? [{ label: 'العميل', value: customer.name }] : []),
              ...(creditField ? [creditField] : []),
            ], [
              { label: `مخزون ${item.name}`, value: `${fmtQty(item.stockQty, arUnit(item.unit))} ← ${fmtQty(item.stockQty - grams, arUnit(item.unit))}`, tone: 'neutral' },
              { label: 'الخزنة', value: egp(paid), tone: 'good' },
            ], dangerNote ?? RISK_META[risk].hint)
            return { ok: true, opType: type, payload, summary, card }
          }
        }
      }

      // Quantity: LLM → mention → text (paid clause already stripped) → default 1
      // («بع لبن» = one unit of the item's own canonical kind — the cashier's shorthand)
      // (when a reverse-sell amount was detected but a real qty survived the
      // strip, the normal path runs — the explicit weight is the ground truth)
      // the item's own name is stripped from the scan text (see stripItemName)
      const textQ = parseQuantity(stripItemName(reverseAmountEgp != null ? scanText : textNoPaid, item), null)
      const llmQty = typeof f.qty === 'number' && f.qty > 0 ? f.qty : null
      // reverse-sell candidate: an LLM qty equal to the money is the echo — drop it
      const qtySource = reverseAmountEgp != null && llmQty === reverseAmountEgp ? null : llmQty
      const qty = qtySource ?? mentioned?.qty ?? textQ.qty ?? 1
      if (qty <= 0) return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'الكمية', failMessage: 'الكمية قد إيه بالظبط؟' }
      // Unit: LLM → mention → text word → the item's OWN canonical unit (الافتراضي)
      const rawUnit = unitToCode(f.unit as string) ?? mentioned?.unit ?? unitToCode(textQ.unit) ?? item.unit
      const baseQty = baseQtyFor(qty, rawUnit, item)
      if (baseQty == null || !(baseQty > 0)) {
        return {
          ok: false,
          opType: type,
          payload: {},
          summary: '',
          card: null as never,
          missing: 'الوحدة',
          failMessage: unitQuestionText(item, rawUnit),
        }
      }
      const qtyN = Math.round(baseQty * 1000) / 1000
      // R27: overselling the recorded shelf no longer aborts the draft. See the
      // multi-line path above — «تأمل وكيل» carries the finding (and the R3
      // escalation when the shelf is empty), so a stale count can be corrected
      // by recording reality instead of by refusing the sale.
      // Total from REAL price
      const unitPrice = type === 'sale' ? item.sellPrice : item.costPrice
      let total = Math.round(qtyN * unitPrice)
      // R17 «العقل الحقيقي»: the user HIMSELF stated what he sold it for
      // («بعت آجل لمحمود كرتونة لبن بـ٩٠») — the brain extracts it as
      // fields.amount (EGP). His stated price wins over the catalog default
      // for a single-line sale (a real cashier knows his own price); the
      // catalog stays the fallback when he didn't say one.
      const statedEgp =
        typeof f.amount === 'number' && f.amount > 0 ? f.amount : typeof f.amount === 'string' && Number(f.amount) > 0 ? Number(f.amount) : null
      let priceOverride = false
      if (type === 'sale' && statedEgp != null) {
        const statedPiastres = Math.round(statedEgp * 100)
        if (statedPiastres > 0) {
          total = statedPiastres
          priceOverride = true
        }
      }
      // Paid (آجل = 0, explicit clause wins, default = full cash)
      const paid = resolvePaid(norm, f, total)
      // Party: lexicon → LLM field → deterministic Egyptian-phrasing scan («لأحمد», «العميل أحمد», «من المورد»)
      const customerName = String(f.customerName ?? '')
      const lexCustomer = type === 'sale' ? lexiconResolve(norm, memCtx.lexicon, customers)?.entity : null
      if (lexCustomer) memCtx.referencedIds.push(...memCtx.lexicon.filter((l) => l.entityRef === lexCustomer.id).map((l) => l.id))
      const customer = lexCustomer ?? (customerName ? matchEntity(customerName, customers)?.entity : null) ?? (type === 'sale' ? findPartyMention(text, customers) : null)
      const supplierName = String(f.supplierName ?? '')
      const supplier = (supplierName ? matchEntity(supplierName, suppliers)?.entity : null) ?? (type === 'purchase' ? findPartyMention(text, suppliers, 'من') : null)

      const payload: Record<string, unknown> = {
        itemId: item.id,
        itemName: item.name,
        qty: qtyN,
        unit: item.unit,
        unitPrice: priceOverride && qtyN > 0 ? Math.round(total / qtyN) : unitPrice,
        total,
        paid,
        ...(priceOverride ? { priceOverride: true } : {}),
        ...(type === 'sale' && customer ? { customerId: customer.id, customerName: customer.name } : {}),
        ...(type === 'purchase' && supplier ? { supplierId: supplier.id, supplierName: supplier.name } : {}),
      }
      const ref = `WKL-DRAFT` // replaced by real ref from createDraft
      const risk = computeRisk(type, total)
      const summary = `${type === 'sale' ? 'بيع' : 'شرا'} ${fmtQty(qtyN, arUnit(item.unit))} ${item.name} بـ${egp(total)}${type === 'sale' && customer ? ` — ${customer.name}` : ''}${type === 'purchase' && supplier ? ` — من ${supplier.name}` : ''}`
      // BUSINESS_DNA credit-limit enforcement (آجل on a capped party)
      let dangerNote: string | undefined
      let creditField: { label: string; value: string; hint?: string } | undefined
      if (type === 'sale' && customer && total - paid > 0 && memCtx.rules.length > 0) {
        const check = creditLimitFor(memCtx.rules, customer, customer.balance + (total - paid))
        if (check) {
          dangerNote = check.warning
          creditField = { label: '⚠️ قانون المحل', value: `هيوصل رصيد ${customer.name} لـ${egp(check.projectedPiastres)} — القانون: ${egp(check.limitPiastres)}` }
          memCtx.referencedIds.push(check.rule.id)
        }
      }
      const card = fieldsToCard(ref, type, risk, summary, [
        { label: 'الصنف', value: item.name },
        { label: 'الكمية', value: fmtQty(qtyN, arUnit(item.unit)) },
        { label: `سعر ${type === 'sale' ? 'البيع' : 'الشرا'} (للوحدة)`, value: egp(priceOverride && qtyN > 0 ? Math.round(total / qtyN) : unitPrice), ...(priceOverride ? { hint: 'السعر اللي قلته — بيتقدم على الكتالوج' } : {}) },
        { label: 'الإجمالي', value: egp(total) },
        { label: 'مدفوع', value: egp(paid) },
        ...(total - paid > 0 ? [{ label: 'باقي (آجل)', value: egp(total - paid) }] : []),
        ...(type === 'sale' && customer ? [{ label: 'العميل', value: customer.name }] : []),
        ...(type === 'purchase' && supplier ? [{ label: 'المورد', value: supplier.name }] : []),
        ...(creditField ? [creditField] : []),
      ], [
        { label: `مخزون ${item.name}`, value: `${fmtQty(item.stockQty, arUnit(item.unit))} ← ${fmtQty(item.stockQty + (type === 'sale' ? -qtyN : qtyN), arUnit(item.unit))}`, tone: 'neutral' },
        { label: 'الخزنة', value: egp(type === 'sale' ? paid : -paid), tone: type === 'sale' ? 'good' : 'bad' },
      ], dangerNote ?? RISK_META[risk].hint)
      return { ok: true, opType: type, payload, summary, card }
    }

    case 'expense': {
      const amountRaw = f.amount as number | undefined
      let amount = amountRaw && amountRaw > 0 ? Math.round(amountRaw * 100) : null
      if (amount == null) {
        const m = norm.match(/([٠-٩0-9]+(?:[.,][٠-٩0-9]+)?)/)
        if (m) {
          const western = m[1].replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(',', '.')
          const parsed = parseFloat(western)
          if (!Number.isNaN(parsed)) amount = Math.round(parsed * 100)
        }
      }
      if (amount == null || amount <= 0) return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'المبلغ', failMessage: 'المبلغ قد إيه؟' }
      const label = String(f.label ?? '') || (norm.includes('كهربا') ? 'كهربا' : norm.includes('ايجار') ? 'إيجار' : norm.includes('تليفون') ? 'تليفون' : 'مصروف')
      const payload = { label, total: amount }
      const risk = computeRisk(type, amount)
      const summary = `مصروف ${label} بـ${egp(amount)}`
      const card = fieldsToCard('', type, risk, summary, [
        { label: 'البند', value: label },
        { label: 'المبلغ', value: egp(amount) },
      ], [{ label: 'الخزنة', value: egp(-amount), tone: 'bad' }], RISK_META[risk].hint)
      return { ok: true, opType: type, payload, summary, card }
    }

    case 'collection': {
      const customersAll = customers.length > 0 ? customers : []
      const customerName = String(f.customerName ?? '')
      const lexCustomer = lexiconResolve(norm, memCtx.lexicon, customersAll)?.entity ?? null
      if (lexCustomer) memCtx.referencedIds.push(...memCtx.lexicon.filter((l) => l.entityRef === lexCustomer.id).map((l) => l.id))
      const customer = lexCustomer ?? matchEntity(customerName || text, customersAll)?.entity ?? null
      if (!customer) return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'العميل', failMessage: 'تحصيل من مين بالظبط؟' }
      let amount = (f.amount as number | undefined) && (f.amount as number) > 0 ? Math.round((f.amount as number) * 100) : null
      if (amount == null) {
        const m = norm.match(/([٠-٩0-9]+(?:[.,][٠-٩0-9]+)?)/)
        if (m) {
          const western = m[1].replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
          amount = Math.round(parseFloat(western.replace(',', '.')) * 100)
        }
      }
      if (amount == null || amount <= 0) return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'المبلغ', failMessage: `هتحصّل قد إيه من ${customer.name}؟` }
      // «الدقة قبل الاعتذار»: the owner asked to collect more than the debt.
      // Refusing outright (the R29 behaviour) meant NO draft and a chat-style
      // «قولّي تحب نعمل إيه» — useless. We NEVER invent a debt, so the draft is
      // for the real outstanding balance, and the difference is stated loudly
      // (the excess is usually a deposit / the debt was already settled).
      const requested = amount
      let overNote = ''
      if (requested > customer.balance) {
        amount = customer.balance
        overNote = `${customer.name} عليه ${egp(amount)} بس — قللت المبلغ للمستحق الفعلي`
      }
      const payload = { customerId: customer.id, customerName: customer.name, amount, ...(overNote ? { requestedAmount: requested } : {}) }
      const risk = computeRisk(type, amount)
      const summary = `تحصيل ${egp(amount)} من ${customer.name}`
      const card = fieldsToCard('', type, risk, summary, [
        { label: 'العميل', value: customer.name },
        { label: 'المبلغ', value: egp(amount) },
        { label: 'المديونية الحالية', value: egp(customer.balance) },
        { label: 'بعد التحصيل', value: egp(customer.balance - amount) },
        ...(overNote ? [{ label: 'خد بالك', value: `طلبك كان ${egp(requested)} — ${overNote}`, hint: 'لو الزيادة عربون أو مقدم قولّي وأسجلها' }] : []),
      ], [{ label: 'الخزنة', value: egp(amount), tone: 'good' }], RISK_META[risk].hint)
      return { ok: true, opType: type, payload, summary, card, ...(overNote ? { issues: [overNote] } : {}) }
    }

    case 'payment': {
      const supplierName = String(f.supplierName ?? '')
      const supplier = matchEntity(supplierName || text, suppliers)?.entity ?? null
      if (!supplier) return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'المورد', failMessage: 'هسدد لمين؟' }
      let amount = (f.amount as number | undefined) && (f.amount as number) > 0 ? Math.round((f.amount as number) * 100) : null
      if (amount == null) {
        const m = norm.match(/([٠-٩0-9]+(?:[.,][٠-٩0-9]+)?)/)
        if (m) {
          const western = m[1].replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
          amount = Math.round(parseFloat(western.replace(',', '.')) * 100)
        }
      }
      if (amount == null || amount <= 0) return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'المبلغ', failMessage: `هسدد قد إيه لـ${supplier.name}؟` }
      if (amount > supplier.balance) {
        return { ok: false, opType: type, payload: {}, summary: '', card: null as never, failMessage: `المستحق لـ${supplier.name} ${egp(supplier.balance)} بس` }
      }
      const payload = { supplierId: supplier.id, supplierName: supplier.name, amount }
      const risk = computeRisk(type, amount)
      const summary = `سداد ${egp(amount)} لـ${supplier.name}`
      const card = fieldsToCard('', type, risk, summary, [
        { label: 'المورد', value: supplier.name },
        { label: 'المبلغ', value: egp(amount) },
        { label: 'المستفق الحالي', value: egp(supplier.balance) },
        { label: 'بعد السداد', value: egp(supplier.balance - amount) },
      ], [{ label: 'الخزنة', value: egp(-amount), tone: 'bad' }], RISK_META[risk].hint)
      return { ok: true, opType: type, payload, summary, card }
    }

    case 'membership': {
      const isRenewal = norm.includes('تجديد') || norm.includes('جدد')
      const explicitName = String(f.customerName ?? '').trim()
      const customer = explicitName ? matchEntity(explicitName, customers)?.entity ?? null : matchEntity(text, customers)?.entity ?? null
      // A name WAS typed but it is not in the member list. Saying «لمين؟» again
      // makes the owner think the agent ignored him — name the missing person
      // and offer the fix. («اشتركت سارة …» when سارة is not registered.)
      const hintedName = text.match(/(?:اشتركت|جددت|جدد|اشتراك|لـ|ل)\s+([^\s،,؟?0-9]{2,20})/)?.[1]
      if (!customer && !explicitName && hintedName && normalizeAr(hintedName).length >= 2) {
        return {
          ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'العضو',
          failMessage: `مفيش عضو مسجّل باسم «${hintedName}» — اتأكد من الاسم أو ضيفه من شاشة الأعضاء`,
        }
      }
      if (!customer && isRenewal) return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'العضو', failMessage: 'تجديد لمين؟' }
      // A NEW subscription with NO name at all (rule path, question-like text)
      // must never draft «عضو جديد» — ask for the name first.
      if (!customer && !explicitName) return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'العضو', failMessage: 'اشتراك جديد لمين؟ اكتبلي اسم العضو' }
      const plan = String(f.plan ?? 'شهرية')
      const months = Math.max(1, Math.min(12, Math.round(Number(f.months ?? 1))))
      // plan price from items (gym plans are items) or fallback 35000
      const planItem = items.find((i) => normalizeAr(i.name).includes(normalizeAr(plan)))
      const total = Math.round((planItem?.sellPrice ?? 35000) * months)
      let paid = total
      if (typeof f.paid === 'number' && f.paid > 0) paid = Math.round(f.paid * 100)
      paid = Math.min(paid, total)
      const name = customer?.name ?? explicitName
      const payload = {
        ...(customer ? { customerId: customer.id } : { customerName: name }),
        plan,
        months,
        total,
        paid,
      }
      const risk = computeRisk(type, total)
      const summary = `${isRenewal ? 'تجديد' : 'اشتراك جديد'} ${plan} لـ${name} — ${egp(total)}`
      const card = fieldsToCard('', type, risk, summary, [
        { label: 'العضو', value: name },
        { label: 'الخطة', value: plan },
        { label: 'المدة', value: fmtQty(months, 'شهر') },
        { label: 'الإجمالي', value: egp(total) },
        { label: 'مدفوع', value: egp(paid) },
      ], [
        { label: 'الخزنة', value: egp(paid), tone: 'good' },
        ...(total - paid > 0 ? [{ label: 'باقي على العضو', value: egp(total - paid), tone: 'bad' as const }] : []),
      ], RISK_META[risk].hint)
      return { ok: true, opType: type, payload, summary, card }
    }

    case 'attendance': {
      const customerName = String(f.customerName ?? '')
      const customer = matchEntity(customerName || text, customers)?.entity ?? null
      if (!customer) return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'العضو', failMessage: 'حضور مين؟' }
      const payload = { customerId: customer.id, customerName: customer.name }
      const risk = computeRisk(type)
      const summary = `حضور ${customer.name}`
      const card = fieldsToCard('', type, risk, summary, [
        { label: 'العضو', value: customer.name },
        { label: 'اليوم', value: 'النهاردة' },
        ...(customer.expiresAt ? [{ label: 'الاشتراك لحد', value: arDate(customer.expiresAt) }] : []),
      ], [], RISK_META[risk].hint)
      return { ok: true, opType: type, payload, summary, card }
    }

    case 'stock_adjustment': {
      const rawItemName = String(f.itemName ?? '')
      const item = matchEntity(rawItemName || text, items)?.entity ?? null
      if (!item) return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'الصنف', failMessage: 'تسوية مخزون لأنهي صنف؟' }
      let delta = (f.delta as number | undefined) ?? null
      if (delta == null && typeof f.qty === 'number') delta = f.qty - item.stockQty
      if (delta == null) return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'الكمية الجديدة/الفرق', failMessage: `المخزون الحالي ${fmtQty(item.stockQty, arUnit(item.unit))} — عايزه يبقى قد إيه؟` }
      const reason = String(f.reason ?? '') || 'تسوية جرد'
      const payload = { itemId: item.id, itemName: item.name, delta, reason, unit: item.unit }
      const risk = computeRisk(type)
      const summary = `تسوية مخزون ${item.name}: ${fmtQty(item.stockQty, arUnit(item.unit))} ← ${fmtQty(item.stockQty + delta, arUnit(item.unit))}`
      const card = fieldsToCard('', type, risk, summary, [
        { label: 'الصنف', value: item.name },
        { label: 'الحالي', value: fmtQty(item.stockQty, arUnit(item.unit)) },
        { label: 'الجديد', value: fmtQty(item.stockQty + delta, arUnit(item.unit)) },
        { label: 'السبب', value: reason },
      ], [{ label: `مخزون ${item.name}`, value: `${fmtQty(item.stockQty, arUnit(item.unit))} ← ${fmtQty(item.stockQty + delta, arUnit(item.unit))}`, tone: delta >= 0 ? 'good' : 'bad' }], 'تسوية المخزون عملية حساسة (R3) — محتاجة سبب واعتماد')
      return { ok: true, opType: type, payload, summary, card }
    }

    // ---- R29: the owner GROWS the ledger by talking («ضيف أحمد كمان») ----
    case 'customer_add':
    case 'supplier_add': {
      const isCustomer = type === 'customer_add'
      const partyAr = isCustomer ? 'عميل' : 'مورد'
      const explicit = String(f.name ?? f.customerName ?? f.supplierName ?? '').trim()
      const scanned = parsePartyAdd(norm)
      // A model field that is really a SENTENCE is not a name: «ضيف مصطفى الجزار
      // من اللي عليهم فلوس وعليه ٤٥٠ …» came back with name = «اللي عليهم فلوس
      // وعليه ٤٥٠ من أيام ١٠ أكتوبر» (live R29 acceptance run) and would have
      // created a party with that name. The deterministic phrase parser knows the
      // grammar, so it wins whenever the explicit field looks sentence-shaped.
      const looksLikeSentence = (x: string) =>
        /[0-9]/.test(x) ||
        /(وعليه|وعليها|عليه|عليها|علينا|مديونيت|رصيده|رصيدها|من اللي|اللي عليهم|اللي علينا|كمان|بيدفع|بيحاسب|جنيه|اللي ليه|اللي ليا)/.test(x) ||
        x.split(/\s+/).length > 4
      const explicitOk = explicit.length >= 2 && !looksLikeSentence(explicit)
      const name = (explicitOk ? explicit : scanned?.name ?? '').trim()
      if (name.length < 2) {
        return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'الاسم', failMessage: `اسم ال${partyAr} إيه؟` }
      }
      // duplicate guard mirrors the executor's: never silently overwrite a balance
      const list: { name: string; balance: number; phone?: string | null }[] = isCustomer ? customers : suppliers
      const dup = list.find((x) => normalizeAr(x.name) === normalizeAr(name))
      if (dup) {
        return {
          ok: false,
          opType: type,
          payload: {},
          summary: '',
          card: null as never,
          missing: '',
          failMessage: `فيه ${partyAr} بالاسم ده بالفعل (${isCustomer ? 'عليه' : 'علينا'} ${egp(dup.balance)}) — استخدم ${isCustomer ? 'التحصيل' : 'السداد'} أو عدّل الرصيد بدل الإضافة`,
        }
      }
      // balance arrives in EGP (owner speaking) — the ledger stores piastres
      const balanceEgp = typeof f.balance === 'number' && Number.isFinite(f.balance) ? f.balance : scanned?.balance
      const balance = Math.round((balanceEgp ?? 0) * 100)
      const phone = typeof f.phone === 'string' ? f.phone.trim() : scanned?.phone
      const plan = typeof f.plan === 'string' ? f.plan.trim() : scanned?.plan
      const months = typeof f.months === 'number' ? f.months : scanned?.months
      const sinceRaw = typeof f.since === 'string' ? f.since : scanned?.since
      const since = sinceRaw ? new Date(sinceRaw) : null
      const payload = {
        name,
        balance,
        ...(phone ? { phone } : {}),
        ...(plan ? { plan } : {}),
        ...(months ? { months } : {}),
        ...(since && !Number.isNaN(since.getTime()) ? { since: since.toISOString() } : {}),
      }
      const risk = computeRisk(type, balance)
      const dueSince = since && !Number.isNaN(since.getTime()) ? arDate(since) : null
      const summary = `${isCustomer ? 'عميل جديد' : 'مورد جديد'}: ${name}${balance > 0 ? ` — ${isCustomer ? 'عليه' : 'علينا'} ${egp(balance)}` : ''}`
      const card = fieldsToCard('', type, risk, summary, [
        { label: isCustomer ? 'العميل' : 'المورد', value: name },
        { label: isCustomer ? 'عليه (افتتاحي)' : 'علينا (افتتاحي)', value: egp(balance) },
        ...(dueSince ? [{ label: 'مستحقة من', value: dueSince }] : []),
        ...(phone ? [{ label: 'التليفون', value: phone }] : []),
        ...(plan ? [{ label: 'الاشتراك', value: `${plan}${months ? ` — ${fmtQty(months)} شهر` : ''}` }] : []),
        ...(balanceEgp == null
          ? [{ label: 'خد بالك', value: 'مقلتليش عليه كام — سجلته برصيد صفر، قولّي المبلغ وأعدّله', hint: 'أو اكتب «عليه ٣٠٠» وأنا أسجله' }]
          : []),
      ], [{ label: isCustomer ? 'عميل جديد في السجل' : 'مورد جديد في السجل', value: name, tone: 'good' }], RISK_META[risk].hint)
      return { ok: true, opType: type, payload, summary, card, ...(balanceEgp == null ? { issues: [`${name} اتسجل برصيد صفر — قولّي عليه كام لو فيه فلوس`] } : {}) }
    }

    case 'reversal': {
      const ref = String(f.ref ?? '') || (norm.match(/WKL-\d+/)?.[0] ?? '')
      if (!ref) return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'رقم العملية', failMessage: 'عايز تعكس أنهي عملية؟ اكتب رقمها (زي WKL-1006)' }
      const original = await db.operation.findFirst({ where: { businessId: business.id, ref } })
      if (!original) return { ok: false, opType: type, payload: {}, summary: '', card: null as never, failMessage: `ملقيتش عملية رقم ${ref}` }
      if (original.reversedByRef) return { ok: false, opType: type, payload: {}, summary: '', card: null as never, failMessage: `العملية ${ref} معكوسة قبل كده بـ${original.reversedByRef}` }
      const reason = String(f.reason ?? '') || 'تصحيح خطأ'
      const payload = { originalRef: ref, reason }
      const risk = computeRisk(type)
      const summary = `عكس العملية ${ref} (${original.summary})`
      const card = fieldsToCard('', type, risk, summary, [
        { label: 'العملية الأصلية', value: `${ref} — ${TYPE_AR[original.type] ?? original.type}` },
        { label: 'ملخصها', value: original.summary },
        { label: 'السبب', value: reason },
      ], [{ label: 'الأثر', value: 'هيتلغى بالكامل بعملية عكسية موثقة', tone: 'neutral' }], 'عكس عملية مالية حساس (R3) — التاريخ مش بيتمسح، بيتصحح')
      return { ok: true, opType: type, payload, summary, card }
    }

    default:
      return { ok: false, opType: type, payload: {}, summary: '', card: null as never, failMessage: 'نوع العملية مش مدعوم' }
  }
}

// ---------------------------------------------------------------------------
// R17 «العقل الحقيقي» — THE BRAIN LOOP (model-driven tools + free chat)
// ---------------------------------------------------------------------------
/** One model-issued tool call: {"tool":"record_sale","args":{…}}. */
interface BrainToolCall {
  tool: string
  args: Record<string, unknown>
}

/**
 * Parse a brain reply into tool calls. Handles ALL the shapes GLM actually
 * emits: (a) a pure {"tool_calls":[…]} JSON, (b) the JSON wrapped in a code
 * fence, (c) SEVERAL separate blocks mixed with prose («{...}\n\n{...}»),
 * (d) JSON with ESCAPED quotes (\"tool_calls\") echoed from the results we
 * sent it. Returns the merged calls; null → plain conversational text.
 */
function parseBrainReply(raw: string): BrainToolCall[] | null {
  const cleaned = raw.trim()
  if (!cleaned) return null
  const tryParse = (s: string): BrainToolCall[] | null => {
    try {
      const obj = JSON.parse(s) as { tool_calls?: unknown }
      if (obj && Array.isArray(obj.tool_calls)) {
        const calls = obj.tool_calls
          .filter(
            (c): c is Record<string, unknown> =>
              !!c && typeof c === 'object' && typeof (c as Record<string, unknown>).tool === 'string',
          )
          .map((c) => ({
            tool: String(c.tool),
            args: (c.args && typeof c.args === 'object' && !Array.isArray(c.args) ? (c.args as Record<string, unknown>) : {}) as Record<string, unknown>,
          }))
        if (calls.length > 0) return calls
      }
    } catch {
      /* not JSON → text */
    }
    return null
  }

  // (a) direct — the whole string is one JSON object (fences tolerated)
  const direct = tryParse(cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim())
  if (direct) return direct

  // (b-d) scan for embedded blocks: unescape \" → " first (escaped echoes),
  // then brace-walk every {"tool_calls":…} block and parse each separately.
  const unescaped = cleaned.replace(/\\"/g, '"')
  const calls: BrainToolCall[] = []
  const seen = new Set<string>()
  let idx = 0
  while (idx < unescaped.length) {
    const at = unescaped.indexOf('"tool_calls"', idx)
    if (at === -1) break
    // walk BACK to the enclosing {
    let start = -1
    for (let i = at; i >= 0; i--) {
      if (unescaped[i] === '{') {
        start = i
        break
      }
    }
    // walk FORWARD to the balanced close (skips nothing — best effort)
    let depth = 0
    let end = -1
    for (let i = start; i < unescaped.length; i++) {
      const ch = unescaped[i]
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          end = i + 1
          break
        }
      }
    }
    if (start >= 0) {
      const block = unescaped.slice(start, end === -1 ? unescaped.length : end)
      const parsed = tryParse(block)
      if (parsed) {
        for (const c of parsed) {
          const sig = `${c.tool}:${JSON.stringify(c.args)}`
          if (!seen.has(sig)) {
            seen.add(sig)
            calls.push(c)
          }
        }
      }
    }
    idx = (end === -1 ? at + 1 : end)
  }
  return calls.length > 0 ? calls : null
}

/** Strip any tool_calls JSON (plain, escaped, fenced) from a FINAL text reply
 *  — the model sometimes echoes its own tool calls; the user must never see
 *  raw JSON. Also drops «نتايج الأدوات» echo blocks. */
function stripToolJson(text: string): string {
  let out = text.replace(/\\"/g, '"')
  // fenced blocks first
  out = out.replace(/```(?:json)?\s*\{[\s\S]*?"tool_calls"[\s\S]*?\}\s*```/g, '')
  let idx = 0
  while (idx < out.length) {
    const at = out.indexOf('"tool_calls"', idx)
    if (at === -1) break
    let start = -1
    for (let i = at; i >= 0; i--) {
      if (out[i] === '{') {
        start = i
        break
      }
    }
    let depth = 0
    let end = -1
    for (let i = start; i < out.length; i++) {
      const ch = out[i]
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          end = i + 1
          break
        }
      }
    }
    if (start >= 0) out = out.slice(0, start) + out.slice(end === -1 ? out.length : end)
    else idx = at + 1
  }
  // results-echo cleanup
  const echoAt = out.indexOf('نتايج الأدوات')
  if (echoAt !== -1) out = out.slice(0, echoAt)
  return out.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

/** Brain write-tools → the harness executor contract (opType + intent fields).
 * Arg names are TOLERANT: models spell the same arg differently across calls
 * ({customer} / {customerName} / {name}…) — the loop self-corrects much better
 * when the first spelling already lands. */
const brainArgStr = (a: Record<string, unknown>, ...keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = a[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && v > 0) return String(v)
  }
  return undefined
}
const brainArgNum = (a: Record<string, unknown>, ...keys: string[]): number | undefined => {
  for (const k of keys) {
    const v = a[k]
    if (typeof v === 'number' && v > 0) return v
    if (typeof v === 'string' && v.trim() && Number(v) > 0) return Number(v)
  }
  return undefined
}

const BRAIN_WRITE_TOOLS: Record<
  string,
  { opType: OpType; fields: (a: Record<string, unknown>) => Record<string, unknown> }
> = {
  record_sale: {
    opType: 'sale',
    fields: (a) => ({
      itemName: brainArgStr(a, 'item', 'itemName'),
      qty: brainArgNum(a, 'qty', 'quantity', 'count'),
      unit: brainArgStr(a, 'unit'),
      customerName: brainArgStr(a, 'customerName', 'customer', 'client', 'name'),
      paid: brainArgNum(a, 'paid', 'cash', 'paidAmount'),
      // the user's OWN stated price («بعت بـ٩٠») — wins over the catalog
      amount: brainArgNum(a, 'price', 'total', 'amount', 'statedPrice'),
    }),
  },
  record_purchase: {
    opType: 'purchase',
    fields: (a) => ({
      itemName: brainArgStr(a, 'item', 'itemName'),
      qty: brainArgNum(a, 'qty', 'quantity', 'count'),
      unit: brainArgStr(a, 'unit'),
      supplierName: brainArgStr(a, 'supplierName', 'supplier', 'vendor', 'name'),
      paid: brainArgNum(a, 'paid', 'cash', 'paidAmount'),
    }),
  },
  record_collection: {
    opType: 'collection',
    fields: (a) => ({ customerName: brainArgStr(a, 'customerName', 'customer', 'client', 'name'), amount: brainArgNum(a, 'amount', 'paid', 'value', 'total') }),
  },
  record_payment: {
    opType: 'payment',
    fields: (a) => ({ supplierName: brainArgStr(a, 'supplierName', 'supplier', 'vendor', 'name'), amount: brainArgNum(a, 'amount', 'paid', 'value', 'total') }),
  },
  record_expense: {
    opType: 'expense',
    fields: (a) => ({ label: brainArgStr(a, 'reason', 'label', 'description', 'note'), amount: brainArgNum(a, 'amount', 'value', 'cost', 'total') }),
  },
  register_member: {
    opType: 'membership',
    fields: (a) => ({ name: brainArgStr(a, 'name', 'memberName'), plan: brainArgStr(a, 'plan'), months: brainArgNum(a, 'months') }),
  },
  record_attendance: { opType: 'attendance', fields: (a) => ({ name: brainArgStr(a, 'name', 'memberName') }) },
  // Aliases + the tools the WRITE contract advertises under another name. A
  // model that follows the prompt exactly (`adjust_stock`, `create_member`) or a
  // provider that renames a tool (`record_stock_adjustment`) must still land on
  // the real executor — an unknown name silently produced NO draft.
  adjust_stock: {
    opType: 'stock_adjustment',
    fields: (a) => ({ itemName: brainArgStr(a, 'item', 'itemName', 'name'), qty: brainArgNum(a, 'qty', 'quantity', 'delta', 'newQty', 'count') }),
  },
  record_stock_adjustment: {
    opType: 'stock_adjustment',
    fields: (a) => ({ itemName: brainArgStr(a, 'item', 'itemName', 'name'), qty: brainArgNum(a, 'qty', 'quantity', 'delta', 'newQty', 'count') }),
  },
  create_member: {
    opType: 'membership',
    fields: (a) => ({ name: brainArgStr(a, 'name', 'memberName'), plan: brainArgStr(a, 'plan'), months: brainArgNum(a, 'months') }),
  },
  renew_membership: {
    opType: 'membership',
    fields: (a) => ({ name: brainArgStr(a, 'name', 'memberName'), plan: brainArgStr(a, 'plan'), months: brainArgNum(a, 'months') }),
  },
  // R29 «ضيف أحمد من اللي عليهم فلوس» — the owner grows the ledger by talking.
  register_customer: {
    opType: 'customer_add',
    fields: (a) => ({
      name: brainArgStr(a, 'name', 'customerName', 'customer', 'client'),
      phone: brainArgStr(a, 'phone', 'mobile', 'telephone'),
      balance: brainArgNum(a, 'balance', 'amount', 'debt', 'opening'),
      plan: brainArgStr(a, 'plan'),
      months: brainArgNum(a, 'months'),
      // «من أيام كذا» — the opening balance keeps its own date
      since: brainArgStr(a, 'since', 'sinceDate', 'owedSince', 'from'),
    }),
  },
  add_customer: {
    opType: 'customer_add',
    fields: (a) => ({
      name: brainArgStr(a, 'name', 'customerName', 'customer', 'client'),
      phone: brainArgStr(a, 'phone', 'mobile', 'telephone'),
      balance: brainArgNum(a, 'balance', 'amount', 'debt', 'opening'),
      plan: brainArgStr(a, 'plan'),
      months: brainArgNum(a, 'months'),
      // «من أيام كذا» — the opening balance keeps its own date
      since: brainArgStr(a, 'since', 'sinceDate', 'owedSince', 'from'),
    }),
  },
  register_supplier: {
    opType: 'supplier_add',
    fields: (a) => ({ name: brainArgStr(a, 'name', 'supplierName', 'supplier', 'vendor'), phone: brainArgStr(a, 'phone', 'mobile'), balance: brainArgNum(a, 'balance', 'amount', 'debt') }),
  },
  add_supplier: {
    opType: 'supplier_add',
    fields: (a) => ({ name: brainArgStr(a, 'name', 'supplierName', 'supplier', 'vendor'), phone: brainArgStr(a, 'phone', 'mobile'), balance: brainArgNum(a, 'balance', 'amount', 'debt') }),
  },
  reverse_operation: { opType: 'reversal', fields: (a) => ({ ref: brainArgStr(a, 'ref', 'reference', 'opRef', 'id') }) },
}

/** Arabic step label + icon for a brain tool call (thinking timeline UX). */
function brainStepLabel(call: BrainToolCall): { label: string; icon: ThinkingStep['icon'] } {
  if (call.tool === 'memory_save') return { label: 'بحفظ في ذاكرتي', icon: 'verify' }
  if (call.tool === 'memory_forget') return { label: 'بامسح من ذاكرتي', icon: 'verify' }
  if (call.tool === 'calculate') return { label: 'بحسب في الحاسبة', icon: 'verify' }
  if (call.tool === 'schedule_task') return { label: 'بجدّل مهمة', icon: 'plan' }
  if (call.tool === 'set_persona') return { label: 'بظبط نبرتي', icon: 'plan' }
  // R28 orchestration tools get their own verbs — the owner sees a plan being
  // executed, not a mystery «tool call»
  if (call.tool === 'run_plan') return { label: 'بنفّذ خطة من كذا خطوة', icon: 'plan' }
  if (call.tool === 'deep_dive') return { label: 'قاعد أحقّق في السؤال', icon: 'search' }
  const w = BRAIN_WRITE_TOOLS[call.tool]
  if (w) return { label: `بجهّز مسودة: ${TYPE_AR[w.opType] ?? w.opType}`, icon: 'plan' }
  return { label: `بجيب: ${TOOL_LABEL_AR[call.tool] ?? call.tool}`, icon: 'search' }
}

// ---------------------------------------------------------------------------
// R18 «الأدوات بتاعة العقل» — calculate / schedule_task / set_persona
// ---------------------------------------------------------------------------
/** Pretty Arabic-Indic number for calculator output (no currency — pure math). */
function fmtCalcNumber(n: number): string {
  return new Intl.NumberFormat('ar-EG', { maximumFractionDigits: 4 }).format(n)
}

/** SAFE arithmetic evaluation — digits normalized (٠-٩ ۰-۹), × ÷ to * /,
 *  then a charset whitelist, then Function() on the sanitized string only.
 *  The model NEVER refuses math («حسبلي كده») — it calls calculate instead. */
function safeCalculate(rawExpr: string): { ok: true; value: number } | { ok: false; error: string } {
  const expr = toWesternDigits(String(rawExpr ?? ''))
    .replace(/ـ/g, '') // tatweel is a JOINER, not an operator
    .replace(/[×xX]/g, '*')
    .replace(/÷/g, '/')
    .replace(/−|–|—/g, '-')
    .replace(/٪/g, '%')
    .replace(/\s+/g, '')
    .slice(0, 200)
  if (!expr) return { ok: false, error: 'التعبير فاضي' }
  if (!/^[\d+\-*/().%]+$/.test(expr)) return { ok: false, error: 'التعبير فيه حروف مش مسموحة' }
  if (/\d{16,}/.test(expr)) return { ok: false, error: 'رقم أطول من اللازم' }
  try {
    const value = Function(`"use strict"; return (${expr})`)() as unknown
    if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, error: 'النتيجة مش رقم صالح' }
    return { ok: true, value: Math.round(value * 10000) / 10000 }
  } catch {
    return { ok: false, error: 'التعبير مش مظبوط رياضيًا' }
  }
}

/** «بكره» / «يوم الجمعة» / «بعد بكره» / «الاسبوع الجاي» … → a concrete Date
 *  (Cairo-local morning 10:00 — reminders land at a humane hour). */
function resolveArabicWhen(whenLabel: string): Date | null {
  const s = normalizeAr(whenLabel)
  const now = new Date()
  const d = new Date(now)
  d.setHours(10, 0, 0, 0)
  // weekday map — Saturday STARTS the Egyptian business week
  const DAYS: Record<string, number> = {
    السبت: 6,
    الاحد: 0,
    الاتنين: 1,
    التلات: 2,
    الاربع: 3,
    الخميس: 4,
    الجمعه: 5,
  }
  let matched = false
  if (/بعد بكره/.test(s)) {
    d.setDate(d.getDate() + 2)
    matched = true
  } else if (/بكره/.test(s)) {
    d.setDate(d.getDate() + 1)
    matched = true
  } else {
    for (const [name, dow] of Object.entries(DAYS)) {
      if (s.includes(name)) {
        const diff = (dow - d.getDay() + 7) % 7 || 7
        d.setDate(d.getDate() + diff)
        matched = true
        break
      }
    }
  }
  if (!matched) {
    if (/اخر الشهر/.test(s)) {
      d.setMonth(d.getMonth() + 1, 0) // last day of current month
      matched = true
    } else if (/الشهر الجاي/.test(s)) {
      d.setMonth(d.getMonth() + 1)
      matched = true
    } else if (/الاسبوع الجاي/.test(s)) {
      d.setDate(d.getDate() + 7)
      matched = true
    }
  }
  return matched ? d : null
}

/** The Arabic tone word (or latin key) → the AgentSettings.tone value. */
function toneKey(raw: string): string | null {
  const s = normalizeAr(raw)
  if (/رسمي|محترم|فصحي/.test(s)) return 'formal'
  if (/مختصر|قصير|مباشر|على طول|بدون مقدمات/.test(s)) return 'brief'
  if (/ودود|دافي|صاحب|صديق|ودي/.test(s)) return 'friendly'
  if (['friendly', 'formal', 'brief'].includes(s)) return s
  return null
}

/** Promised-payment clause: «هيديني الباقي يوم الجمعة» → «يوم الجمعة» (normalized text). */
const PROMISE_RE =
  /(هيديني|هيدفع|هتدي|هتدفع|هيسلم|هتسلم|هيوفى|هيرجع)[^،.\n]{0,40}?((?:يوم\s|نهار\s)?(?:الجمعه|السبت|الاحد|الاتنين|التلات|الاربع|الخميس)|بكره|بعد بكره|الشهر الجاي|الاسبوع الجاي|اخر الشهر)/
function extractPromiseDay(text: string): string | null {
  const m = normalizeAr(text).match(PROMISE_RE)
  return m ? m[2].trim() : null
}

// ---------------------------------------------------------------------------
// The turn runner
// ---------------------------------------------------------------------------
export interface TurnResult {
  replyText: string
  card?: ActionCardDTO | null
  cards?: ResultCardDTO[] | null
  thinking: ThinkingStep[]
  modelLabel: string
  opId?: string
  actions?: ChatActionDTO[] | null
  /** R15: deep-research metadata (plan + cited sources) when the turn researched */
  research?: ResearchDTO | null
  /** R15: self-verification ledger («اتأكدت الأرقام») */
  verified?: VerifyDTO | null
  /** R15: scratchpad jots started this turn (notes invalidation hint for done) */
  notesJotted?: number
}

/** Mutable per-turn state owned by the wrapper: telemetry kind + fallback + jots. */
interface TurnMeta {
  kind: 'chat' | 'advisory' | 'research'
  fallback: boolean
  notesJotted: number
  /** Turn start (ms epoch) — the baseline for per-pass timing. */
  startedAt: number
}

/**
 * The public turn runner — a telemetry shell around the real engine:
 * measures total latency + TTFT (first delta/step on the wire), resets the
 * LLM health flags (retry/fallback ladder), writes exactly ONE UsageEvent per
 * turn {kind, label = أول ٤٠ حرف من رسالة المستخدم, latencyMs, ttftMs,
 * tokens ≈ len/3, fallback}, plus a 'verify' event when verification did work.
 */
export async function runAgentTurn(ctx: TurnContext, emit: TurnEmit): Promise<TurnResult> {
  ensurePrismaFresh() // dev-server prisma hot-reload seam (no-op on fresh processes)
  const t0 = Date.now()
  let ttftMs: number | null = null
  let sawFirstToken = false
  const meta: TurnMeta = { kind: 'chat', fallback: false, notesJotted: 0, startedAt: t0 }
  llmHealth.retried = false
  llmHealth.fellBack = false
  const trackedEmit: TurnEmit = (ev) => {
    if (!sawFirstToken && (ev.event === 'delta' || ev.event === 'step')) {
      sawFirstToken = true
      ttftMs = Date.now() - t0
    }
    emit(ev)
  }
  let result: TurnResult
  try {
    result = await runAgentTurnInner(ctx, trackedEmit, meta)
  } catch (err) {
    // the engine itself exploded — record the failure, then let the route's
    // catch send the SSE error (the user never sees a half-turn silently die)
    void trackTurnUsage(ctx.business.id, ctx.user.id, meta.kind, ctx.text, {
      latencyMs: Date.now() - t0,
      ttftMs,
      tokens: 0,
      fallback: true,
    })
    throw err
  }
  void trackTurnUsage(ctx.business.id, ctx.user.id, meta.kind, ctx.text, {
    latencyMs: Date.now() - t0,
    ttftMs,
    tokens: Math.ceil(result.replyText.length / 3),
    fallback: meta.fallback || llmHealth.retried || llmHealth.fellBack,
  })
  if (result.verified && (result.verified.status === 'corrected' || result.verified.checks.length > 0)) {
    void trackKindEvent(ctx.business.id, ctx.user.id, 'verify', result.verified.status)
  }
  result.notesJotted = meta.notesJotted
  // If the fallback ladder had to swap models mid-turn, the label the UI shows
  // must name the model that ACTUALLY answered — never claim a dead one.
  if (llmHealth.servedBy) result.modelLabel = llmHealth.servedBy
  return result
}

/**
 * «تأمل وكيل» — the reflective pass that runs before every draft is created.
 *
 * Deterministic on purpose: the same system that produced the numbers cannot be
 * trusted to grade them, so the audit is arithmetic against the ledger (price
 * history, stock, balances, duplicate window, expense baseline). Findings are
 * (a) shown on the card before the owner approves, (b) written to the audit
 * trail, and (c) able to escalate a draft to R3 when the arithmetic says the
 * draft deserves a second pair of eyes.
 */
async function reflectOnDraft(args: {
  businessId: string
  userId: string
  type: OpType
  summary: string
  payload: Record<string, unknown>
}): Promise<{ findings: AuditFindingDTO[]; confidence: number; risk?: string; ms: number }> {
  const result = await auditDraft(args)
  if (result.findings.length > 0) {
    try {
      await db.auditEvent.create({
        data: {
          businessId: args.businessId,
          actor: args.userId,
          action: 'draft.audit',
          ref: null,
          detail: JSON.stringify({
            type: args.type,
            summary: args.summary,
            confidence: result.confidence,
            findings: result.findings,
          }),
        },
      })
    } catch (err) {
      // the trail is best-effort: never block a draft because logging failed
      console.error('[audit] trail write failed:', err)
    }
  }
  const danger = result.findings.some((f) => f.severity === 'danger')
  return { findings: result.findings, confidence: result.confidence, risk: danger ? 'R3' : undefined, ms: result.ms }
}

async function runAgentTurnInner(ctx: TurnContext, emit: TurnEmit, meta: TurnMeta): Promise<TurnResult> {
  const { business, user, text } = ctx
  const v = getVertical(business.type)
  const model = await resolveModel(ctx.modelKey)
  const modelLabel = modelLabelFor(model)

  // Load context once (memories raised to 8; pending ops count for the persona;
  // R15: «ورقة وكيل» scratchpad notes for prompt injection; R16: «أدوات
  // بتاعتك» the owner's own tools — one prompt line so the agent knows them)
  // Catalog comes from the 5-second cache (invalidated on every committed
  // write); memories/notes/tools stay live because they change mid-conversation.
  const { items, customers, suppliers } = await getCatalog(business.id)
  // «سرعة»: the recall pass is timed like every other pass — «فتكرت من ذاكرتي»
  // used to be the ONE step with no milliseconds, which made the trace look
  // like it had skipped work it had actually done.
  const recallClock = Date.now()
  const [memories, pendingCount, notesSection, userTools] = await Promise.all([
    db.agentMemory.findMany({ where: { businessId: business.id, userId: user.id, active: true }, orderBy: { createdAt: 'desc' }, take: 12 }),
    db.operation.count({ where: { businessId: business.id, status: 'AWAITING_APPROVAL' } }),
    notesContext(ctx.conversationId),
    activeTools(business.id),
  ])
  const recallMs = Math.max(0, Date.now() - recallClock)
  const userToolsLine = userToolsPromptLine(userTools)
  const rules = memories.filter((m) => m.kind === 'rule')
  const memCtx: MemoryContext = {
    // Verified before use: an alias must still FIT its entity name and be
    // unambiguous in this catalog (live R29: a legacy row mapped «شوكولاتة» to
    // «كوكاكولا 1 لتر» and the draft billed a cola for a chocolate sentence).
    lexicon: pruneLexicon(
      parseLexicon(memories),
      [...items, ...customers, ...suppliers],
      [...customers.map((c) => c.name), ...suppliers.map((s) => s.name)],
    ),
    rules,
    referencedIds: [],
  }
  // Prompt memories: preferences + facts (rules are injected in their own block)
  const promptMemories = memories.filter((m) => m.kind === 'preference' || m.kind === 'fact')

  // Thinking steps — with a «فتكرت من ذاكرتي» recall step injected right after
  // «بفهم طلبك» whenever the agent actually remembers something about this user.
  const memStep: ThinkingStep[] =
    memories.length > 0
      ? [
          {
            label: 'فتكرت من ذاكرتي',
            detail: memories[0].text.slice(0, 60) + (memories[0].text.length > 60 ? '…' : ''),
            state: 'done',
            icon: 'verify',
            ms: recallMs,
          },
        ]
      : []
  const steps: ThinkingStep[] = [
    { label: 'بفهم طلبك', detail: 'بحلل الجملة وأستخرج القصد والحقول', state: 'active', icon: 'understand' },
    ...memStep,
    { label: 'بدوّر في سجلك', detail: 'بدوّر على الأصناف والأسماء الحقيقية', state: 'pending', icon: 'search' },
    { label: 'بتحقق من الأرقام', detail: 'بحسب من الأسعار الفعلية مش من دماغي', state: 'pending', icon: 'verify' },
    { label: 'بجهّز الرد', detail: '', state: 'pending', icon: 'plan' },
  ]
  const IDX = { understand: 0, search: 1 + memStep.length, verify: 2 + memStep.length, reply: 3 + memStep.length }
  const pushThinking = () => emit({ event: 'thinking', steps: steps.map((s) => ({ ...s })) })
  // «سرعة»: each of the four main passes is timed. `passClock` advances as the
  // passes complete, so the trace shows where the milliseconds actually go
  // (understanding, grounding, arithmetic, composing) instead of a vague total.
  let passClock = meta.startedAt
  const done = (i: number, detail?: string) => {
    if (steps[i]) {
      const now = Date.now()
      steps[i].state = 'done'
      steps[i].ms = Math.max(0, now - passClock)
      passClock = now
      if (detail) steps[i].detail = detail
    }
    pushThinking()
  }
  pushThinking()

  const norm = normalizeAr(text)

  // ---- PASS 0a: Identity question → instant, deterministic, zero LLM ----
  if (isIdentityQuestion(norm)) {
    const lowStockCount = items.filter((i) => i.stockQty <= i.lowStockThreshold).length
    const receivablesTotal = customers.reduce((s, c) => s + Math.max(0, c.balance), 0)
    done(IDX.understand, 'سؤال عن هويتي — بجاوب من سجلك من غير موديل')
    done(IDX.search, 'جبت بياناتي من سجلك الحقيقي')
    done(IDX.verify, 'عدّيت النواقص والعمليات المستنية من قاعدة البيانات')
    emit({ event: 'step', label: 'بتعرّف بنفسي', state: 'done' })
    done(IDX.reply)
    const identityMemory = memories.find((m) => m.kind === 'preference' || m.kind === 'rule' || m.kind === 'fact') ?? null
    if (identityMemory) memCtx.referencedIds.push(identityMemory.id)
    const replyText = buildIdentityReply({
      business,
      user,
      verticalLabel: v.label,
      memoryText: identityMemory?.text ?? null,
      lowStockCount,
      pendingCount,
      receivablesTotal,
    })
    const actions: ChatActionDTO[] = [
      { id: 'act-today', label: 'لوحة اليوم', view: 'today', icon: 'today', tone: 'primary' },
      ...(lowStockCount > 0
        ? [{ id: 'act-inventory', label: 'شوف المخزون', view: 'inventory' as const, icon: 'boxes' as const, tone: 'outline' as const }]
        : []),
    ]
    // R15 self-verification: the identity numbers came from the DB — the
    // deterministic checker still cross-quotes them before anything streams.
    const idFacts: VerifyFact[] = [
      { label: 'أصناف ناقصة', value: String(lowStockCount) },
      { label: 'عمليات مستنية اعتماد', value: String(pendingCount) },
      { label: 'مديونيات العملاء', value: egp(receivablesTotal) },
    ]
    const idVerified = verifyReply(replyText, idFacts)
    await streamDeterministic(idVerified.text, emit, 1200)
    emit({ event: 'actions', actions })
    await bumpMemoryUsage(memCtx.referencedIds)
    return {
      replyText: idVerified.text,
      card: null,
      cards: null,
      thinking: steps,
      modelLabel,
      actions,
      verified: idVerified.verified,
    }
  }

  // ---- PASS 0b: Memory save (preference OR BUSINESS_DNA rule) → instant, persisted, zero LLM ----
  const saveRequest = extractSaveRequest(text, norm) ?? extractRuleRequest(text, norm)
  if (saveRequest) {
    // Dedupe: re-saving the exact same memory must NOT clutter the memory
    // list — the owner repeating himself deserves a calm «already saved».
    const isDuplicate = memories.some((m) => normalizeAr(m.text) === normalizeAr(saveRequest.text))
    if (!isDuplicate) {
      await db.agentMemory.create({
        data: {
          businessId: business.id,
          userId: user.id,
          kind: saveRequest.kind,
          category: saveRequest.category,
          text: saveRequest.text,
          confidence: saveRequest.confidence,
        },
      })
    }
    const isRule = saveRequest.kind === 'rule'
    done(IDX.understand, isRule ? 'قانون من صاحب الشغل — مش محتاج موديل' : 'طلب حفظ في الذاكرة — مش محتاج موديل')
    done(IDX.search, 'بتخزنها في ذاكرتي عنك')
    done(IDX.verify, isDuplicate ? 'موجودة أصلًا — من غير تكرار' : 'اتحفظت فعليًا في قاعدة البيانات')
    emit({ event: 'step', label: 'بحفظ في ذاكرتي', state: 'done' })
    done(IDX.reply)
    const replyText = isDuplicate
      ? `دي محفوظة في ذاكرتي أصلًا ✅ — «${saveRequest.text}». مطمن، مش هنسيها.`
      : isRule
        ? `اتحفظت قانون من قوانين المحل ✅ — «${saveRequest.text}».\nمن دلوقتي أي عملية تخص الموضوع ده هتتنبه عليه قبل الاعتماد.`
        : `اتحفظت في ذاكرتي ✅ — هفتكرها: «${saveRequest.text}». لما الموقف ده يتكرر هرفعها على طول.`
    await streamDeterministic(replyText, emit, 1000)
    const saveVerified = verifyReply(replyText, [])
    return {
      replyText: saveVerified.text,
      card: null,
      cards: null,
      thinking: steps,
      modelLabel,
      actions: null,
      verified: saveVerified.verified,
    }
  }

  // ---- PASS 0c: FORGET («انسى…") → deactivate, instant, zero LLM ----
  const forgetRequest = extractForgetRequest(text, norm)
  if (forgetRequest) {
    const target = findMemoryByReference(forgetRequest.reference, memories)
    done(IDX.understand, 'طلب مسح من الذاكرة — مش محتاج موديل')
    done(IDX.search, 'بدوّر عليها في ذاكرتي المحفوظة')
    let replyText: string
    if (target) {
      await db.agentMemory.update({ where: { id: target.id }, data: { active: false, updatedAt: new Date() } })
      done(IDX.verify, 'اتمسحت فعليًا (متفعّلة لأ)')
      emit({ event: 'step', label: 'بامسح من ذاكرتي', state: 'done' })
      replyText = `اتمسحت من ذاكرة وكيل ✅ — الكلام ده: «${target.text.slice(0, 100)}».\nلو احتجته تاني في يوم من الأيام قولي «احفظ» وأرجعه لك.`
    } else {
      done(IDX.verify, 'ملقيتش حاجة بالشكل ده')
      emit({ event: 'step', label: 'بامسح من ذاكرتي', state: 'done' })
      replyText = `بصراحة ملقيتش في ذاكرتي حاجة بالشكل ده 🤔 — قولي جزء من الكلام اللي حفظته بالظبط وأمسحه لك.`
    }
    done(IDX.reply)
    const forgetVerified = verifyReply(replyText, [])
    await streamDeterministic(forgetVerified.text, emit, 1000)
    return {
      replyText: forgetVerified.text,
      card: null,
      cards: null,
      thinking: steps,
      modelLabel,
      actions: null,
      verified: forgetVerified.verified,
    }
  }

  // ---- PASS 0d: DEEP RESEARCH (user-toggled OR auto-detected) — R15 ----
  // Plan-first pipeline: خطة البحث → جمع من السجل (نفس أدوات الريجستري) →
  // بحث ويب (٢ استعلامات) → كارت المصادر المرقمة → تقرير الخلاصة/التحليل/
  // التوصيات باستشهادات [١] [٢] → تحقق ذاتي (أرقام + حكم LLM) — كله يتعمل
  // وييتحقق قبل أول حرف يوصل للمستخدم.
  // Auto-research must not hijack a concrete command («حسن دفع ٥٠ من اللي عليه»
  // contains «ليه» but is a collection, not a research question).
  const wantsAutoResearch = ctx.deepResearch !== true && RESEARCH_TRIGGER_RE.test(text)
  const autoResearchBlocked = wantsAutoResearch && isActionableIntent(ruleBasedIntent(text, business.type))
  if (ctx.deepResearch === true || (wantsAutoResearch && !autoResearchBlocked)) {
    meta.kind = 'research'
    const researchResult = await runDeepResearch({
      business,
      user,
      conversationId: ctx.conversationId,
      text,
      model,
      mode: ctx.deepResearch === true ? 'forced' : 'auto',
      emit,
      notesSection,
      onJot: () => {
        meta.notesJotted++
      },
    })
    if (researchResult.llmFallback) meta.fallback = true
    // stream the VERIFIED report letter-by-letter (research already emitted
    // its thinking/step/cards events incl. the sources card BEFORE any delta)
    await streamDeterministic(researchResult.reportText, emit, 2600)
    const researchActions: ChatActionDTO[] = [
      { id: 'act-research-stats', label: 'افتح الإحصائيات', view: 'stats', icon: 'chart', tone: 'primary' },
      { id: 'act-research-journal', label: 'سجل العمليات', view: 'journal', icon: 'journal', tone: 'outline' },
    ]
    emit({ event: 'actions', actions: researchActions })
    await bumpMemoryUsage(memCtx.referencedIds)
    return {
      replyText: researchResult.reportText,
      card: null,
      cards: researchResult.cards,
      thinking: researchResult.steps,
      modelLabel,
      research: researchResult.research,
      verified: researchResult.verified,
      actions: researchActions,
    }
  }

  // ---- PASS 0Ω: THE BRAIN LOOP (R17 — «العقل الحقيقي») ----
  // The whole ERP rides on ONE system prompt (buildAgentSystemPrompt) and the
  // MODEL itself decides: plain-text reply (free chat — أي موضوع، حتى برا
  // الشغل) OR {"tool_calls":[…]} (one or many — model-driven task
  // decomposition: it splits the request, picks the right tools, and compact
  // results loop back until it writes the final reply). A failure BEFORE any
  // tool executes falls through to the proven PASS 1 pipeline below; AFTER
  // tools ran the turn always finishes here (deterministic composed reply on
  // mid-loop LLM death) — the fallback path NEVER re-executes tools, so there
  // are no double drafts, ever.
  const runBrainTurn = async (): Promise<TurnResult | null> => {
    let executedAnyTool = false
    let modelSavedMemory = false
    const brainFacts: VerifyFact[] = []
    const allCards: ResultCardDTO[] = []
    const usedTools: string[] = []
    let draftCard: ActionCardDTO | null = null
    let draftOpId: string | undefined
    let anyDraft = false
    const replyParts: string[] = []
    const resultsForModel: Record<string, unknown>[] = []
    // A tool that FAILED (missing money, over-debt collection, unknown item) —
    // the owner must hear about it even if the model answers with small talk.
    const brainFailures: string[] = []
    let rounds = 0
    // R18 dedupe: the same tool+args signature must never execute twice in
    // ONE turn (the model sometimes re-issues its earlier call when it
    // echoes JSON) — a repeat reports back instead of drafting a duplicate.
    const executedSigs = new Set<string>()

    // dynamic thinking timeline: understand(done) + mem + [tool steps…] + verify + reply
    //
    // «سرعة»: the brain path is the one a real model actually runs, so its
    // timeline carries the same measured milliseconds as the deterministic
    // pipeline — understanding (how long the model took to decide), each tool
    // round, the verification pass, and the composing/streaming pass. Kept in
    // local state because `syncSteps()` rebuilds the array on every tool round.
    const toolSteps: ThinkingStep[] = []
    let brainClock = Date.now()
    let understandMs: number | undefined
    let verifyMs: number | undefined
    let replyMs: number | undefined
    /** freeze the «understood the request» pass at its true length */
    const stampUnderstand = () => {
      if (understandMs === undefined) understandMs = Math.max(0, Date.now() - brainClock)
    }
    const syncSteps = () => {
      steps.length = 0
      steps.push(
        {
          label: 'بفهم طلبك',
          detail: 'عقلي بيقري طلبك وبيقرر بنفسي الأدوات المناسبة',
          state: 'done',
          icon: 'understand',
          ms: understandMs,
        },
        ...memStep,
        ...toolSteps,
        {
          label: 'بتحقق من الأرقام',
          detail: 'الأرقام من السجل بس — مفيش تخمين',
          state: verifyMs === undefined ? 'pending' : 'done',
          icon: 'verify',
          ms: verifyMs,
        },
        {
          label: 'بجهّز الرد',
          detail: '',
          state: replyMs === undefined ? 'pending' : 'done',
          icon: 'plan',
          ms: replyMs,
        },
      )
      pushThinking()
    }
    syncSteps()

    /** execute ONE model-issued tool call — never throws, always reports back */
    const execBrainCall = async (call: BrainToolCall): Promise<void> => {
      // R18 dedupe: an exact re-issue (the model echoing its own earlier
      // call) reports back instead of re-executing — no duplicate drafts.
      const sig = `${call.tool}:${JSON.stringify(call.args)}`
      if (executedSigs.has(sig)) {
        resultsForModel.push({ tool: call.tool, ok: true, duplicate: true, note: 'نفذت الأداة دي مرة قبل كده في نفس الرسالة — مكررتهاش' })
        return
      }
      executedSigs.add(sig)
      executedAnyTool = true
      const { label, icon } = brainStepLabel(call)
      const argBits = Object.values(call.args)
        .filter((x) => x !== undefined && x !== null && String(x) !== '')
        .map(String)
        .slice(0, 3)
        .join('، ')
      const step: ThinkingStep = { label, detail: argBits ? argBits.slice(0, 60) : 'بنفّذها', state: 'active', icon }
      toolSteps.push(step)
      // the decision is over the moment the first action starts
      stampUnderstand()
      syncSteps()
      emit({ event: 'step', label, state: 'active' })
      const toolClock = Date.now()
      try {
        // ---- READ tools (R0 — direct, safe, BUDGETED) ----
        // dsh's guarded pipeline + Claude Code's per-result budget: the UI gets
        // the whole card, the MODEL gets a digest capped at 1.6k chars, and the
        // call can never hang the turn (9s hard timeout → reported failure).
        if (READ_TOOLS.has(call.tool)) {
          const run = await runToolPipeline(call.tool, business.id, call.args)
          if (!run.ok) {
            step.detail = run.error?.slice(0, 80) ?? 'الأداة فشلت'
            resultsForModel.push({ tool: call.tool, ok: false, error: run.error ?? 'فشل' })
            replyParts.push(`مش قادر أجيب ${TOOL_LABEL_AR[call.tool] ?? call.tool} دلوقتي — قول للمستخدم إن في مشكلة مؤقتة.`)
            brainFailures.push(`مش قادر أجيب ${TOOL_LABEL_AR[call.tool] ?? call.tool} دلوقتي — جرّب تاني بعد شوية`)
            return
          }
          const subCards = run.cards
          allCards.push(...subCards)
          emit({ event: 'cards', cards: allCards })
          usedTools.push(call.tool)
          brainFacts.push(...factsFromCards(subCards))
          meta.notesJotted += jotFactsFromCards(
            { businessId: business.id, userId: user.id, conversationId: ctx.conversationId },
            subCards,
          )
          const summary = subCards
            .map((c) => {
              if (c.kind === 'kv') return `${c.title}: ${c.rows.slice(0, 3).map((f) => `${f.label}=${f.value}`).join('، ')}`
              if (c.kind === 'table') return `${c.title}: ${toArabicNum(c.rows.length)} صف`
              if (c.kind === 'sources') return `${c.title}: ${toArabicNum(c.sources.length)} مصدر`
              return c.title
            })
            .join('؛ ')
          step.detail = (run.trimmed ? `${summary.slice(0, 70)}… (اتقصّرت للسياق)` : summary.slice(0, 90)) || 'رجعت ببيانات'
          resultsForModel.push({
            tool: call.tool,
            ok: true,
            ms: run.ms,
            // the MODEL sees the budgeted digest, not the raw card array
            result: run.output,
          })
          replyParts.push(deterministicReadReply(subCards))
          await trackUsage(business.id, user.id, 'tool', call.tool)
          return
        }

        // ---- run_plan: Programmatic Tool Calling, in a safe subset ----
        // DeepSeek's PTC idea without code execution: the model sends ONE call
        // describing several read-only queries, the harness runs them as a
        // batch (parallel, budgeted, timeout-guarded) and returns one compact
        // result. Three round trips become one — the biggest latency win for
        // compound questions like «مبيعات الأسبوع وربحه والنواقص».
        if (call.tool === 'run_plan') {
          const plan = normalizePlan(call.args)
          if (plan.length === 0) {
            step.detail = 'الخطة فاضية أو فيها أداة غير مسموحة'
            resultsForModel.push({
              tool: 'run_plan',
              ok: false,
              error: 'الخطة لازم تكون أدوات قراءة معروفة بس (من غير أي كتابة)',
            })
            replyParts.push('الخطة اللي جت من غير خطوات قراءة صالحة — حاول تاني بأدوات القراءة.')
            return
          }
          emit({ event: 'plan', steps: plan.map((p) => TOOL_LABEL_AR[p.tool] ?? p.tool) })
          const runs = await Promise.all(
            plan.map((p) => runToolPipeline(p.tool, business.id, p.args ?? {}, { budgetChars: 1_200 })),
          )
          const doneRuns = runs.filter((r) => r.ok)
          for (const r of runs) {
            usedTools.push(r.tool)
            for (const c of r.cards) allCards.push(c)
            brainFacts.push(...factsFromCards(r.cards))
            meta.notesJotted += jotFactsFromCards(
              { businessId: business.id, userId: user.id, conversationId: ctx.conversationId },
              r.cards,
            )
            if (r.cards.length > 0) replyParts.push(deterministicReadReply(r.cards))
          }
          if (allCards.length > 0) emit({ event: 'cards', cards: allCards })
          step.detail = `نفّذت ${toArabicNum(doneRuns.length)}/${toArabicNum(runs.length)} استعلام في خطوة واحدة`
          resultsForModel.push({
            tool: 'run_plan',
            ok: true,
            steps: runs.map((r) => ({ tool: r.tool, ok: r.ok, ms: r.ms, error: r.error, output: r.output })),
          })
          await trackUsage(business.id, user.id, 'tool', `plan:${plan.length}`)
          return
        }

        // ---- deep_dive: an ISOLATED researcher (summary-only return) ----
        if (call.tool === 'deep_dive') {
          const question = String(call.args.question ?? call.args.q ?? text).slice(0, 300)
          const snapshot = await getSnapshot(business)
          const sub = await runSubAgent({
            businessId: business.id,
            question,
            context: [
              `النشاط: ${business.name} (${business.type})`,
              `الخزنة: ${egp(snapshot?.cash ?? 0)}`,
              `مبيعات النهاردة: ${egp(snapshot?.salesToday ?? 0)}`,
            ].join(' — '),
            complete: (messages) => completeChat(model, messages),
            onStep: (tool, detail) => {
              const sub2: ThinkingStep = {
                label: `تحقيق: ${TOOL_LABEL_AR[tool] ?? tool}`,
                detail: detail.slice(0, 60),
                state: 'done',
                icon: 'search',
              }
              toolSteps.push(sub2)
              syncSteps()
              emit({ event: 'step', label: sub2.label, state: 'done' })
            },
          })
          // only the SUMMARY enters the parent's context — the intermediate
          // reads stay inside the sub-agent (Claude Code's summary-only return)
          step.detail = sub.summary.slice(0, 80)
          resultsForModel.push({
            tool: 'deep_dive',
            ok: true,
            rounds: sub.rounds,
            tools: sub.toolsUsed,
            summary: sub.summary,
            numbers: sub.facts.slice(0, 8),
          })
          replyParts.push(sub.summary)
          usedTools.push('deep_dive')
          await trackUsage(business.id, user.id, 'tool', 'deep_dive')
          return
        }

        // ---- WRITE tools → drafts (R2/R3 — NEVER auto-executed) ----
        const w = BRAIN_WRITE_TOOLS[call.tool]
        if (w) {
          if (!canDraft(user.role, w.opType)) {
            step.detail = `محتاجة صلاحية أعلى من ${roleTitle(user)}`
            resultsForModel.push({ tool: call.tool, ok: false, error: `صلاحية ${user.name} مش بتسمح بعملية ${TYPE_AR[w.opType] ?? w.opType}` })
            replyParts.push(`عملية ${TYPE_AR[w.opType] ?? w.opType} محتاجة صلاحية أعلى — مش من اختصاصك.`)
            return
          }
          const resolved = await resolveWrite({ ...ctx, text }, { intent: 'write', opType: w.opType, fields: w.fields(call.args) }, emit, memCtx)
          if (!resolved.ok) {
            step.detail = `ناقص: ${resolved.missing ?? ''}`
            resultsForModel.push({
              tool: call.tool,
              ok: false,
              error: `${resolved.failMessage ?? resolved.missing ?? 'ناقصة بيانات'} — العملية دي ماتسجلتش خالص، ولازم تقول للمستخدم كده بصراحة في ردك`,
            })
            replyParts.push(`طلب ناقص بيانات: ${resolved.failMessage ?? resolved.missing ?? ''}`)
            brainFailures.push(resolved.failMessage ?? `ناقص ${resolved.missing ?? 'بيانات'} — ${TYPE_AR[resolved.opType] ?? resolved.opType} ماتسجلتش`)
            return
          }
          const idem = `${business.id}:${user.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
          const reflection = await reflectOnDraft({
            businessId: business.id,
            userId: user.id,
            type: resolved.opType,
            summary: resolved.summary,
            payload: resolved.payload as unknown as Record<string, unknown>,
          })
          const draft = await createDraft({
            risk: reflection.risk,
            businessId: business.id,
            userId: user.id,
            type: resolved.opType,
            summary: resolved.summary,
            payload: resolved.payload,
            conversationId: ctx.conversationId,
            idempotencyKey: idem,
          })
          if (!anyDraft) {
            // the SSE contract has ONE draft-card slot per message — the first
            // draft owns it; later drafts live in the journal + reply text
            anyDraft = true
            draftOpId = draft.id
            draftCard = {
              ...resolved.card,
              ref: draft.ref,
              opId: draft.id,
              audit: reflection.findings,
              confidence: reflection.confidence,
            }
            emit({ event: 'card', card: draftCard })
          }
          brainFacts.push(...[...resolved.card.fields, ...resolved.card.effects].map((f) => ({ label: f.label, value: f.value })))
          void jotNote({
            businessId: business.id,
            userId: user.id,
            conversationId: ctx.conversationId,
            kind: 'todo',
            text: `مسودة ${draft.ref} (${TYPE_AR[resolved.opType] ?? resolved.opType}): ${resolved.summary} — مستنية اعتماد`,
            source: 'draft',
          })
          meta.notesJotted++
          step.detail = resolved.summary.slice(0, 90)
          // R17 «مهمة مجدولة» safety net: a credit sale (آجل) + a PROMISED day
          // in the message («هيديني الباقي يوم الجمعة») → the promise lands on
          // the long-term memory EVEN IF the model forgot to call memory_save
          // itself. The model's own memory_save (if any) always wins — this is
          // the deterministic net, not the competitor.
          if (w.opType === 'sale' && !modelSavedMemory) {
            const p = resolved.payload as { total?: number; paid?: number; customerName?: string }
            const due = typeof p.total === 'number' && typeof p.paid === 'number' ? p.total - p.paid : null
            const party = typeof p.customerName === 'string' ? p.customerName.trim() : ''
            const day = extractPromiseDay(text)
            if (due != null && due > 0 && party && day) {
              const memText = `${party} — الموعد المتفق عليه: باقي ${egp(due)} ${day}`.slice(0, 200)
              const memNorm = normalizeAr(memText)
              const dup = memories.some((m) => normalizeAr(m.text) === memNorm)
              if (!dup) {
                await db.agentMemory.create({
                  data: { businessId: business.id, userId: user.id, kind: 'fact', category: 'promises', text: memText, confidence: 85 },
                })
              }
              step.detail = `${step.detail} + سجلت الموعد (${day})`
              replyParts.push(`وسجلت في ذاكرتي الموعد: ${memText}`)
            }
          }
          resultsForModel.push({ tool: call.tool, ok: true, ref: draft.ref, summary: resolved.summary, note: 'مسودة مستنية اعتماد — مبتنفذش لوحدها', ...(resolved.issues?.length ? { تنبيه: resolved.issues.join('؛ ') } : {}) })
          replyParts.push(`جهزت مسودة «${TYPE_AR[resolved.opType] ?? resolved.opType}» (${draft.ref}): ${resolved.summary} — مستنية اعتمادك.`)
          // A draft can carry a caveat the owner MUST read (e.g. the amount was
          // lowered to the real debt) — it goes through the same failure guard so
          // a chatty model can never bury it.
          if (resolved.issues?.length) brainFailures.push(...resolved.issues)
          await trackUsage(business.id, user.id, 'tool', resolved.opType)
          return
        }
        // ---- memory_save (the model's own long-term learning tool) ----
        if (call.tool === 'memory_save') {
          const memText = String(call.args.text ?? '').trim().slice(0, 200)
          if (memText.length < 3) {
            resultsForModel.push({ tool: 'memory_save', ok: false, error: 'نص فاضي' })
            return
          }
          const memNorm = normalizeAr(memText)
          const isRule = isRuleText(memNorm)
          const dup = memories.some((m) => normalizeAr(m.text) === memNorm)
          if (!dup) {
            await db.agentMemory.create({
              data: {
                businessId: business.id,
                userId: user.id,
                kind: isRule ? 'rule' : 'preference',
                category: isRule ? ruleCategory(memNorm) : preferenceCategory(memNorm),
                text: memText,
                confidence: 80,
              },
            })
          }
          step.detail = dup ? 'موجودة أصلًا — من غير تكرار' : memText.slice(0, 60)
          resultsForModel.push({ tool: 'memory_save', ok: true, saved: true, duplicate: dup })
          replyParts.push(dup ? `دي محفوظة عندي أصلًا ✅ — «${memText}»` : `اتحفظت في ذاكرتي ✅ — «${memText}»`)
          modelSavedMemory = true
          return
        }
        // ---- memory_forget ----
        if (call.tool === 'memory_forget') {
          const q = String(call.args.query ?? call.args.text ?? '').trim()
          const target = findMemoryByReference(q, memories)
          if (target) {
            await db.agentMemory.update({ where: { id: target.id }, data: { active: false, updatedAt: new Date() } })
            step.detail = target.text.slice(0, 60)
            resultsForModel.push({ tool: 'memory_forget', ok: true, forgotten: target.text.slice(0, 80) })
            replyParts.push(`اتمسحت من ذاكرتي ✅ — «${target.text.slice(0, 100)}»`)
          } else {
            step.detail = 'ملقيتش حاجة بالشكل ده'
            resultsForModel.push({ tool: 'memory_forget', ok: false, error: 'ملقيتش حاجة بالشكل ده' })
            replyParts.push('ملقيتش في ذاكرتي حاجة بالشكل ده 🤔')
          }
          return
        }
        // ---- calculate (R18: the model NEVER refuses math) ----
        if (call.tool === 'calculate') {
          const rawExpr = String(call.args.expression ?? call.args.expr ?? call.args.formula ?? call.args.calc ?? '')
          const calc = safeCalculate(rawExpr)
          if (calc.ok) {
            const prettyExpr = toWesternDigits(rawExpr).replace(/\s+/g, ' ').trim().slice(0, 80)
            const valueAr = fmtCalcNumber(calc.value)
            const calcCard: ResultCardDTO = {
              kind: 'kv',
              title: 'الحاسبة',
              rows: [{ label: prettyExpr, value: valueAr }],
            }
            allCards.push(calcCard)
            emit({ event: 'cards', cards: allCards })
            brainFacts.push({ label: prettyExpr, value: valueAr })
            step.detail = `${prettyExpr} = ${valueAr}`
            resultsForModel.push({ tool: 'calculate', ok: true, expression: prettyExpr, value: calc.value })
            replyParts.push(`${prettyExpr} = ${valueAr}`)
          } else {
            step.detail = calc.error
            resultsForModel.push({ tool: 'calculate', ok: false, error: calc.error })
          }
          await trackUsage(business.id, user.id, 'tool', 'calculate')
          return
        }
        // ---- schedule_task (R18 «مهمة مجدولة» — reminders land in the chat) ----
        if (call.tool === 'schedule_task') {
          const title = String(call.args.title ?? call.args.reminder ?? '').trim().slice(0, 140)
          const whenLabel = String(call.args.whenLabel ?? call.args.when ?? '').trim().slice(0, 80)
          if (!title) {
            step.detail = 'عنوان المهمة فاضي'
            resultsForModel.push({ tool: 'schedule_task', ok: false, error: 'title مطلوب' })
            return
          }
          const rawTool = String(call.args.tool ?? '').trim()
          const taskTool = READ_TOOLS.has(rawTool) ? rawTool : 'remind'
          const when = resolveArabicWhen(whenLabel) ?? (() => {
            const d = new Date()
            d.setDate(d.getDate() + 1)
            d.setHours(10, 0, 0, 0)
            return d
          })()
          const whenAr = new Intl.DateTimeFormat('ar-EG', { weekday: 'long', day: 'numeric', month: 'long' }).format(when)
          const task = await db.scheduledTask.create({
            data: {
              businessId: business.id,
              userId: user.id,
              conversationId: ctx.conversationId ?? null,
              title,
              tool: taskTool,
              fields: JSON.stringify(call.args.fields ?? {}),
              whenLabel: whenLabel || whenAr,
              scheduledFor: when,
              recurrence: null,
            },
          })
          step.detail = `${title} — ${whenLabel || whenAr}`
          void jotNote({
            businessId: business.id,
            userId: user.id,
            conversationId: ctx.conversationId,
            kind: 'todo',
            text: `مهمة مجدولة: ${title} (${whenLabel || whenAr})`,
            source: 'scheduled',
          })
          meta.notesJotted++
          resultsForModel.push({ tool: 'schedule_task', ok: true, task: title, when: whenLabel || whenAr })
          replyParts.push(`سجّلت مهمة مجدولة ✅ — «${title}» يوم ${whenLabel || whenAr}، وهفتكرها في وقتها.`)
          await trackUsage(business.id, user.id, 'tool', 'schedule_task')
          return
        }
        // ---- set_persona (R18: the model tunes its own operating tone) ----
        if (call.tool === 'set_persona') {
          const raw = String(call.args.tone ?? call.args.style ?? '').trim()
          const key = toneKey(raw)
          if (!key) {
            step.detail = 'نبرة مش معروفة'
            resultsForModel.push({ tool: 'set_persona', ok: false, error: 'اختار: ودود / رسمي / مختصر' })
            return
          }
          await db.agentSettings.upsert({
            where: { businessId: business.id },
            update: { tone: key, updatedAt: new Date() },
            create: { businessId: business.id, vertical: business.type, tone: key },
          })
          step.detail = TONE_AR[key] ?? key
          resultsForModel.push({ tool: 'set_persona', ok: true, tone: key })
          replyParts.push(`ظبطت نبرتي من دلوقتي ✅ — ${TONE_AR[key] ?? key}.`)
          await trackUsage(business.id, user.id, 'tool', 'set_persona')
          return
        }
        // ---- unknown tool ----
        resultsForModel.push({ tool: call.tool, ok: false, error: 'أداة غير معروفة' })
        step.detail = 'أداة مش معروفة — تجاهلتها'
      } catch (err) {
        console.error('[brain] tool exec failed:', call.tool, err)
        step.detail = 'مشكلة في التنفيذ — كمّلت'
        resultsForModel.push({ tool: call.tool, ok: false, error: 'فشل تنفيذ الأداة' })
      } finally {
        step.state = 'done'
        step.ms = Math.max(0, Date.now() - toolClock)
        syncSteps()
        emit({ event: 'step', label, state: 'done' })
      }
    }

    // ---------- the loop: model ⇄ tools until a final text reply ----------
    let finalText = ''
    try {
      const snapshot = await getSnapshot(business)
      // R18: the persona tone the user/model chose (set_persona writes it) —
      // the brain's OWN system prompt is data the agent controls.
      const settings = await db.agentSettings.findUnique({ where: { businessId: business.id } })
      const baseBrain = buildAgentSystemPrompt({
        business,
        user,
        items,
        customers,
        suppliers,
        memories,
        snapshot,
        history: ctx.history,
        tone: settings?.tone ?? undefined,
      })
      const brainSystem = notesSection ? `${baseBrain}\n\n${notesSection}` : baseBrain
      const convo: LLMMessage[] = [
        { role: 'system', content: brainSystem },
        { role: 'user', content: text },
      ]
      let raw = await completeChat(model, convo)
      let calls = parseBrainReply(raw)
      let totalCalls = 0
      while (calls && totalCalls < 6) {
        rounds++
        convo.push({ role: 'assistant', content: raw.slice(0, 1200) })
        const batch = calls.slice(0, 4)
        // ---- independent reads run CONCURRENTLY; anything that can change the
        // ledger (drafts, memory, scheduling, tone) stays strictly sequential —
        // order is part of the money contract.
        const isSafeParallel = (c: BrainToolCall) =>
          READ_TOOLS.has(c.tool) || c.tool === 'run_plan' || c.tool === 'deep_dive' || c.tool === 'calculate'
        const parallel = batch.filter(isSafeParallel)
        const sequential = batch.filter((c) => !isSafeParallel(c))
        if (parallel.length > 1) {
          await Promise.all(parallel.map((c) => execBrainCall(c)))
          totalCalls += parallel.length
        } else {
          for (const c of parallel) {
            await execBrainCall(c)
            totalCalls++
          }
        }
        for (const c of sequential) {
          if (totalCalls >= 6) break
          await execBrainCall(c)
          totalCalls++
        }
        const last = totalCalls >= 6 || rounds >= 3
        // ---- context pressure, the CHEAP layer first (dsh compaction listener):
        // older tool results are digested instead of re-sent whole to the model.
        const { kept, budget } = budgetToolHistory(resultsForModel, 3)
        if (budget.compressed) void logContextPressure(business.id, user.id, { ...budget, rounds })
        convo.push({
          role: 'user',
          content: `نتايج الأدوات (JSON):\n${
            kept.length === resultsForModel.length
              ? JSON.stringify(kept).slice(0, 2400)
              : `${JSON.stringify(kept).slice(0, 2000)}\n[${resultsForModel.length - kept.length} نتيجة أقدم اتقصّرت للحفاظ على السياق]`
          }\n\n${
            last
              ? 'اكتب ردك النهائي للمستخدم دلوقتي كنص عادي بلا JSON خالص.'
              : 'قرر بنفسك: لو محتاج أدوات تانية رد بـ JSON بنفس الشكل، ولو خلصت اكتب ردك النهائي كنص عادي.'
          }`,
        })
        raw = await completeChat(model, convo)
        calls = parseBrainReply(raw)
      }
      finalText = calls ? '' : raw.trim() // cap reached with pending calls → compose deterministic
      // R18 safety: the model sometimes ECHOES its own tool_calls JSON (plain
      // or escaped) inside the final prose — the user must never see raw JSON.
      finalText = stripToolJson(finalText)
      // GLM-on-Arabic glitch: stray CJK ideographs/kana sometimes leak into
      // Arabic replies («هت 影响 على») — strip them deterministically (the
      // brain's language is Arabic/English only, never Chinese/Japanese).
      finalText = finalText
        .replace(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g, '')
        .replace(/ {2,}/g, ' ')
        .trim()
    } catch (err) {
      console.error('[brain] loop failed → fallback ladder:', err)
      if (!executedAnyTool) return null // clean bail-out — PASS 1 re-handles the turn
      finalText = '' // tools ran → finish here, deterministically
    }

    // ---------- «الدقة»: a model that only TALKED cannot override the ledger --
    // Live evidence (2026-10-17, preview host): a thin provider answered «بعت ٢
    // علبة زيت … بـ٦٥٠» with fluent prose — «جهّزتلك كارت العملية» — while NO
    // tool ran and nothing was drafted, and answered «أنا بربح كام؟» with small
    // talk instead of the real margin table. The rules are decisive on both, and
    // the deterministic engine has the exact numbers, so when a turn ends with
    // ZERO tool calls and the rule ladder knows what this request IS, we hand the
    // turn to the proven PASS-1 pipeline instead of shipping prose that lies.
    if (!executedAnyTool && usedTools.length === 0 && !anyDraft) {
      const rule = ruleBasedIntent(text, business.type)
      const decisiveRead = rule.intent === 'read' && !!rule.tool
      const decisiveWrite = rule.intent === 'write' && !!rule.opType && VALID_OP_TYPES.has(rule.opType)
      // …and the OTHER deterministic lanes: «افتكر إن…» (memory), a shop rule,
      // and «انت مين» must reach their handlers instead of being answered with a
      // model sentence that does none of them (live R29: the owner asked the
      // agent to remember a payment habit and got small talk back).
      const deterministicLane =
        decisiveRead ||
        decisiveWrite ||
        !!extractSaveRequest(text, norm) ||
        !!extractRuleRequest(text, norm) ||
        isIdentityQuestion(norm)
      if (deterministicLane) return null
    }

    // ---------- «مفيش رقم بيدخل غلط»: a FAILED tool may not be glossed over ----
    // Live evidence (R29): «حصلت ٢٠٠ من أم حسن» while she owed ١٢٥ → the tool
    // refused (correct) but the model answered with a friendly «قولّي تحب نعمل
    // إيه» and the owner never learned the operation was rejected. Any tool
    // failure the model's prose does not acknowledge is stated verbatim.
    if (brainFailures.length > 0) {
      const digitGroups = (t: string) => (toWesternDigits(t).match(/[0-9]+/g) ?? []).filter((d) => d.length >= 2)
      const told = brainFailures.every((f) => {
        if (finalText.includes(f.slice(0, 24))) return true
        const g = digitGroups(f)
        return g.length > 0 && g.some((d) => toWesternDigits(finalText).includes(d))
      })
      if (!told) {
        finalText = [finalText.trim(), ...brainFailures].filter(Boolean).join('\n\n')
        meta.fallback = true
      }
    }

    // ---------- «الدقة»: the SAME grounding contract the deterministic path
    // enforces, applied to the brain lane. Live R29: the model answered «أكيد —
    // دي بيانات السجل الحقيقي» while the card above it said «ملقيتش عميل
    // بالاسم «أحمد»» — the owner reads the sentence first, so a reply that
    // ignores its own cards/verdict is replaced by the deterministic composer.
    // (the cast defeats TS's closure-blind narrowing — `draftCard` is assigned
    //  inside execBrainCall, so control-flow analysis still believes it is null)
    const draftSnapshot = draftCard as ActionCardDTO | null
    const brainDraftContract = draftSnapshot
      ? `جهزتلك مسودة «${draftSnapshot.title}» — ${draftSnapshot.summary}. راجعها واعتمدها لو تمام.${draftSnapshot.dangerNote ? `\n${draftSnapshot.dangerNote}` : ''}`
      : null
    if (finalText.trim() && draftSnapshot && brainDraftContract) {
      const t2 = toWesternDigits(normalizeAr(finalText))
      const refOk = !!draftSnapshot.ref && t2.includes(draftSnapshot.ref)
      const words = toWesternDigits(normalizeAr(draftSnapshot.summary))
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= 4)
      const grounded = refOk || words.some((w) => t2.includes(w))
      if (!grounded) {
        finalText = brainDraftContract
        meta.fallback = true
      }
    } else if (
      finalText.trim() &&
      allCards.length > 0 &&
      (isCannedReply(finalText) || !replyGroundsCards(finalText, [allCards[0]], text))
    ) {
      finalText = deterministicReadReply(allCards)
      meta.fallback = true
    }

    // ---------- final reply: verify BEFORE streaming, then pace it ----------
    if (!finalText.trim()) {
      meta.fallback = true
      if (replyParts.length === 0) {
        if (!executedAnyTool) return null
        finalText = 'عملت اللي قدرت عليه من طلبك — الباقي في الكروت تحت.'
      } else {
        finalText = replyParts.map((p, i) => `${AR_ORDINALS[i]}، ${p}`).join('\n\n')
      }
    }
    meta.kind = usedTools.length > 0 || anyDraft ? 'chat' : 'advisory'
    stampUnderstand()
    const verifyClock = Date.now()
    const brainVerified = verifyReply(finalText, brainFacts)
    const verifiedText = brainVerified.text
    const vi = 1 + memStep.length + toolSteps.length
    if (steps[vi]) {
      steps[vi].state = 'done'
      steps[vi].ms = Math.max(0, Date.now() - verifyClock)
      steps[vi].detail =
        brainFacts.length > 0
          ? brainVerified.verified.status === 'corrected'
            ? 'لقيت رقم مش مطابق — اتصلح قبل ما يوصلك'
            : 'اتأكدت الأرقام من السجل'
          : 'مفيش أرقام سجل في الرد ده'
    }
    verifyMs = steps[vi]?.ms
    if (steps[vi + 1]) steps[vi + 1].state = 'done'
    pushThinking()
    const replyClock = Date.now()
    await streamDeterministic(verifiedText, emit, REPLY_PACING_BUDGET_MS)
    // final trace: the composing pass gets its real duration only after the
    // last character left the wire — the UI then shows where the time went.
    replyMs = Math.max(0, Date.now() - replyClock)
    if (steps[vi + 1]) {
      steps[vi + 1].ms = replyMs
      steps[vi + 1].state = 'done'
    }
    pushThinking()

    // ---------- deep-link actions (draft first, then tools) ----------
    const merged = new Map<string, ChatActionDTO>()
    if (anyDraft) merged.set('journal', DRAFT_ACTIONS[0])
    for (const t of usedTools) {
      for (const a of TOOL_ACTIONS[t] ?? []) {
        if (!merged.has(a.view)) merged.set(a.view, a)
      }
    }
    const brainActions = [...merged.values()].slice(0, 3)
    if (brainActions.length > 0) emit({ event: 'actions', actions: brainActions })

    await bumpMemoryUsage(memCtx.referencedIds)
    return {
      replyText: verifiedText,
      card: draftCard,
      cards: allCards.length > 0 ? allCards : null,
      thinking: steps,
      modelLabel,
      opId: draftOpId,
      actions: brainActions.length > 0 ? brainActions : null,
      verified: brainVerified.verified,
    }
  }

  const brainTurn = await runBrainTurn()
  if (brainTurn) return brainTurn

  // ---- PASS 1: Understand (LLM with deterministic multi-split + rule fallback) ----
  let llmRaws: RawIntentJson[] = []
  let llmSingle: ExtractedIntent | null = null
  try {
    const baseSystem = buildSystemPrompt({ business, user, items, customers, suppliers, memories: promptMemories, rules, history: ctx.history, userToolsLine })
    // «ورقة وقلم» — the employee's OWN working notes ride along every prompt
    const system = notesSection ? `${baseSystem}\n\n${notesSection}` : baseSystem
    const raw = await completeChat(model, [
      { role: 'system', content: system },
      { role: 'user', content: text },
    ])
    const parsed = parseIntentJsonMulti(raw)
    llmRaws = parsed.intents
    llmSingle = parsed.single
    done(IDX.understand, llmSingle?.replyHint ? `فهمت: ${llmSingle.replyHint}` : llmRaws.length >= 2 ? `فهمت ${llmRaws.length} طلبات في رسالة واحدة` : 'فهمت الطلب')
  } catch (err) {
    console.error('[harness] intent pass failed → rule-based fallback:', err)
    done(IDX.understand, 'فهمت الطلب بالقواعد المحلية (الموديل مش متاح)')
  }

  // Deterministic compound split — beats a single-LLM read when the user
  // stacked requests («ملخص اليوم ومين عليها فلوس وايه الناقص»).
  const detSubs = splitSubIntents(text, business.type)

  let subs: SubIntent[] = []
  if (llmRaws.length >= 2) {
    subs = normalizeMultiIntents(llmRaws, text)
    if (subs.length === 1) {
      // the array collapsed to one valid request → single path with it
      const only = subs[0]
      llmSingle = { intent: only.intent, tool: only.tool, opType: only.opType, fields: only.fields, replyHint: only.replyHint }
      subs = []
    }
  } else if (detSubs.length >= 2) {
    subs = detSubs.map((s) => ({ ...s }))
    // if the LLM single intent is the same write as the leading sub, prefer its fields
    if (llmSingle?.intent === 'write' && subs[0].intent === 'write') {
      subs[0] = { ...llmSingle, intent: 'write', opType: subs[0].opType, sourceText: subs[0].sourceText, fields: { ...llmSingle.fields, ...subs[0].fields } }
    }
  } else if (detSubs.length === 1 && detSubs[0].intent === 'write' && llmSingle?.intent === 'read') {
    // leading READ + trailing write the LLM caught («ملخص اليوم وبعت 10 عود»)
    subs = [detSubs[0], { intent: 'write', opType: llmSingle.opType, fields: llmSingle.fields, sourceText: text }]
  } else {
    // «موثوقية» — a clear write instruction must never be downgraded to
    // chit-chat just because the model answered with prose: a flaky provider,
    // a garbled JSON block or a small model that ignored the schema must not
    // cost the owner his sale. The deterministic ladder is the LAST word on
    // «this is a sale»; the model is the first word (its write reads still win).
    const rule = ruleBasedIntent(text, business.type)
    const ruleIsWrite = rule.intent === 'write' && !!rule.opType && VALID_OP_TYPES.has(rule.opType)
    const ruleIsRead = rule.intent === 'read' && !!rule.tool
    // A model that answered «chat» said «no tools needed» — but when the
    // deterministic ladder is POSITIVE that this sentence needs a tool, the
    // ladder wins. Live R29 evidence: «ايه اللي ناقص عندي؟», «الجبنة الرومي عندي
    // كام كيلو؟» and «عمرو عضويته باقي قد إيه؟» all came back as a cheerful «قولّي
    // تحب نعمل إيه» while list_low_stock / get_item_stock / get_member_status were
    // sitting right there. Exception: opinion/advice questions stay chat — they
    // are conversations, not lookups.
    const looksConversational = /(رايك|رأيك|تنصحني|نصيحه|نصائح|اعمل ايه|ايه رايك|شايف ايه|استشاره|بتفكر في ايه)/.test(normalizeAr(text))
    if (ruleIsWrite && llmSingle?.intent !== 'write') {
      llmSingle = rule
    } else if (ruleIsRead && llmSingle?.intent === 'chat' && !looksConversational) {
      llmSingle = rule
    } else if (!llmSingle) {
      llmSingle = rule
    }
  }

  // ---- PASS 2+3: Act ----
  let situation = ''
  let card: ActionCardDTO | null = null
  let cards: ResultCardDTO[] | null = null
  let opId: string | undefined
  let replyInstruction = ''
  let questionMode = false
  let actions: ChatActionDTO[] | null = null
  let permissionDenied = false
  let permissionMsg = ''
  let draftIssues: string[] | null = null
  let advisoryMode = false
  let advisorySystem = ''
  /** multi-intent: per-part deterministic replies (the guaranteed fallback) */
  let multiReplyParts: string[] | null = null
  let multiOverflow = 0
  /** R15: ground-truth numbers from this turn's tools/cards/drafts — the
   *  self-verification basis («الأرقام الوحيدة اللي الوكيل مسموح يقولها») */
  const turnFacts: VerifyFact[] = []

  if (subs.length >= 2) {
    // ================= MULTI-INTENT TURN =================
    const N = subs.length
    const overflow = N - Math.min(N, 4)
    const capped = subs.slice(0, 4)
    // rebuild the thinking array with per-sub steps («١/٣: ملخص اليوم»)
    const subSteps: ThinkingStep[] = capped.map((s, i) => ({
      label: `${AR_ORDINALS[i]}/${toArabicNum(Math.min(N, 4))}: ${s.tool ? TOOL_LABEL_AR[s.tool] ?? s.tool : TOOL_LABEL_AR[s.opType ?? ''] ?? s.opType ?? ''}`,
      detail: s.sourceText.slice(0, 40),
      state: 'pending' as const,
      icon: 'search' as const,
    }))
    steps.length = 0
    steps.push(
      { label: 'بفهم طلبك', detail: `رسالة فيها ${N} طلبات — هعملهم كلهم بالترتيب`, state: 'done', icon: 'understand' },
      ...memStep,
      ...subSteps,
      { label: 'بتحقق من الأرقام', detail: 'بحسب من الأسعار الفعلية مش من دماغي', state: 'pending', icon: 'verify' },
      { label: 'بجهّز الرد', detail: '', state: 'pending', icon: 'plan' },
    )
    const verifyIdx = 1 + memStep.length + subSteps.length
    const replyIdx = verifyIdx + 1
    pushThinking()

    const allCards: ResultCardDTO[] = []
    const situationParts: string[] = []
    const replyParts: string[] = []
    const usedTools: string[] = []
    let anyDraft = false

    for (let i = 0; i < capped.length; i++) {
      const sub = capped[i]
      const stepLabel = subSteps[i].label
      steps[1 + memStep.length + i].state = 'active'
      pushThinking()
      emit({ event: 'step', label: stepLabel, state: 'active' })

      if (sub.intent === 'read' && sub.tool) {
        const subCards = await runReadTool(sub.tool as ReadTool, business.id, sub.fields ?? {})
        allCards.push(...subCards)
        // growing array — the frontend card buffer REPLACES on each cards event
        emit({ event: 'cards', cards: allCards })
        usedTools.push(sub.tool)
        // R15: ground-truth facts + scratchpad jot («ورقة وقلم»)
        turnFacts.push(...factsFromCards(subCards))
        meta.notesJotted += jotFactsFromCards(
          { businessId: business.id, userId: user.id, conversationId: ctx.conversationId },
          subCards,
        )
        const label = TOOL_LABEL_AR[sub.tool] ?? sub.tool
        situationParts.push(`الطلب ${AR_ORDINALS[i]}/${Math.min(N, 4)} (${label}) — نفذت أداة ${sub.tool} ودي النتايج:\n${JSON.stringify(subCards).slice(0, 900)}`)
        replyParts.push(deterministicReadReply(subCards))
        await trackUsage(business.id, user.id, 'tool', sub.tool === 'search_catalog' || sub.tool === 'get_item_stock' ? `${sub.tool}:${String(sub.fields?.query ?? sub.fields?.name ?? '')}` : sub.tool)
      } else if (sub.intent === 'write' && sub.opType) {
        const opType = sub.opType
        if (!canDraft(user.role, opType)) {
          steps[1 + memStep.length + i].state = 'done'
          pushThinking()
          emit({ event: 'step', label: stepLabel, state: 'done' })
          situationParts.push(`الطلب ${AR_ORDINALS[i]}/${Math.min(N, 4)} — عملية ${TYPE_AR[opType] ?? opType} محتاجة صلاحية أعلى من صلاحية ${user.name} (${roleTitle(user)}) — ولا حاجة اتنفذت.`)
          replyParts.push(`عملية ${TYPE_AR[opType] ?? opType} محتاجة صلاحية أعلى (المالك أو المشرف) — مش من اختصاصك.`)
          continue
        }
        const resolved = await resolveWrite({ ...ctx, text: sub.sourceText }, { intent: 'write', opType, fields: sub.fields ?? {}, replyHint: sub.replyHint }, emit, memCtx)
        if (!resolved.ok) {
          steps[1 + memStep.length + i].state = 'done'
          pushThinking()
          emit({ event: 'step', label: stepLabel, state: 'done' })
          situationParts.push(`الطلب ${AR_ORDINALS[i]}/${Math.min(N, 4)} — ناقص ${resolved.missing ?? ''}: ${resolved.failMessage ?? ''}`)
          replyParts.push(`طلب رقم ${AR_ORDINALS[i]} ناقص بيانات: ${resolved.failMessage ?? resolved.missing ?? ''}`)
          continue
        }
        const idem = `${business.id}:${user.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
        const reflection = await reflectOnDraft({
          businessId: business.id,
          userId: user.id,
          type: resolved.opType,
          summary: resolved.summary,
          payload: resolved.payload as unknown as Record<string, unknown>,
        })
        const draft = await createDraft({
          risk: reflection.risk,
          businessId: business.id,
          userId: user.id,
          type: resolved.opType,
          summary: resolved.summary,
          payload: resolved.payload,
          conversationId: ctx.conversationId,
          idempotencyKey: idem,
        })
        if (!opId) {
          // the SSE contract has ONE draft-card slot per message — the first
          // draft owns it; later drafts stay in the journal + reply text
          opId = draft.id
          card = {
            ...resolved.card,
            ref: draft.ref,
            opId: draft.id,
            audit: reflection.findings,
            confidence: reflection.confidence,
          }
          emit({ event: 'card', card })
        }
        anyDraft = true
        await trackUsage(business.id, user.id, 'tool', resolved.opType)
        // R15: draft numbers join the ground truth + a scratchpad todo note
        turnFacts.push(
          ...[...resolved.card.fields, ...resolved.card.effects].map((f) => ({ label: f.label, value: f.value })),
        )
        void jotNote({
          businessId: business.id,
          userId: user.id,
          conversationId: ctx.conversationId,
          kind: 'todo',
          text: `مسودة ${draft.ref} (${TYPE_AR[resolved.opType] ?? resolved.opType}): ${resolved.summary} — مستنية اعتماد`,
          source: 'draft',
        })
        meta.notesJotted++
        situationParts.push(`الطلب ${AR_ORDINALS[i]}/${Math.min(N, 4)} — اتعملت مسودة رقم ${draft.ref} (${resolved.summary}) مستنية اعتماد المستخدم${resolved.card.dangerNote ? `، وفيها تحذير: ${resolved.card.dangerNote}` : ''}. مفيش حاجة اتنفذت لسه.`)
        replyParts.push(`جهزت مسودة «${TYPE_AR[resolved.opType] ?? resolved.opType}» (${draft.ref}): ${resolved.summary} — مستنية اعتمادك.`)
      }
      steps[1 + memStep.length + i].state = 'done'
      pushThinking()
      emit({ event: 'step', label: stepLabel, state: 'done' })
    }

    if (allCards.length > 0) cards = allCards
    multiReplyParts = replyParts
    multiOverflow = overflow
    // R15: deferred sub-requests land on the scratchpad as todos — the paper
    // keeps them alive across turns instead of losing them in the scroll
    if (overflow > 0) {
      const deferred = subs
        .slice(4)
        .map((s) => s.sourceText.slice(0, 60))
        .join('؛ ')
      void jotNote({
        businessId: business.id,
        userId: user.id,
        conversationId: ctx.conversationId,
        kind: 'todo',
        text: `مهمات مؤجلة من رسالة متعددة (${toArabicNum(overflow)}): ${deferred}`,
        source: 'multi-intent',
      })
      meta.notesJotted++
    }
    done(verifyIdx, N > 4 ? `${toArabicNum(Math.min(N, 4))} طلبات اتجاوب عليهم — والباقي ${toArabicNum(overflow)}` : 'كل الأرقام من قاعدة البيانات مباشرة')
    done(replyIdx)

    situation = `المستخدم بعت رسالة فيها ${N} طلبات. ${situationParts.join('\n\n')}`
    replyInstruction = `جاوب على كل طلب منهم بالترتيب${overflow > 0 ? ` (خدت أول ٤ — قول له إن ${overflow} طلب${overflow === 1 ? '' : 'ات'} تاني${overflow === 1 ? '' : 'ن'} مستنيين)` : ''}. ابدأ كل جزء برقم عربي ونقطة (١. ٢. ٣.) وسيب سطر فاضي بين كل جزء والتاني. كل الأرقام من «الوضع الحالي» بس. متختلقش أي رقم.`
    // merged actions: max 3, most relevant (dedup by view; drafts first)
    const merged = new Map<string, ChatActionDTO>()
    if (anyDraft) merged.set('journal', DRAFT_ACTIONS[0])
    for (const t of usedTools) {
      for (const a of TOOL_ACTIONS[t] ?? []) {
        if (!merged.has(a.view)) merged.set(a.view, a)
      }
    }
    actions = [...merged.values()].slice(0, 3)
  } else if (llmSingle && llmSingle.intent === 'read' && llmSingle.tool) {
    // ================= SINGLE READ =================
    const tool = llmSingle.tool as ReadTool
    emit({ event: 'step', label: `بشغّل أداة ${tool}`, state: 'active' })
    done(IDX.search, 'لقيت البيانات في السجل')
    cards = await runReadTool(tool, business.id, llmSingle.fields ?? {})
    emit({ event: 'cards', cards })
    emit({ event: 'step', label: `بشغّل أداة ${tool}`, state: 'done' })
    done(IDX.verify, 'الأرقام جاية من قاعدة البيانات مباشرة')
    // R15: ground-truth facts + scratchpad jot («ورقة وقلم»)
    turnFacts.push(...factsFromCards(cards))
    meta.notesJotted += jotFactsFromCards(
      { businessId: business.id, userId: user.id, conversationId: ctx.conversationId },
      cards,
    )
    situation = `شغّلت أداة القراءة ${tool} ودي النتايج:\n${JSON.stringify(cards, null, 1).slice(0, 1600)}`
    replyInstruction = 'لخّص النتيجة للمستخدم بالمصري بأرقامها الصحيحة من الجدول فوق. لو مفيش بيانات قول كده بصراحة.'
    const hint = proactiveHintFor(tool, cards)
    if (hint) replyInstruction += ` ${hint}`
    actions = TOOL_ACTIONS[tool] ?? null
    await trackUsage(business.id, user.id, 'tool', tool === 'search_catalog' || tool === 'get_item_stock' ? `${tool}:${String(llmSingle.fields?.query ?? llmSingle.fields?.name ?? '')}` : tool)
  } else if (llmSingle && llmSingle.intent === 'write' && llmSingle.opType) {
    // ================= SINGLE WRITE (draft/approval path) =================
    const opType = llmSingle.opType as OpType
    if (!canDraft(user.role, opType)) {
      permissionDenied = true
      permissionMsg = `عملية «${TYPE_AR[opType] ?? opType}» محتاجة صلاحية أعلى — صلاحية ${user.name} (${roleTitle(user)}) مش بتسمح بتسجيلها. دي من اختصاص صاحب المنشأة أو المشرف بس، ولا حاجة اتنفذت.`
      situation = `المستخدم (${user.role} — ${roleTitle(user)}) مش مسموحله يسجّل ${TYPE_AR[opType] ?? opType}. العملية دي بتتسجل من المالك أو المشرف بس.`
      replyInstruction = 'وضّح بذوق إن العملية دي محتاجة صلاحية أعلى (المالك أو المشرف) ومتشغلش أي أداة. أكّد إن مفيش حاجة اتنفذت.'
      done(IDX.search, 'راجعت الصلاحيات — العملية دي مش من نصيبك')
      done(IDX.verify, 'ولا حاجة اتنفذت — الخزنة والمخزون زي ما هما')
    } else {
      done(IDX.search, 'بمشي على الأصناف والأسماء الحقيقية')
      const resolved = await resolveWrite(ctx, llmSingle, emit, memCtx)
      if (!resolved.ok) {
        done(IDX.verify, resolved.failMessage ?? '')
        situation = `معلومات ناقصة: ${resolved.missing ?? ''} — ${resolved.failMessage ?? ''}`
        replyInstruction = 'اسأل سؤال واحد قصير يطلب أهم حقل ناقص. متاخدش أي قرار.'
        questionMode = true
        // R15: an ambiguous request lands on the paper as a HYPOTHESIS — the
        // employee notes what he THINKS the user wants before asking
        void jotNote({
          businessId: business.id,
          userId: user.id,
          conversationId: ctx.conversationId,
          kind: 'hypothesis',
          text: `طلب غامض — ناقص ${resolved.missing ?? 'بيانات'}: ${resolved.failMessage ?? ''}`,
          source: 'resolve',
        })
        meta.notesJotted++
      } else {
        done(IDX.verify, `حسبت الإجمالي من السعر الحقيقي: ${resolved.summary}`)
        emit({ event: 'step', label: `بجهّز مسودة ${TYPE_AR[resolved.opType]}`, state: 'active' })
        const idem = `${business.id}:${user.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
        // «تأمل» — self-critique BEFORE the draft exists, so the card carries
        // the doubt (and a dangerous draft can be escalated to R3).
        const reflection = await reflectOnDraft({
          businessId: business.id,
          userId: user.id,
          type: resolved.opType,
          summary: resolved.summary,
          payload: resolved.payload as unknown as Record<string, unknown>,
        })
        if (reflection.findings.length > 0) {
          emit({ event: 'step', label: `راجعت المسودة من سجلك — ${reflection.findings.length} ملاحظة`, state: 'done' })
        }
        const draft = await createDraft({
          risk: reflection.risk,
          businessId: business.id,
          userId: user.id,
          type: resolved.opType,
          summary: resolved.summary,
          payload: resolved.payload,
          conversationId: ctx.conversationId,
          idempotencyKey: idem,
        })
        opId = draft.id
        card = {
          ...resolved.card,
          ref: draft.ref,
          opId: draft.id,
          audit: reflection.findings,
          confidence: reflection.confidence,
        }
        emit({ event: 'card', card })
        emit({ event: 'step', label: `بجهّز مسودة ${TYPE_AR[resolved.opType]}`, state: 'done' })
        const auditLine =
          reflection.findings.length > 0
            ? ` و«تأمل وكيل» لقى ${reflection.findings.length} ملاحظة لازم تتنقل للمستخدم: ${reflection.findings.map((f) => `${f.message}${f.detail ? ` (${f.detail})` : ''}`).join(' · ')}.`
            : ''
        const escalated = reflection.risk === 'R3' && (resolved.card.risk !== 'R3')
        situation = `اتعملت مسودة عملة رقم ${draft.ref} (${resolved.summary}) مستنية اعتماد المستخدم. درجة الخطورة ${draft.risk}${escalated ? ' (اترفعت لـR3 بسبب ملاحظة «تأمل وكيل»)' : ''}. مفيش حاجة اتنفذت في الخزنة أو المخزون لسه.${resolved.card.dangerNote ? ` وفيها تحذير مهم: ${resolved.card.dangerNote}` : ''}${auditLine}`
        replyInstruction = `اكتب تأكيد قصير إن المسودة جاهزة بالأرقام الصح وإنها مستنية اعتماده${draft.risk === 'R3' ? '، وذكّره إنها عملية حساسة محتاجة سبب' : ''}.${resolved.card.dangerNote ? ' واقفل بتحذير القانون اللي ظهر في المسودة.' : ''}${reflection.findings.length > 0 ? ' ونبّه بصراحة على ملاحظات «تأمل وكيل» واحدة واحدة وبأرقامها — متخبيهاش ومتقلقش المستخدم زياده عن اللزوم.' : ''} خليك مختصر.`
        // Multi-item drafts with lines that could NOT be drafted — NEVER silent:
        // the reply must explicitly name them and why.
        if (resolved.issues && resolved.issues.length > 0) {
          situation += ` بس فيه أصناف اتمسك معاها: ${resolved.issues.join('؛ ')}.`
          replyInstruction += ` وبعدين نبّه صراحة على الأصناف اللي مش ضمن المسودة وسببها: ${resolved.issues.join('؛ ')} — لو عايز يسجلها يبعتها في رسالة لوحدها.`
          draftIssues = resolved.issues
        }
        actions = DRAFT_ACTIONS
        await trackUsage(business.id, user.id, 'tool', resolved.opType)
        // R15: draft numbers join the ground truth + a scratchpad todo note
        turnFacts.push(
          ...[...resolved.card.fields, ...resolved.card.effects].map((f) => ({ label: f.label, value: f.value })),
        )
        void jotNote({
          businessId: business.id,
          userId: user.id,
          conversationId: ctx.conversationId,
          kind: 'todo',
          text: `مسودة ${draft.ref} (${TYPE_AR[resolved.opType] ?? resolved.opType}): ${resolved.summary} — مستنية اعتماد`,
          source: 'draft',
        })
        meta.notesJotted++
      }
    }
  } else {
    // ================= ADVISORY FREE-CHAT («موظف حقيقي») =================
    advisoryMode = true
    meta.kind = 'advisory'
    done(IDX.understand, 'سؤال عن الشغل — بجمع سياقك الحقيقي')
    done(IDX.search, 'بجمع أرقام شغلك من السجل')
    const snapshot = await getSnapshot(business)
    done(IDX.verify, 'الأرقام من قاعدة البيانات بس — مفيش تخمين')
    // R15: the snapshot numbers ARE the verification ground truth here
    turnFacts.push(
      { label: 'مبيعات النهاردة', value: egp(snapshot.salesToday) },
      { label: 'تحصيلات النهاردة', value: egp(snapshot.collectionsToday) },
      { label: 'مصروفات النهاردة', value: egp(snapshot.expensesToday) },
      { label: 'رصيد الخزنة', value: egp(snapshot.cash) },
      { label: 'أصناف ناقصة', value: String(snapshot.lowStockCount) },
      { label: 'مديونيات العملاء', value: egp(snapshot.receivablesTotal) },
      { label: 'عمليات مستنية اعتماد', value: String(snapshot.pendingCount) },
    )
    // «ورقة وكيل» rides along the advisory prompt too — the paper is alive
    const baseAdvisory = buildAdvisoryPrompt({ business, user, snapshot, memories, history: ctx.history })
    advisorySystem = notesSection ? `${baseAdvisory}\n\n${notesSection}` : baseAdvisory
    situation = `سؤال عام عن الشغل (استشارة). سياق حقيقي: مبيعات النهاردة ${egp(snapshot.salesToday)}، خزنة ${egp(snapshot.cash)}، ${snapshot.lowStockCount} صنف ناقص، مديونيات ${egp(snapshot.receivablesTotal)}، ${snapshot.pendingCount} عملية مستنية.`
    replyInstruction = 'انصحه كموظف شاطر بالمصري — ودود ودافئ.'
    for (const m of memories) memCtx.referencedIds.push(m.id)
  }

  // ---- PASS 4: Explain (letter-by-letter, ADAPTIVE pacing) ----
  let replyText = ''
  /** R15: self-verification ledger of this turn (filled in PASS 4.5) */
  let verifiedLedger: VerifyDTO | null = null
  const pacer: PacerState = { t0: null, emitted: 0 }
  // NOTE: the reply pass MUST carry a trailing user turn — providers reject a
  // conversation that is only a system/assistant prompt (z-ai: code 1214).
  const messages: LLMMessage[] = advisoryMode
    ? [
        { role: 'system', content: advisorySystem },
        { role: 'user', content: text },
      ]
    : [
        { role: 'system', content: buildReplyPrompt({ business: { name: business.name, type: business.type }, userName: user.name, situation, instruction: replyInstruction }) },
        { role: 'user', content: 'اكتب ردك النهائي دلوقتي بناءً على الوضع الحالي والمطلوب فوق.' },
      ]

  // Snapshot of the draft for the reply pass: TypeScript's control-flow
  // analysis narrows `card` to null across the chain below (it cannot see the
  // PASS-2 assignment through `multiReplyParts`), so the reply decision reads a
  // fresh binding instead of fighting the narrowing.
  const draftCardForReply = card as ActionCardDTO | null

  if (multiReplyParts) {
    // ============ MULTI-INTENT: BUFFERED reply pass ============
    // The contract is «يجاوب على الكل» with numbered sections — the streamed
    // text and the persisted text must BOTH be the complete answer. So the
    // LLM reply is buffered first, VERIFIED to answer every part, and only
    // the final chosen text is streamed letter-by-letter. A mid-stream death,
    // a truncated reply, or a model that ignored the ١. ٢. ٣. numbering falls
    // back to the deterministic numbered answer — live == persisted == كامل.
    let collected = ''
    try {
      for await (const chunk of streamChat(model, messages)) {
        if (chunk.type !== 'content') continue
        collected += chunk.text
      }
    } catch (err) {
      console.error('[harness] multi-intent reply stream failed → deterministic numbered reply:', err)
    }
    const acceptable = collected.trim().length > 0 && replyAnswersAllParts(collected, Math.min(subs.length, 4))
    if (!acceptable) meta.fallback = true
    replyText = acceptable ? collected.trim() : deterministicMultiReply(multiReplyParts, multiOverflow)
    // R15: buffered text is fully known → verify BEFORE it streams (the user
    // only ever sees checked numbers on multi-intent turns)
    const multiVerified = verifyReply(replyText, turnFacts)
    replyText = multiVerified.text
    verifiedLedger = multiVerified.verified
    await streamDeterministic(replyText, emit, REPLY_PACING_BUDGET_MS)
  } else if (draftCardForReply) {
    // ============ DRAFT TURN: the reply is a CONTRACT ============
    // It must name the operation, the amount and the approval requirement. That
    // sentence already exists, deterministically, in the house voice — asking a
    // model to paraphrase it can only add latency and contradiction («مفيش
    // عملية محددة» next to a draft card, live 2026-10-17). One round trip less,
    // zero chance of prose that disagrees with the money.
    const contract = `جهزتلك مسودة «${draftCardForReply.title}» — ${draftCardForReply.summary}. راجعها واعتمدها لو تمام.${draftCardForReply.dangerNote ? `\n${draftCardForReply.dangerNote}` : ''}${draftIssues ? ` بس خد بالك: ${draftIssues.join('؛ ')}.` : ''}`
    const contractVerified = verifyReply(contract, turnFacts)
    replyText = contractVerified.text
    verifiedLedger = contractVerified.verified
    await streamDeterministic(replyText, emit, REPLY_PACING_BUDGET_MS)
  } else if (cards && cards.length > 0) {
    // ============ READ TURN: the model may phrase it — if it is GROUNDED ====
    // Buffered (like the multi-intent path): a reply that never touches a
    // single figure from the cards is replaced by the deterministic read
    // summary. The user reads text and card together; they must agree.
    let collected = ''
    try {
      for await (const chunk of streamChat(model, messages)) {
        if (chunk.type !== 'content') continue
        collected += chunk.text
      }
    } catch (err) {
      console.error('[harness] read reply stream failed → deterministic read reply:', err)
      meta.fallback = true
    }
    // Grounding is checked against the PRIMARY card (cards[0]) — the one that
    // answers the question. A reply that quotes a number from a SIDE card while
    // the asked card says something else is not an answer (live R29: a customer
    // file question was answered with «وفيها أرقام زي ٩٨١٥» from another card).
    const grounded =
      collected.trim().length > 0 && !isCannedReply(collected) && replyGroundsCards(collected, [cards[0]], text)
    if (!grounded) {
      if (collected.trim().length > 0) meta.fallback = true
      replyText = deterministicReadReply(cards)
    } else {
      replyText = collected.trim()
    }
    const readVerified = verifyReply(replyText, turnFacts)
    replyText = readVerified.text
    verifiedLedger = readVerified.verified
    await streamDeterministic(replyText, emit, REPLY_PACING_BUDGET_MS)
  } else {
    try {
      for await (const chunk of streamChat(model, messages)) {
        if (chunk.type !== 'content') continue
        replyText += chunk.text
        // Re-pace into tiny letter-by-letter deltas — adaptively: total pacing
        // is capped by the budget; a slow provider gets the 3ms floor instead.
        // [\s\S] keeps the model's own line breaks alive in the stream
        // (plain `.` drops \n; ES2017 target forbids the dotAll `s` flag).
        const pieces = chunk.text.match(/[\s\S]{1,2}/g) ?? []
        for (let i = 0; i < pieces.length; i++) {
          emit({ event: 'delta', text: pieces[i] })
          pacer.emitted++
          await sleep(adaptivePieceDelay(pacer, pieces.length - i - 1))
        }
      }
    } catch (err) {
      console.error('[harness] reply stream failed:', err)
      meta.fallback = true
      if (!replyText) {
        const fallback = advisoryMode
          ? advisoryFallback(v)
          : card
            ? `جهزتلك مسودة «${card.title}» — ${card.summary}. راجعها واعتمدها لو تمام.${card.dangerNote ? `\n${card.dangerNote}` : ''}${draftIssues ? ` بس خد بالك: ${draftIssues.join('؛ ')}.` : ''}`
            : cards
              ? deterministicReadReply(cards)
              : questionMode
                ? (situation.match(/— (.+)$/)?.[1] ?? 'محتاج تفاصيل أكتر لو سمحت.')
                : permissionDenied
                  // The cashier must NEVER read «تمام» on a denied operation —
                  // that reads like «it's done». Say the permission truth instead.
                  ? permissionMsg
                  : chatFallbackWithChips(v)
        await streamDeterministic(fallback, emit, 900)
        replyText = fallback
      }
    }
  }

  if (!replyText.trim()) {
    meta.fallback = true
    const fallback = advisoryMode
      ? advisoryFallback(v)
      : multiReplyParts
        ? deterministicMultiReply(multiReplyParts, multiOverflow)
        : card ? `جهزت المسودة — ${card.summary}` : permissionDenied ? permissionMsg : chatFallbackWithChips(v)
    await streamDeterministic(fallback, emit, 900)
    replyText = fallback
  }

  // ---- PASS 4.5: R15 self-verification (post-hoc for live-streamed turns) ----
  // Deterministic ONLY here (regex digit cross-check, sub-ms) — the LLM judge
  // is a research-mode exclusive (hard contract: <600ms on normal turns).
  // A corrected text replaces the PERSISTED message; the done event carries
  // the verified ledger so the UI re-renders the corrected numbers.
  if (verifiedLedger == null) {
    const postVerified = verifyReply(replyText, turnFacts)
    verifiedLedger = postVerified.verified
    if (postVerified.verified.status === 'corrected') {
      replyText = postVerified.text
    }
  }

  // ---- PASS 5: Deep-link action buttons (after deltas, before done) ----
  if (actions && actions.length > 0) {
    emit({ event: 'actions', actions })
  }

  await bumpMemoryUsage(memCtx.referencedIds)
  return {
    replyText,
    card,
    cards,
    thinking: steps,
    modelLabel,
    opId,
    actions: actions && actions.length > 0 ? actions : null,
    verified: verifiedLedger,
  }
}

/** Legacy chip fallback for non-advisory plain-chat turns (R13, kept for safety). */
function chatFallbackWithChips(v: VerticalDef): string {
  const three = v.chips.slice(0, 3)
  if (three.length === 0) return 'تحت أمرك — قوللي أي حاجة وهظبطها.'
  return `تحت أمرك. تحب نجرب: ${three.join(' · ')}؟`
}
