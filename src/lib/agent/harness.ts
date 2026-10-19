import { cashbookTurn } from './cashbook'
import { resolveCairoSchedule } from '@/lib/tasks/cairo-time'
import { getWorkspacePreferences, updateWorkspacePreferences } from '@/lib/workspace-preferences'
import { executePlugin, getActivePlugins, getBusinessPlugins, pluginsPromptSection, synthesizePluginWithAI, togglePluginActive } from './plugin-harness'
import { containsMemorySecret } from './memory-policy'
import { withModelHealth } from './model-health'
import { evidenceBlock, recentDialogue, toolSignature } from './context'
import { AuthorizationError, requireBusinessUser, requirePermission } from '@/lib/security/permissions'
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
  SubtaskDTO,
  ThinkingStep,
  VerifyDTO,
} from '@/lib/types'
import type { VerticalDef } from '@/lib/verticals'
import { egp, qty as fmtQty, arDate } from '@/lib/format'
import { arUnit, getVertical } from '@/lib/verticals'
import { wordBoundedAt, convertToBaseUnit, matchEntity, normalizeAr, parseQuantity, toWesternDigits, unitToCode } from './arabic'
import {
  extractNewItemCandidate,
  fillPendingSlots,
  getActivePendingRequest,
  looksLikeNewTopic,
  markPendingDone,
  isCreditCommand,
  isRegisterCommand,
  parseCreditBalance,
  pendingFollowUpText,
  pendingQuestionText,
  savePendingRequest,
  type NewItemSlots,
} from './pending-request'
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
import { harnessesPromptBlock } from './cli-anything/harness-installer'
import { brainToolSchemas } from './tool-schemas'
import { READ_TOOLS, runReadTool, TYPE_AR, isQuestionWord, type ReadTool } from './tools'
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
import { decisionEngine } from './decision-middleware'
import { decomposeGoalIntoSubtasks, executeSubagentPipeline } from './task-engine'

export interface TurnEmit {
  (ev:
    | { event: 'thinking'; steps: ThinkingStep[] }
    | { event: 'step'; label: string; state: 'active' | 'done' }
    | { event: 'card'; card: ActionCardDTO }
    | { event: 'cards'; cards: ResultCardDTO[] }
    /** Autonomous subagent decomposition tasks */
    | { event: 'tasks'; tasks: SubtaskDTO[] }
    | { event: 'task_update'; task: SubtaskDTO }
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
  /** R34: stable composer id — a retried turn must not draft the same op twice */
  turnId?: string
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
      emit({ event: 'delta', text: pieces.slice(i + 1).join('') })
      break
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
  get_supplier_history: [{ id: 'act-get_supplier_history', label: 'حسابات الموردين', view: 'accounts', icon: 'users', tone: 'primary' }],
  get_contact_info: [{ id: 'act-get_contact_info', label: 'جهات الاتصال', view: 'accounts', icon: 'users', tone: 'primary' }],
  get_financial_position: [{ id: 'act-get_financial_position', label: 'المركز المالي', view: 'reports', icon: 'wallet', tone: 'primary' }],
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
  get_supplier_history: 'ملف المورد',
  get_contact_info: 'رقم التليفون',
  get_financial_position: 'المركز المالي',
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

/**
 * R40: pure-greeting detection for the deterministic pass.
 * Strict on purpose — anything carrying a digit, a work verb, or extra content
 * is NOT a greeting (it must reach the normal pipeline):
 *   • «السلام عليكم» / «وعليكم السلام» / «السلام عليكم ورحمة الله»
 *   • «أهلا» / «مرحبا» / «صباح الخير» / «مساء الخير» / «حالك إيه»
 *   • question words or amounts in the same message disqualify it.
 */
const GREETING_RES: RegExp[] = [
  /^(?:و)?(?:ال)?سلام(?:\s+عليكم)?(?:\s+(?:ورحمة\s+الله(?:\s+وبركاته)?))?[\s؟?!.،,]*$/,
  /^(?:أهلا|اهلا|أهلاً|مرحبا|مرحباً|هلا|اهلًا)[\s؟?!.،,]*$/,
  /^(?:صباح\s+الخير|مساء\s+الخير|صباح\s+نور|مساء\s+نور)[\s؟?!.،,]*$/,
  /^(?:حالك\s+ايه|كيف\s+حالك|اخبارك|كيفيك)[\s؟?!.،,]*$/,
  // R41: the «ازيك» family — the owner's actual word for hi (word-bounded;
  // an optional «يا فلان» tail is still a greeting, work content is not).
  // normalizeAr folds أ/إ/آ→ا and ى→ي, so ONE spelling covers the variants:
  // ازيك · ازيك · ازيك · ازيكم · ازاك · ازاك · ازاياك · زيك · وازيك …
  /^(?:و)?(?:ا)?زا?ي?ك(?:م)?[\s؟?!.،,]*(?:يا\s+\S+)?[\s؟?!.،,]*$/,
  /^(?:عامل|عاملين|عامله)\s+(?:ايه|ايش|ايش)[\s؟?!.،,]*(?:يا\s+\S+)?[\s؟?!.،,]*$/,
]
function isGreeting(norm: string): boolean {
  if (norm.length > 60) return false
  // A greeting never carries numbers or work content.
  if (/\d/.test(norm) || /[٠-٩]/.test(norm)) return false
  return GREETING_RES.some((re) => re.test(norm))
}

/** Warm, work-steering Egyptian reply (3 variants — no robotic repetition). */
function greetingReply(userName: string): string {
  const first = userName.split(/\s+/)[0] ?? 'يا صاحبي'
  // R41: a real colleague answers the hi FIRST, then offers the work —
  // the reply must sound human, not like a system banner.
  const templates = [
    `وعليكم السلام يا ${first}! 👋 إزيك؟ أنا تمام الحمد لله — قاعد على الشغل جاهز. قولي أي بيع أو شرا أو سؤال عن الأرصدة وأنا أشتغل فورًا.`,
    `أهلاً يا ${first}! ☕ إزيك؟ أنا في الخدمة على طول: سجّل أي عملية، اسأل عن أي رصيد أو مديونية، أو امشي معايا في قراءة شغلك.`,
    `حياك يا ${first}! 🏪 فرحتلك النهارده — أي رقم أو عملية أو سؤال عن السجل، قول وأنا أجهزه في ثواني.`,
  ]
  return templates[Math.floor(Math.random() * templates.length)]
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

/**
 * «بـ٤٥٠» / «ب ٩٠» / «بـ ٢٠٠ جنيه» → 450 / 90 / 200 EGP.
 * The marker is a standalone «بـ» or «ب » followed by digits — «بعت» starts with
 * ب+ع, so a verb can never look like a price.
 */
function extractStatedPrice(norm: string): number | null {
  // normalizeAr strips the tatweel, so «بـ٢٠٠» arrives as «ب٢٠٠» — the digit
  // must be allowed to follow ب directly (a verb like «بعت» never does).
  const m =
    norm.match(/(?:^|\s)ب\s*([٠-٩0-9]+(?:[.,][٠-٩0-9]+)?)/) ??
    norm.match(/([٠-٩0-9]+(?:[.,][٠-٩0-9]+)?)\s*(?:جنيه|جنية|جنيهات|ج\.م)/)
  if (!m) return null
  const n = Number(toWesternDigits(m[1]).replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? n : null
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

  if (/(السلام|اهلا|هلا|صباح|مساء|ازيك|عامل ايه|شكرا)/.test(s) && s.length < 25 && !/(فريق|موظف|مخزون|خزنه|خزنة|أصناف|اصناف|عملاء|مبيعات|ورديه|وردية|شغل)/.test(s)) {
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
  // ---- R39: a catalog PRICE CHANGE is a WRITE («غيّر سعر الكيس لـ٤٠») — it must
  // sit BEFORE the price-query rule, or the catalog lookup answers instead.
  {
    const pc = parsePriceChange(text)
    if (pc) {
      return {
        intent: 'write',
        opType: 'price_change',
        fields: { itemName: pc.name, newPrice: pc.pounds, priceMode: pc.mode, priceSign: pc.sign },
      }
    }
  }
  // R55: «فلوسي واقفين فين؟» / «المركز المالي» / «ماليي كام؟» — the whole money
  // picture (cash + receivables + stock − payables). The cashbox rule owns
  // «الخزنة/كاش» alone, so any sentence that names the cashbox skips us.
  if (/(المركز المالي|فلوسي (واقفين فين|فين|كام|اتعمل)|اموالي (فين|كام)|ماليي)/.test(s) && !/خزنه|كاش/.test(s))
    return { intent: 'read', tool: 'get_financial_position', fields: {} }
  if (/(وضع|رصيد|حاله) الخزنه|الخزنه|كاش/.test(s)) return { intent: 'read', tool: 'get_cash_position', fields: {} }
  // ---- R36: the weekly ledger questions, answered deterministically -------
  // They must sit BEFORE the generic «مخزون/ناقص» rule: «المخزون ده مكلّفني
  // كام؟» is a VALUE question, not a shortfall list. Patterns use literal
  // spaces because `s` is already normalized (whitespace collapsed).
  if (/(قيمة المخزون|المخزون.*(مكلفني|مكلّفني|يساوي|بكام)|راس المال|رأس المال|فلوس محبوس)/.test(s))
    return { intent: 'read', tool: 'get_stock_value', fields: {} }
  if (/(راكد|راكده|راكدة|مش بتتباع|مش بيتحرك|بضاعه راكنه|بضاعة راكنة)/.test(s))
    return { intent: 'read', tool: 'get_dead_stock', fields: {} }
  if (/(أفضل|افضل|أكبر|اكبر|أكتر|اكتر).*(عميل|عملاء|عملايي|عملاءي)|مين بيشتري|ترتيب العملاء|(عميل|عملاء|عملايي|عملاءي).*(أكتر|اكتر|أفضل|افضل)$|(أفضل|افضل)\s+(عملايي|عملاءي|عملاء|عميل)/.test(s))
    return { intent: 'read', tool: 'get_customer_ranking', fields: {} }
  if (/(أداء|اداء) (الفريق|الموظفين|الموظف)|احسن موظف|أحسن موظف|مين شغله|الموظفين بيعملوا/.test(s))
    return { intent: 'read', tool: 'get_staff_performance', fields: {} }
  if (/(بخساره|بخسارة|سعر التكلفه|سعر التكلفة|راجع الاسعار|راجع الأسعار|اسعار غلط)/.test(s))
    return { intent: 'read', tool: 'get_price_check', fields: {} }
  if (/(ورقة الطلب|ورقه الطلب|طلبيات)/.test(s) || (/(اشتري|أشتري|اجيب|أجيب|اطلب|أطلب)/.test(s) && /(ايه|إيه|كام|مين)/.test(s)))
    return { intent: 'read', tool: 'get_reorder_list', fields: {} }
  if (/(بربح|بكسب|مكسبي|مكسبى).*(من ايه|من إيه|من اكتر|من أكتر|اكتر|أكتر)|(اكتر|أكتر) (حاجه|حاجة) (بتربح|بتكسب)/.test(s))
    return { intent: 'read', tool: 'get_profit_by_item', fields: {} }
  if (/(أكتر|اكتر|أعلى|اعلى|افضل|أفضل).*(بيتباع|بتتباع|بتبعت|بتبيع|مبيع|مبيعات)|(بيتباع|بتتباع|بتبعت|بتبيع) (أكتر|اكتر)|أعلى الأصناف|الاصناف اللي بتتباع|الأصناف اللي بتتباع/.test(s))
    return { intent: 'read', tool: 'get_top_items', fields: {} }
  // «النواقص» / «نواقص» are the broken plurals an Egyptian owner actually uses —
  // a substring test for «ناقص» misses them entirely.
  if (/(مخزون|ناقص|نواقص|استوك|تحت الحد)/.test(s) && !/(بعت|بيع|شرا|اشتري)/.test(s)) return { intent: 'read', tool: 'list_low_stock', fields: {} }
  if (/(صلاحيت|صلاحيه|منتهي|قربت|تنتهي|ينتهي|بينتهي|هينتهي|قربت تخلص|هتخلص صلاحيت|قرب يخلص)/.test(s)) {
    return { intent: 'read', tool: 'list_expiring', fields: {} }
  }
  // ---- «بعت كام …؟» is a QUESTION, not a sale. Live R31: «بعت كام علبة لبن
  // الشهر ده؟» came back as «آخر الحركات» (eight rows) — related, useless. The
  // owner wants one number, and the sale verb must not reach the write rule.
  if (/(كام|قد\s*ايه|قدايه)/.test(s)) {
    const metric = /(حصلت|تحصيل|قبضت|استلمت)/.test(s)
      ? 'collections'
      : /(اشتريت|مشتريات|الشرا|شراء)/.test(s)
        ? 'purchases'
        : /(صرفت|مصروف|مصاريف|مصروفات)/.test(s)
          ? 'expenses'
          : /(بعت|مبيعات|اتبيع|بيع)/.test(s)
            ? 'sales'
            : null
    if (metric) {
      // R58: امبارح = yesterday's full Cairo day (its own window in the tool).
      const isYesterday = /(امبارح|امبارح|بارح)/.test(s)
      const days = isYesterday ? 1 : /(النهارده|اليوم|دلوقتي)/.test(s) ? 1 : /(اسبوع|الأسبوع|7 ايام|سبعة ايام)/.test(s) ? 7 : 30
      const query = s
        .replace(/(بعت|مبيعات|اتبيع|بيع|حصلت|تحصيل|قبضت|استلمت|اشتريت|مشتريات|الشرا|شراء|صرفت|مصروفات|مصاريف|مصروف)/g, ' ')
        .replace(/(كام|قد\s*ايه|قدايه|النهارده|اليوم|امبارح|امبارح|الشهر|هذا|ده|دي|الاسبوع|الأسبوع|الفتره|الفترة|الماضي|الجاي|علبه|علبة|كرتونه|كرتونة|كيلو|قطعه|قطعة|جرام|شريط|لتر)/g, ' ')
        // connectors + generic nouns are not names: «اشتريت كام من الموردين؟»
        // must not filter by a customer/supplier called «من المور ن» (the
        // normalizer splits «الموردين»), it must aggregate ALL purchases.
        // normalizeAr already split «الموردين» → «المور ن»; strip both spellings
        .replace(/(^|\s)(من|في|ف|علي|على|عن|مع|كل|اللي|المور\s*ن|الموردين|الموردون|المورد|موردين|مورد|العملاء|للعملاء|العميل|للعميل|المحل|العياده|العيادة|الشغل|الفاتوره|الفاتورة)(?=\s|$)/g, ' ')
        .replace(/[؟?]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      return {
        intent: 'read',
        tool: 'get_period_totals',
        fields: { metric, days, ...(isYesterday ? { yesterday: true } : {}), ...(query.length >= 2 ? { query } : {}) },
      }
    }
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
  // «آخر الحركات إيه؟ / العمليات اللي اتعملت / سجل الحركات» — the owner's
  // "what just happened" question (R44: it used to fall to the model and,
  // offline, die as a network apology).
  if (/(الحركات|العمليات|اتعمل|اتسجل|سجل الحركات|سجل العمليات|آخر معامله|آخر حركه|آخر عملية|آخر حركة)/.test(s) && !/(بعت|بيع|سجل بيع|اشتريت|سجل)/.test(s))
    return { intent: 'read', tool: 'get_activity_history', fields: {} }
  if (/(مديون|اللي ليا|تحصيلات|مين عليها|عليها فلوس|عليهم فلوس|العملاء)/.test(s)) return { intent: 'read', tool: 'list_receivables', fields: {} }
  // R44: «سددت ١٠٠٠ لشركة المنظفات» / «دفع للمورد ٢٠٠ من مستحقات شركة X» —
  // first-person paying a SUPPLIER is a PAYMENT, never a collection. The old
  // collection rule owned «سدد/دفع» and answered «تحصيل من مين؟» (live R44).
  if (/(^|\s)(سددت|سداد|دفعت|ادفع|خلصت)(\s|$)/.test(s)) {
    const mSup = s.match(/(?:ل|لم|لمورد|لشركة|لل|عند)\s*([^\s،,؟?]+(?:\s+[^\s،,؟?]+){0,2})/)
    const supplierName = mSup?.[1] && !/^(اللي|عليه|عليها|كام|من|في|بس|فقط|جنيه)$/.test(mSup[1].split(' ')[0]) ? mSup[1].trim() : undefined
    const amount = extractStatedPrice(s)
    return { intent: 'write', opType: 'payment', fields: { ...(supplierName ? { supplierName } : {}), ...(amount != null ? { amount } : {}) } }
  }
  if (/(دفع|سداد) للمورد/.test(s)) {
    const mSup = s.match(/مستحقات\s+([^\s،,؟?]+(?:\s+[^\s،,؟?]+){0,2})/)
    const amount = extractStatedPrice(s)
    return { intent: 'write', opType: 'payment', fields: { ...(mSup?.[1] ? { supplierName: mSup[1].trim() } : {}), ...(amount != null ? { amount } : {}) } }
  }
  // R52: a NAMED payables question → that supplier's FILE (balance + payment
  // pattern + last movements) — the mirror of the customer history rule.
  // «كام علينا لمحمد تاجر الجملة؟» / «تاريخ المورد X» / «حساب المورد X».
  const mSupQ = s.match(/^(?:كام|كم) علينا (?:ل|لم|لمن)?\s*([^ ،,؟?]+(?:\s+[^ ،,؟?]+){0,3})\s*[؟?]?$/) ?? s.match(/^(?:تاريخ|حساب|ملف) المورد\s+([^ ،,؟?]+(?:\s+[^ ،,؟?]+){0,3})\s*[؟?]?$/)
  if (mSupQ) {
    const supName = mSupQ[1].trim()
    return { intent: 'read', tool: 'get_supplier_history', fields: supName.length >= 2 ? { name: supName } : {} }
  }
  // R51: «كام علينا؟» — the everyday payables question (no name → the list).
  if (/(اللي علينا|للمورد|الموردين|مستحق|كام علينا|كم علينا|كام على المورد|كم على الموردين)/.test(s)) return { intent: 'read', tool: 'list_payables', fields: {} }
  // «النهارده عملت ايه؟» is the same question in a different word order — the
  // owner's first sentence of the day, and it used to fall through to chat.
  if (/(ملخص|كويس اليوم|حال اليوم|عملت\s*ايه|ايه\s*اللي\s*عملته|اخبار\s*اليوم)/.test(s))
    return { intent: 'read', tool: 'get_daily_summary', fields: {} }
  // ---- R28 superpowers: money & future questions (deterministic, offline-safe)
  // «بربح كام؟ / الهامش؟ / إيه اللي مش مربح؟»
  if (/(بربح|بكسب|مكسب|ربح|هامش|مربح|بيكسب)/.test(s) && !/(بعت|بيع|شرا|اشتري)/.test(s)) {
    return { intent: 'read', tool: 'get_profit_margin', fields: {} }
  }
  // «إيه اللي هيخلص؟ / هينقص إمتى؟ / توقّع»
  if (/(هيخلص|هينقص|هتخلص|توقع|متوقع|نفض|معدل البيع|كم يوم باقي|يخلص قريب|هيخلص مع|ينتهي قريب)/.test(s)) {
    return { intent: 'read', tool: 'forecast_stockout', fields: {} }
  }
  // «بيحاسب إزاي؟ / بيسدد كل قد إيه؟ / ملف العميل / كم علي أم حسن؟»
  // R51: «كم علي/كام عليه + name» is THE everyday balance question — it used
  // to die into the generic «النت تقيل» reply offline.
  if (/(بيسدد|بيحاسب|ملف العميل|تاريخ العميل|بيدفع كل|كم علي(?:ه|ها)?(?: |$)|كام علي(?:ه|ها)?(?: |$)|كم عليها|كام عليها|عليه قد ايه|عليها قد ايه|رصيده كام|رصيدها كام)/.test(s)) {
    // name = the words after «العميل»/«ملف»/«كم علي» or before the verb, e.g.
    // «ملف العميل أم حسن» / «أم حسن بتسدد» / «كم علي أم حسن؟» / «أم حسن عليه كام؟»
    const mName =
      s.match(/(?:ملف|تاريخ)\s+(?:العميل\s+)?([^ ،,؟?]+(?:\s+[^ ،,؟?]+)?)/) ??
      s.match(/^(?:كم|كام) علي(?:ه|ها)?\s+([^ ،,؟?]+(?:\s+[^ ،,؟?]+)?)/) ??
      s.match(/^\s*([^ ،,؟?]+(?:\s+[^ ،,؟?]+)?)\s+(?:بتسدد|بيسدد|بيحاسب|بيدفع|عليه (?:كام|قد ايه)|عليها (?:كام|قد ايه))/)
    const name = mName ? mName[1].replace(/^(العميل|بتاع|من)\s*/, '').trim() : ''
    return { intent: 'read', tool: 'get_customer_history', fields: name && name.length >= 2 ? { name } : {} }
  }
  // R47: undo/reversal of recent work — «ملش آخر بيع» / «الغيت اللي فات» /
  // «اعكس شرا السمنه». MUST fire before the sale/collection/period rules:
  // «بيع» inside «اعكس بيع» is not a sale verb, and «اللي فات» here means the
  // last OPERATION, not a period (the compare-period rule used to steal it).
  if (
    /(ملش|ملشت|ملشش|ملشلي|الغيت|الغي|يلغي|ايلغي|امسح|امسحلي|اعكس|اعمل عكس|عكس|اتلغى|اتلغت)( |$)/.test(s) &&
    (/آخر|اللي فات|التاني|تاني|قبلها/.test(s) || /بيع|شرا|شراء|مصروف|تحصيل|دفعة|دفع|عملية/.test(s)) &&
    !/مبيعات|مصاريف|تحصيلات|اسبوع|شهر|امبارح|مقارنه/.test(s)
  ) {
    return { intent: 'write', opType: 'reversal', fields: {} }
  }
  // R53: a receipt REF, read straight off the printed slip — «الفاتورة
  // WKL-1032 دي فيها إيه؟» / «الورقة WKL 1032 كانت كام؟» / just «WKL-1032».
  // Sits AFTER the reversal rule (which owns «اعكس WKL-…»); the write-verb
  // guard keeps «سجل…/سدد…» on the write side. Arabic digits and a missing
  // dash are tolerated (normalized again inside the tool).
  const mRef = s.match(/WKL[\s-]?([0-9٠-٩]{3,})/i)
  if (mRef && !/(سجل|سدد|دفع|ضيف|اشتري|بعت|صرف|عدل|اعكس|الغيت|امسح)/.test(s)) {
    return { intent: 'read', tool: 'get_transaction_status', fields: { ref: `WKL-${toWesternDigits(mRef[1])}` } }
  }
  // R54: a phone question — «رقم تليفون أم حسن؟» / «اتصل بـ محمد تاجر الجملة» /
  // «تليفون المورد محمد تاجر الجملة كام؟». Sits AFTER the mRef rule (a ref
  // question carries WKL-… and wins) and BEFORE the payables substring rule.
  const mPhone = s.match(
    /(?:^|\s)(?:رقم(?: تليفون)?|تليفون|التليفون|جوال|اتصل)(?: ب(?:ـ)?|\s+(?:تليفون|الرقم|رقم|بتاع|بتاعت|اللي))?[\s-]*([^\s؟?]+(?:\s+[^\s؟?]+){0,4})/,
  )
  if (mPhone && !/(سجل|ضيف|اضف|اضيف)/.test(s)) {
    const n = mPhone[1]
      .replace(/^(?:ال)?(?:عميل|عميله|مورد|مورده|زبون|بتاع|بتاعت|ب)\s+/, '')
      .replace(/\s+(?:هو|هي|ايه|إيه|كام|متاح|رقمه|رقمها)(?:\s|$)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (n.length >= 2 && !isQuestionWord(n)) {
      return { intent: 'read', tool: 'get_contact_info', fields: { name: n } }
    }
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
  // R40: a membership sentence («عضويته باقي قد إيه؟») also contains «باقي قد
  // إيه» — without this guard it was read as item stock and the member's name
  // (with its possessive suffix) became the search query. Membership belongs
  // to the get_member_status rule below.
  if (
    !/(عضوي|اشتراك)/.test(s) &&
    (/(عندي|معايا|فاضل|باقي|رصيد)\s+(كام|قد ايه|قدايه)/.test(s) || /كام\s+(كيلو|علبه|كرتونه|قطعه|شريط|جرام)/.test(s))
  ) {
    const mItem = s
      .replace(/\?|؟/g, ' ')
      .match(/(?:^|\s)(?:رصيد|مخزون)\s+([^\s،,]+(?:\s+[^\s،,]+)?)/) ??
      s.match(/(?:^|\s)([^\s،,؟?]+(?:\s+[^\s،,؟?]+)?)\s+(?:عندي|معايا|فاضل|باقي)/) ??
      // R44: «عندي كام كرتونة تونك؟» — the item comes AFTER the counter word.
      s.match(/(?:كام|قد ايه|قدايه)\s+(?:كيلو|كيلوجرام|علبه|علبة|كرتونه|كرتونة|كرتون|قطعه|قطعة|شريط|جرام|كيس|اكياس|لتر|طبق|زجاجه|زجاجة|حبه|حبة|سلفه|صفيحه|صفيحة|برطمان|جركن|باكيت|مل|حبه)?\s*([^\s،,؟?]+(?:\s+[^\s،,؟?]+)?)/)
    const q = mItem?.[1]?.replace(/^(اللي|اللي\s)/, '').trim() ?? ''
    if (q.length >= 2 && !/^(كام|قد ايه|قدايه|في|من|ل|عليه|عليها)$/.test(q.split(' ')[0]))
      return { intent: 'read', tool: 'get_item_stock', fields: { name: q.slice(0, 40) } }
  }
  // Price query («ايه سعر عود كمبودي؟» / «بكام المسك؟») → catalog search (R0 read)
  if (/(سعر|بكام)/.test(s) && !/(بعت|بيع|بع |خرج|سلف|دفع|سجل)/.test(s)) {
    // The item may come AFTER the price word («بكام المسك؟») or BEFORE it
    // («كيلو الكمون بكام؟») — owners say both. R40: the before-order was
    // stripped to nothing by the first replace and fell through to the model.
    const after = s
      .replace(/^.*?(?:سعر|بكام)\s*/, '')
      .replace(/[؟?].*$/, '')
      .replace(/\s*(?:سعر|بكام|ايه|هو)\s*/g, ' ')
      .replace(/\s*(?:كام|دلوقتي|بقي|بعد اذنك|لو سمحت|من فضلك)\s*$/g, '')
      .replace(/^\s*(?:في|من)\s*/, '')
      .trim()
    const before = after
      ? after
      : s
          .replace(/(?:سعر|بكام).*$/, ' ')
          .replace(/[؟?]/g, ' ')
          .replace(/\s*(?:ايه|هو|كام)\s*/g, ' ')
          // normalizeAr already split «الكمون» → «ال كمون»; drop the lone article.
          .replace(/(^|\s)ال(?=\s|$)/g, ' ')
          .trim()
    const q = (before ?? after).slice(0, 40)
    if (q.length >= 2) return { intent: 'read', tool: 'search_catalog', fields: { query: q } }
  }
  // Attendance (gym): noun «حضور» + Egyptian verb forms («كريم حضر»,
  // «لعب حصة PT», «خلص تدريب») — a member WORKED OUT today.
  if (/(حضور|(^| )حضر(ت)?( |$)|لعب حصه?|خلص (تدريب|حصه?)|اتمرن|اتدرب|عمل تمرين)/.test(s)) return { intent: 'write', opType: 'attendance', fields: {} }
  // Membership STATUS question — a READ, must beat the renewal WRITE below:
  // «عضوية عمر باقي قد ايه؟» → get_member_status for عمر (name word follows
  // عضويه/اشتراك); renewal verbs (جدد/تجديد/سجل) keep the WRITE path.
  // R44: «باقي قد إيه لعمر الشناوي؟» — the member question WITHOUT the word
  // «عضوية» (owners skip it). Name after لـ; must sit before the item-stock
  // «باقي» rule or the member's name becomes a product search.
  if (isGym && /(باقي|متبقي|متبقی|فاضل|خلصت)/.test(s) && /\sل(?:ـ)?\s/.test(s) && !/(جدد|تجديد|سجل|اشتراك|اعمل)/.test(s)) {
    const mLeft = s.match(/\sل(?:ـ)?\s*([^\s،,؟?]+(?:\s+[^\s،,؟?]+){0,2})/)
    const cand = mLeft?.[1]?.trim() ?? ''
    const QW = /^(مين|من|ايه|اللي|بتاع|بتاعت|دي|ده|دول|هما|كل|كام|كام|فاضل|قد|باقي|قربت|حاله|وضع|شهر|سنه|شهره)$/.test(cand)
    if (cand.length >= 2 && !QW && cand.split(' ').length <= 3) {
      return { intent: 'read', tool: 'get_member_status', fields: { name: cand } }
    }
  }
  if (isGym && !/(جدد|تجديد|سجل|اعمل)/.test(s)) {
    // «عمر الشناوي عضويته باقي قد إيه؟» — Egyptian owners put the NAME first and
    // the noun after it («عضويته»), which the old «عضوية X» pattern read as the
    // member «باقي». Both orders are tried, name-first wins when it is a name.
    // Up to 3 words: normalizeAr splits «الشنوي» → «ال شنوي», so «عمر ال شنوي»
    // is three tokens — a 2-word capture would answer «ال شنوي» (still resolved,
    // but the full name is cleaner in the reply).
    const mBefore = s.match(/(^|\s)([^\s،,؟?]+(?:\s+[^\s،,؟?]+){0,2})\s+(?:عضويته|اشتراكه|عضويته\s*باقي|عضويه|اشتراك)(\s|$)/)
    const mMember = s.match(/(?:عضويه|اشتراك)\s+([^ ،,؟?]+)/)
    const candidate = mBefore?.[2]?.trim() || mMember?.[1]
    const QUESTION = /^(مين|من|ايه|إيه|اللي|التي|بتاع|بتاعت|دي|ده|دول|هما|كل|أي|اي|كام|فاضل|قد|باقي|قربت|خلص|حاله|وضع)$/
    const candidateWords = (candidate ?? '').split(/\s+/).filter(Boolean)
    const isName = !!candidate && !QUESTION.test(candidate) && !candidateWords.every((w) => QUESTION.test(w))
    const name = isName ? (candidate as string) : ''
    const isQuestion = /(باقي|قد ايه|متبقي|فاضل|بتنتهي|تنتهي|هتنتهي|قربت|خلص|حاله|وضع|اوضه)/.test(s)
    if (name && (isQuestion || /عضويه/.test(s))) {
      return { intent: 'read', tool: 'get_member_status', fields: { name } }
    }
    // «مين اللي عضويته قربت تخلص؟» / «الاشتراكات اللي هتنتهي» — a LIST question.
    // Without this the sentence fell through to the renewal WRITE and confused
    // the owner (and, before the tool guard, to «ملقيتش عضو بالاسم «مين اللي»»).
    if (!name && isQuestion && /(عضوي|اشتراك|عضويات)/.test(s)) {
      return { intent: 'read', tool: 'list_expiring', fields: {} }
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
  // The price the owner SAID is part of the intent, even when no model runs
  // (offline ladder / provider down). «بعت كيلو جبنة بـ٢٠٠» must draft ٢٠٠,
  // not silently charge the catalog's ١٤٥.
  // R44: passive «بيعت ٥ كيلو عدس» and delivery «خرجت ٢ طبق بيض» are SALES —
  // «خرجت» used to fall into the collection rule and draft «تحصيل ٢ ج.م» (live).
  if (/(^| )(بعت|بيع|بع|بيعت|اتبعت|خرجت|خرجلي|خرج|سلّمت|سلمت|اتسلم|سلفت)( |$)/.test(s) ||
      // party + (up to 2 name words) + took: «كافترية النور خدت ١٠ زجاجة كوكاكولا»
      // party + (up to 2 name words) + took: «كافترية النور خدت ١٠ زجاجة كوكاكولا».
      // normalizeAr maps ة→ه and ى→ي, so party names need both spellings.
      /(?:زبون|عميل|مطعم|كافتري[هة]|مق[هىي]|حاج|بنت)(?:\s+[^\s،,؟?]{1,15}){0,2}\s+(?:خد|خدت|اخدها|اخده|اخدت|ياخد)/.test(s) ||
      // R46: the owner's FULL NAME + took: «مصطفى الجزار خد ٥٠ كيس سكر» — 1–3 name
      // words + took-verb. The payload builder resolves the customer (or asks).
      /^(?:[^\s0-9،,؟?]{1,20}\s+){1,3}(?:خد|خدت|اخدها|اخده|اخدت|ياخد)(?:\s|$)/.test(s)) {
    const amount = extractStatedPrice(s)
    return { intent: 'write', opType: 'sale', fields: amount != null ? { amount } : {} }
  }
  if (/(^| )(اشتريت|شرا|جبت|دخلت)( |$)/.test(s)) {
    // R40: «جبت ٥ كرتون زيت بـ٢٥٠» — the stated price IS the total cost.
    // Without the amount, the draft silently used catalog × qty (٥×٥٦=٢٨)
    // and the owner's own number was lost.
    const amount = extractStatedPrice(s)
    return { intent: 'write', opType: 'purchase', fields: amount != null ? { amount } : {} }
  }
  // Collection: «تحصيل ١٠٠ من أحمد» / «حصلت ١٠٠ من أحمد» / «أحمد دفع ١٠٠»
  // NOTE: «خلص» must be word-initial — «تخلص صلاحيته» (expiry) must NEVER
  // fire a collection (caught by the expiring rule above instead).
  if (/(تحصيل|(?:^| )خلصت?\s+(من|ال)|حصل|قبض|استلم)/.test(s) && /(من|لـ|ل)/.test(s)) {
    return { intent: 'write', opType: 'collection', fields: {} }
  }
  if (/^(حصلت|قبضت|استلمت|خدت|اتلم)/.test(s)) return { intent: 'write', opType: 'collection', fields: {} }
  // R40: «أحمد دفع ١٠ بس» — the name is the first word; pass it explicitly so
  // customer resolution never depends on guessing it out of the full sentence.
  // R44: up to 3 name words — «أم حسن دفع ١٠» used to capture «ام» alone.
  const mPaid = s.match(/^(.{1,24}?)\s+(?:دفع|سدد|خلص|حصل)(?:\s|$)/)
  if (mPaid) {
    const name = mPaid[1].replace(/^(?:و|الي|امبارح|النهارده)\s+/, '').trim()
    if (name.length >= 2 && !/^(من|ل|في|عليه|كام|دفع|سدد)$/.test(name)) {
      return { intent: 'write', opType: 'collection', fields: { customerName: name.slice(0, 30) } }
    }
  }
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
  'customer_add', 'supplier_add', 'price_change',
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
  /**
   * R41 «موظف حقيقي»: a multi-turn request is OPEN (new item waiting for its
   * supplier/total). The question OWNS this turn's reply — it is streamed
   * verbatim, deterministically, and the model never rephrases it.
   */
  pendingQuestion?: string
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

/**
 * R47 — an explicitly typed name («عميل اسمه أحمد زكي اللي مش معارفه») is
 * captured greedily, so trim trailing function words that are not part of the
 * name. A name must never be drafted as «أحمد زكي اللي».
 */
function cleanTypedName(raw: string): string {
  // The capture is GREEDY (up to 25 chars of the sentence), so the name ends
  // at the FIRST function word — «عميل اسمه محمد اللي مش معارفه آجل» → محمد.
  const stop = new Set(['اللي', 'اللي', 'ده', 'دي', 'دى', 'مش', 'معرفه', 'معارفه', 'معرفش', 'لي', 'لـ', 'بـ', 'ل', 'ب', 'في', 'من', 'لو', 'قالي', 'يقول', 'يعني', 'يعنيها', 'اجل', 'نقدي', 'دفعت', 'دفع'])
  const words = raw.replace(/\u0640/g, '').trim().split(/\s+/)
  const out: string[] = []
  for (const w of words) {
    if (out.length > 0 && stop.has(w)) break
    out.push(w)
  }
  return out.slice(0, 3).join(' ')
}
function findPartyMention<T extends { name: string }>(
  text: string,
  parties: T[],
  marker: 'ل' | 'من' = 'ل',
): T | null {
  const norm = normalizeAr(text)
  // R47 SAFETY: an explicitly typed full name («عميل اسمه أحمد زكي») must NEVER
  // partial-match a different registered person («أحمد عبد الرحمن») — a word
  // hit + role word used to draft a sale onto the wrong customer (live probe).
  // With an explicit phrase, a party matches only if the phrase is the party
  // name itself or a leading part of it. No prefix match => NOT that party.
  const explicitPhrase = cleanTypedName(norm.match(/اسمه\s+([ء-ي][ء-ي\s]{1,25})/)?.[1] ?? '')
  if (explicitPhrase) {
    const ph = explicitPhrase.split(/\s+/).filter((w) => w.length >= 2).slice(0, 3).join(' ')
    if (ph.length >= 2) {
      for (const p of parties) {
        const pn = normalizeAr(p.name).replace(/\s+/g, ' ')
        if (pn === ph || (pn.length > ph.length && pn.startsWith(ph + ' '))) return p
      }
      return null
    }
  }
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

/**
 * R39 — «غيّر سعر الكيس لـ٤٠» / «خلي سعر البيضة ٥» / «زود سعر الكمون ١٠».
 *
 * The price-query rule («بكام المسك؟») must never swallow a price CHANGE: the
 * owner said a number with a change verb, which is a write that needs approval.
 * Two shapes are understood:
 *   • absolute — «خلي/غيّر/عدل سعر X = ٤٠» (the number IS the new price)
 *   • delta    — «زود/رفع/نزل/خفض سعر X ٥» (the number is added/subtracted)
 * Anything else (no number, past tense «غيرت», a question word) is not a
 * command and falls through to the read path untouched.
 */
function parsePriceChange(raw: string): { pounds: number; mode: 'absolute' | 'delta'; sign: 1 | -1; name: string } | null {
  const t = toWesternDigits(raw).replace(/[؟?].*$/, '').replace(/\s+/g, ' ').trim()
  const norm = normalizeAr(t)
  // A command must be imperative at the head of the sentence — «غيرت سعر
  // الكمون امبارح» is a statement about the past, not an instruction.
  const imperative = /^(?:لو سمحت |من فضلك |ممكن |عايز |عاوز |عايزك |عاوزك )?(?:غير|غيرلي|غير لي|اغير|اعدل|عدل|ظبط|اظبط|اضبط|خلي|اخلي|خليه|خليها|حدد|وصل|نزل|انزل|رفع|ارفع|زود|ازود|خفض|اخفض|قلل|اقلل) (?:لي )?(?:سعر|السعر|سعره|سعرها)/.test(norm)
  const setForm = /(?:^| )سعر .{1,60} (?:يبقي|يبقا|بقى) \d/.test(norm)
  if (!imperative && !setForm) return null
  if (/(?<!^)(غيرت|عدلت|ظبطت|نزلت|رفعت|زودت|خفضت|حددت)/.test(norm)) return null
  if (/(كام|بكام|رايك|ليه|ازاي|امتي|هو ايه|معناها)/.test(norm)) return null
  const nums = [...norm.matchAll(/(\d+(?:\.\d+)?)/g)]
  if (nums.length === 0) return null
  // Prefer the number that follows a "to" cue; else the last number said.
  const toCue = norm.match(/(?:^| )(?:ل|ب|=|يبقي|يبقا|بقى|بسعر) ?(\d+(?:\.\d+)?)/)
  const pounds = Number(toCue ? toCue[1] : nums[nums.length - 1][1])
  if (!(pounds > 0)) return null
  const relative = /(?:^| )(?:زود|ازود|رفع|ارفع|نزل|انزل|خفض|اخفض|قلل|اقلل) /.test(norm)
  const mode: 'absolute' | 'delta' = relative && !toCue ? 'delta' : 'absolute'
  const sign: 1 | -1 = /(?:^| )(?:نزل|انزل|خفض|اخفض|قلل|اقلل) /.test(norm) ? -1 : 1
  const stop = new Set(['ل', 'ب', '=', 'يبقي', 'يبقا', 'بقى', 'السعر', 'سعر', 'سعره', 'سعرها', 'بسعر', 'جنيه', 'جنية', 'جنيهات', 'ج', 'ج.م', 'قروش', 'قرش', 'دلوقتي', 'النهارده', 'كمان', 'لو', 'سمحت', 'من', 'فضلك', 'علي', 'الي', 'يكون', 'يبقي', 'بقي', 'خالص', 'بس'])
  const name = norm
    .replace(/(?:غير|غيرلي|اغير|اعدل|عدل|ظبط|اظبط|اضبط|خلي|اخلي|خليه|خليها|حدد|وصل|نزل|انزل|رفع|ارفع|زود|ازود|خفض|اخفض|قلل|اقلل|لو سمحت|من فضلك|ممكن|عايز|عاوز|عايزك|عاوزك)/g, ' ')
    .replace(/(?:سعر|السعر|سعره|سعرها|بسعر)/g, ' ')
    .replace(/\S*\d\S*/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !stop.has(w))
    .join(' ')
    .trim()
  return { pounds, mode, sign, name }
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

/**
 * R41 learning loop: the LAST time this item was bought (saved by the
 * new-item flow) names its supplier. A proposal, never an assumption — the
 * question says «نفس المورد؟» and the owner's silence + total counts as a yes.
 */
async function suggestSupplierForItem(businessId: string, itemName: string): Promise<string | null> {
  const flat = normalizeAr(itemName).replace(/\s+/g, ' ').trim()
  if (flat.length < 2) return null
  const rows = await db.agentMemory.findMany({
    where: { businessId, kind: 'fact', category: 'supply_chain', active: true },
    orderBy: { updatedAt: 'desc' },
    take: 10,
  })
  for (const m of rows) {
    const mFlat = normalizeAr(m.text).replace(/\s+/g, ' ')
    if (mFlat.includes(flat)) {
      const mm = m.text.match(/آخر مرة جت من (.+?)\s*\(سعر/)
      if (mm && mm[1].trim().length >= 2) return mm[1].trim()
    }
  }
  return null
}

/** Counter/measure words — never an item-name match on their own (R44). */
const COUNTER_WORDS = new Set([
  'حبه', 'حبة', 'قطعه', 'قطعة', 'كيس', 'اكياس', 'علبه', 'علبة', 'علب', 'شريط', 'اطباق', 'طبق',
  'زجاجه', 'زجاجة', 'برطمان', 'باكيت', 'سلفه', 'صفيحه', 'صفيحة', 'كرتون', 'كرتونه', 'كرتونة',
  'جركن', 'براد', 'كيسه', 'ربطه', 'ربطة', 'حبهان', 'سرفه', 'دوزه', 'جرعه', 'حبه', 'كونه', 'كونة',
])
/** Dialect word variants for item matching (word-level, R44): the owner's
 *  word vs the catalog's word. First variant replaces the canonical. */
const DIALECT_SYNONYMS: Record<string, string[]> = {
  'ماء': ['مياه'],
  'مياه': ['ماء'],
  'لبن': ['حليب'],
  'حليب': ['لبن'],
  'جوال': ['كيس'],
  'كيس': ['جوال'],
}

type ResolveCtx = TurnContext & { fullText?: string }
async function resolveWrite(ctx: ResolveCtx, intent: ExtractedIntent, emit: TurnEmit, memCtx: MemoryContext): Promise<ResolvedWrite> {
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
      // R44: «بعت -٣ علبة تونة» — the minus used to be silently dropped and the
      // owner got a draft of 3. A negative quantity is a mistake in the sentence,
      // not a sale: ask, never draft.
      if (/(^|\s)[-−]\s*[٠-٩0-9]/.test(textNoPaid) || /سالب\s*[٠-٩0-9]/.test(textNoPaid)) {
        return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'الكمية', failMessage: 'في رقم سالب في الجملة — قولي الكمية صح وأنا أجهز المسودة فورًا.' }
      }
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
      // R51: a GLUED «و» before a counter word is still a conjunction:
      // «٢ تونة وكونة زيت» = 2 tuna + 1 oil — the leading quantity must not
      // leak into the second item (live R51: it drafted 2+2). A pre-pass inserts
      // a space after the glued و so the «و»-splitter below sees a clean join.
      // Counter words are pure Arabic, so this needs no regex escaping.
      let prepped = scanText
      for (const w of COUNTER_WORDS) {
        prepped = prepped.split('و' + w).join('و ' + w)
      }
      const segments = prepped.split(/\s*(?:،|,|\+|؛|;)\s*|\s+و\s+|\s+و(?=[٠-٩0-9])/).filter(Boolean)

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
            // R44 dialect synonyms: the owner says «مياه» while the catalog
            // says «ماء 600 مل». Word-level expansion, still word-bounded.
            for (const [canonical, variants] of Object.entries(DIALECT_SYNONYMS)) {
              const nnv = nn.split(/\s+/).map((w) => (w === normalizeAr(canonical) ? variants[0] : w)).join(' ')
              if (nnv !== nn && nnv.length >= 3) {
                const at = wordBoundedAt(segNorm, nnv)
                if (at >= 0 && (!best || nnv.length > best.token.length)) best = { token: nnv, at }
              }
            }
            // R44 distinctive-head match: «تونة» resolves «تونة قطع 140 جرام» —
            // the FIRST non-digit, non-counter word of the name, length >= 3.
            const head = nn.split(/\s+/).find((w) => w.length >= 3 && !/^\d+$/.test(w) && !COUNTER_WORDS.has(w))
            if (head && head !== nn) {
              for (const variant of [head, ...DIALECT_SYNONYMS[head] ?? []]) {
                const at = wordBoundedAt(segNorm, variant)
                if (at >= 0 && (!best || variant.length > best.token.length)) best = { token: variant, at }
              }
            }
          }
          // R44 counter-word guard: a match on a bare counter word («حبة» in
          // «بعت ١٠ حبة بن محوج مخصوص») is NOT evidence of the item — it used
          // to draft «زيت حبة البركة» for a coffee sentence (live R44).
          const bestToken = best?.token
          if (bestToken && COUNTER_WORDS.has(bestToken) && !names.some((n) => normalizeAr(n) === bestToken)) {
            best = null
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
          // R44: when the match was a HEAD word («مياه» for «ماء 600 مل»), the
          // package spec glued behind it («60 مل») is part of the NAME, not a
          // requested unit — strip it before quantity parsing, or «5 زجاجة
          // مياه 600 مل» reads the 60ml as a milli-unit and asks for a re-count.
          let segForQty = stripItemName(seg, h.item)
          if (h.token.length >= 2) {
            const esc = h.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            segForQty = segForQty.replace(new RegExp(`${esc}\\s*\\d+\\s*(?:مل|مللي|جم|جرام|كج|لتر)?`, 'g'), ' ')
          }
          const q = parseQuantity(segForQty, null)
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
        // R51: a basket can carry an explicitly typed name too («… لعميل اسمه
        // أحمد زكي») — same contract as the single-item path: cash drafts
        // under the name, credit asks to register first (the whole basket is
        // held as a pending request; the completion re-scans the ORIGINAL
        // text, so the lines are rebuilt identically).
        const basketExplicitName = cleanTypedName(norm.match(/اسمه\s+([ء-ي][ء-ي\s]{1,25})/)?.[1] ?? '')
        const basketTypedName = !customer && type === 'sale' && lexCustomer == null && (String(f.customerName ?? '').trim() || basketExplicitName)
        if (basketTypedName && total - paid > 0 && !f.creditNewCustomer) {
          const creditAsk = `«${basketTypedName}» مش مسجل في حسابات العملاء — عليه كام من قبل؟ قولي رقمه وأنا أسجله وأنزل عليه البيعة، أو قولي «جديد» لو من عندنا.`
          if (ctx.conversationId) {
            await savePendingRequest({
              businessId: business.id,
              conversationId: ctx.conversationId,
              userId: user.id,
              kind: 'credit_new_customer',
              slots: {
                itemId: null,
                itemName: lines.map((l) => l.item.name).join(' + '),
                qty: null,
                unit: null,
                unitLabel: null,
                paid: 0,
                supplierName: null,
                suggestedSupplier: null,
                total,
                unitPrice: null,
                customerName: basketTypedName,
                openingBalance: null,
                sourceText: text,
              },
              question: creditAsk,
            })
          }
          return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'العميل', failMessage: creditAsk }
        }
        const supplier = (f.supplierName ? matchEntity(String(f.supplierName), suppliers)?.entity : null) ?? (type === 'purchase' ? findPartyMention(text, suppliers, 'من') : null)

        const payload: Record<string, unknown> = {
          lines: lines.map((l) => ({ itemId: l.item.id, name: l.item.name, qty: l.qty, unit: l.item.unit, unitPrice: l.unitPrice, total: l.total })),
          total,
          paid,
          ...(type === 'sale' && customer
            ? { customerId: customer.id, customerName: customer.name }
            : type === 'sale' && basketTypedName
              ? { customerName: basketTypedName }
              : {}),
          ...(type === 'purchase' && supplier ? { supplierId: supplier.id, supplierName: supplier.name } : {}),
        }
        const ref = `WKL-DRAFT` // replaced by real ref from createDraft
        const risk = computeRisk(type, total)
        const summary = `${type === 'sale' ? 'بيع' : 'شرا'} ${lines.map((l) => `${fmtQty(l.qty, arUnit(l.item.unit))} ${l.item.name}`).join(' + ')} بـ${egp(total)}${type === 'sale' && (customer || basketTypedName) ? ` — ${customer?.name ?? basketTypedName}` : ''}${type === 'purchase' && supplier ? ` — من ${supplier.name}` : ''}`
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
          ...(type === 'sale' && customer
            ? [{ label: 'العميل', value: customer.name }]
            : type === 'sale' && basketTypedName
              ? [{ label: 'العميل', value: `${basketTypedName} — مش مسجل`, hint: 'مسودة نقدي بالاسم. لو عايزه مسجل قولي «سجله» وأنا أسجله' }]
              : []),
          ...(type === 'purchase' && supplier ? [{ label: 'المورد', value: supplier.name }] : []),
          ...(creditField ? [creditField] : []),
          ...issues.map((i) => ({ label: '⚠ مش ضمن المسودة', value: i })),
        ], [
          ...lines.map((l) => ({ label: `مخزون ${l.item.name}`, value: `${fmtQty(l.item.stockQty, arUnit(l.item.unit))} ← ${fmtQty(l.item.stockQty + (type === 'sale' ? -l.qty : l.qty), arUnit(l.item.unit))}`, tone: 'neutral' as const })),
          { label: 'الخزنة', value: egp(type === 'sale' ? paid : -paid), tone: type === 'sale' ? 'good' as const : 'bad' as const },
        ], dangerNote ?? RISK_META[risk].hint)
        // R51: the cash basket keeps the R49 promise too — «سجله» next
        // registers the typed name.
        if (type === 'sale' && basketTypedName && ctx.conversationId) {
          await savePendingRequest({
            businessId: business.id,
            conversationId: ctx.conversationId,
            userId: user.id,
            kind: 'cash_new_customer',
            slots: {
              itemId: null,
              itemName: lines.map((l) => l.item.name).join(' + '),
              qty: null,
              unit: null,
              unitLabel: null,
              paid,
              supplierName: null,
              suggestedSupplier: null,
              total,
              unitPrice: null,
              customerName: basketTypedName,
              openingBalance: null,
              sourceText: text,
            },
            question: '',
          })
        }
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
        // ---- R41 «موظف حقيقي»: new-item purchase flow ----
        // The employee does NOT make the owner re-type a catalog name. An
        // unknown item + a stated quantity or payment is a NEW ITEM: propose
        // registering it, hold the request per conversation, and ask only the
        // missing slots (supplier / total) — one targeted question, never a
        // blank «مش لاقي الصنف».
        if (type === 'purchase' && f.newItem && f.itemName && f.supplierName) {
          const qtyN = Math.round(Number(f.qty ?? 0) * 1000) / 1000
          const itemName = String(f.itemName).trim()
          const supplierName = String(f.supplierName).trim()
          const unitCode = String(f.unit ?? 'piece')
          const unitPrice =
            typeof f.unitPrice === 'number' && f.unitPrice > 0
              ? Math.round(f.unitPrice * 100)
              : Math.round(((typeof f.total === 'number' ? f.total : 0) / Math.max(qtyN, 0.001)) * 100)
          const totalP = Math.round(((typeof f.total === 'number' && f.total > 0 ? f.total : (unitPrice / 100) * qtyN) as number) * 100)
          const paidP = Math.min(Math.round(Number(f.paid ?? 0) * 100), totalP)
          if (!(qtyN > 0) || totalP <= 0) {
            return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'المبلغ', failMessage: `كام الحساب كله لـ«${itemName}»؟` }
          }
          const supplier = suppliers.find((s) => normalizeAr(s.name).replace(/\s+/g, ' ') === normalizeAr(supplierName).replace(/\s+/g, ' ')) ?? null
          const payload: Record<string, unknown> = {
            itemId: null,
            itemName,
            qty: qtyN,
            unit: unitCode,
            unitPrice,
            total: totalP,
            paid: paidP,
            supplierId: supplier?.id ?? null,
            supplierName,
            newItem: true,
            newSupplier: supplier == null,
            unitLabel: typeof f.unitLabel === 'string' ? f.unitLabel : undefined,
          }
          const risk = computeRisk(type, totalP)
          const unitTxt = arUnit(unitCode)
          const summary = `شرا ${fmtQty(qtyN, unitTxt)} ${itemName} (صنف جديد) بـ${egp(totalP)} — من ${supplierName}`
          const card = fieldsToCard('', type, risk, summary, [
            { label: 'الصنف', value: `${itemName} — هيتسجل جديد`, hint: 'الاسم اللي قلته بالظبط' },
            { label: 'الكمية', value: `${fmtQty(qtyN, unitTxt)}${typeof f.unitLabel === 'string' && f.unitLabel !== unitTxt ? ` (${f.unitLabel})` : ''}` },
            { label: 'سعر الوحدة', value: egp(unitPrice) },
            { label: 'الإجمالي', value: egp(totalP) },
            { label: 'مدفوع', value: egp(paidP) },
            ...(totalP - paidP > 0 ? [{ label: 'باقي (للمورد)', value: egp(totalP - paidP) }] : []),
            { label: 'المورد', value: `${supplierName}${supplier ? '' : ' — هيتسجل جديد'}` },
          ], [
            { label: `مخزون ${itemName}`, value: `${fmtQty(0, unitTxt)} ← ${fmtQty(qtyN, unitTxt)}`, tone: 'neutral' },
            { label: 'الخزنة', value: egp(-paidP), tone: 'bad' },
            ...(totalP - paidP > 0 && supplier ? [{ label: 'المستحق للمورد', value: egp(totalP - paidP), tone: 'bad' as const }] : []),
          ], RISK_META[risk].hint)
          return { ok: true, opType: type, payload, summary, card }
        }
        if (type === 'purchase' && !f.newItem && ctx.conversationId) {
          const cand = extractNewItemCandidate(text, norm)
          if (cand) {
            const suggested = await suggestSupplierForItem(business.id, cand.itemName)
            const slots = { ...cand, suggestedSupplier: suggested }
            const question = pendingQuestionText(slots, 'purchase_new_item')
            await savePendingRequest({
              businessId: business.id,
              conversationId: ctx.conversationId,
              userId: user.id,
              kind: 'purchase_new_item',
              slots,
              question,
            })
            return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'الصنف', failMessage: question, pendingQuestion: question }
          }
        }
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
      // The owner's own number BEFORE the item name is the safest quantity
      // source: prices («بـ٩٠») and paid clauses («دفع ١٠٠») come after the item,
      // and a weak model happily answers qty=1 for «بعت ٢ لبن» (live R30).
      // Partial names matter: the owner says «لبن كرتونة» while the catalog says
      // «لبن كرتونة (جهينة)» — the boundary is the FIRST distinctive item word.
      const itemTokens = normalizeAr(item.name)
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !/^[()]+$/.test(w))
      const firstItemAt = itemTokens
        .map((t) => norm.indexOf(t))
        .filter((i) => i > 0)
        .sort((a, b) => a - b)[0]
      const headQty = firstItemAt != null && firstItemAt > 1 ? parseQuantity(norm.slice(0, firstItemAt), null).qty : null
      // Money numbers are not quantities. The live R30 bug: «بعت كرتونة لبن
      // لأحمد ودفع ١٠٠ بس» became a sale of ١٠٠ boxes because the model echoed
      // the paid amount into qty. Any qty candidate that equals a number sitting
      // next to بـ/جنيه/دفع/سعر is rejected.
      const moneyNums = new Set(
        (toWesternDigits(norm).match(/(?:ب|بـ|جنيه|ج\.م|دفع|دفعت|مدفوع|سعر|بسعر)\s*([0-9]+(?:\.[0-9]+)?)/g) ?? [])
          .map((m) => Number(m.replace(/[^0-9.]/g, '')))
          .filter((n) => Number.isFinite(n)),
      )
      const cleanQty = (n: number | null | undefined) => (n != null && n > 0 && !moneyNums.has(n) ? n : null)
      const qty = headQty ?? cleanQty(mentioned?.qty) ?? cleanQty(qtySource) ?? cleanQty(textQ.qty) ?? 1
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
      // …but ONLY when he actually said a price. Live R30: «بعت ٢ لبن كرتونة
      // لأم حسن» (no price at all) produced «بـ٢ ج.م» because the model mapped
      // the QUANTITY into fields.amount and the override trusted it. A number
      // with no price marker is a quantity/paid amount, never a unit price.
      const priceCue = /(?:^|\s)ب(?:ـ)?\s*[\d٠-٩]|(?:جنيه|جنية|ج\.م|قروش|قرش)|بسعر|سعر الوحدة|الواحدة ب/.test(norm)
      const rawAmount =
        typeof f.amount === 'number' && f.amount > 0 ? f.amount : typeof f.amount === 'string' && Number(f.amount) > 0 ? Number(f.amount) : null
      const statedEgp = priceCue ? rawAmount : null
      let priceOverride = false
      // R47: the owner's stated number wins for purchases too (R40 contract:
      // «جبت ٥ كرتونة لبن بـ٣٠» — the ٣٠ IS the deal total). Live probe: the
      // override was sale-only, so a purchase silently used catalog × qty.
      if (statedEgp != null) {
        const statedPiastres = Math.round(statedEgp * 100)
        if (statedPiastres > 0) {
          // «بـ٤٥٠ للكيلو» is a UNIT price, not the deal total: 2 kg = ٩٠٠.
          // Reading it as a total halved the ticket (live R30).
          const perUnit =
            /(للكيلو|للكيلوجرام|للعلبه|لعلبه|للكرتونه|للكرتونة|للوحده|للوحدة|للجرام|للقطعه|للقطعة|للشريط|للتر|للحبه|للحبة|للعبوه|للعبوة|الواحده ب|الوحدة ب)/.test(
              norm,
            )
          total = perUnit && qtyN > 0 ? Math.round(statedPiastres * qtyN) : statedPiastres
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
      // R47: an explicitly typed name («عميل اسمه أحمد زكي») that is NOT a
      // registered party is the party itself: a CASH sale drafts under the
      // typed name (no customerId), a credit sale asks to register first, and
      // a purchase makes it a NEW supplier born at approval.
      const explicitPartyName = cleanTypedName(norm.match(/اسمه\s+([ء-ي][ء-ي\s]{1,25})/)?.[1] ?? '')
      const typedCustomerName = !customer && type === 'sale' && lexCustomer == null && (customerName.trim() || explicitPartyName)
      const supplierName = String(f.supplierName ?? '') || (type === 'purchase' ? explicitPartyName : '')
      const supplier = (supplierName ? matchEntity(supplierName, suppliers)?.entity : null) ?? (type === 'purchase' ? findPartyMention(text, suppliers, 'من') : null)
      // R41: a supplier name the owner EXPLICITLY gave but that is not in the
      // book yet is a NEW supplier (born at approval) — never a hard fail,
      // never re-asked.
      const supplierIsNew = !supplier && type === 'purchase' && supplierName.trim().length >= 2
      // R47: a CREDIT sale to an unregistered person is a debt — it must never
      // be drafted onto a name string. Register first: one precise question.
      // R48: the question is kept HONEST — the whole sale is held as a pending
      // request, so the owner's ONE answer («عليه ٢٠» / «جديد») completes it:
      // register the customer, then draft the sale on his account.
      if (typedCustomerName && total - paid > 0 && !f.creditNewCustomer) {
        const creditAsk = `«${typedCustomerName}» مش مسجل في حسابات العملاء — عليه كام من قبل؟ قولي رقمه وأنا أسجله وأنزل عليه البيعة، أو قولي «جديد» لو من عندنا.`
        if (ctx.conversationId) {
          await savePendingRequest({
            businessId: business.id,
            conversationId: ctx.conversationId,
            userId: user.id,
            kind: 'credit_new_customer',
            slots: {
              itemId: item.id,
              itemName: item.name,
              qty: qtyN,
              unit: item.unit,
              unitLabel: null,
              paid: 0,
              supplierName: null,
              suggestedSupplier: null,
              total,
              unitPrice: qtyN > 0 ? total / qtyN : null,
              customerName: typedCustomerName,
              openingBalance: null,
              sourceText: text,
            },
            question: creditAsk,
          })
        }
        return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'العميل', failMessage: creditAsk }
      }

      // ---- R41 «موظف حقيقي»: a purchase that leaves a balance needs its
      // counterparty. «جبت 80 سمنه ودفعتله 500 بس» — the «له» implies a
      // supplier the owner forgot to name (or that Wakil should already
      // know). Never hard-fail: hold the request and ask the ONE missing
      // slot. The item is known, so its price comes from the catalog.
      if (type === 'purchase' && !supplier && !supplierIsNew && total - paid > 0 && ctx.conversationId) {
        const suggested = await suggestSupplierForItem(business.id, item.name)
        const slots: NewItemSlots = {
          itemId: item.id,
          itemName: item.name,
          qty: qtyN,
          unit: item.unit,
          unitLabel: null,
          paid: Math.round(paid / 100),
          supplierName: null,
          suggestedSupplier: suggested,
          total: priceOverride ? Math.round(total / 100) : null,
          unitPrice: priceOverride && qtyN > 0 ? Math.round((total / qtyN) / 100 * 100) / 100 : null,
        }
        const question = pendingQuestionText(slots, 'purchase_known_item')
        await savePendingRequest({
          businessId: business.id,
          conversationId: ctx.conversationId,
          userId: user.id,
          kind: 'purchase_known_item',
          slots,
          question,
        })
        return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'المورد', failMessage: question, pendingQuestion: question }
      }

      const payload: Record<string, unknown> = {
        itemId: item.id,
        itemName: item.name,
        qty: qtyN,
        unit: item.unit,
        unitPrice: priceOverride && qtyN > 0 ? Math.round(total / qtyN) : unitPrice,
        total,
        paid,
        ...(priceOverride ? { priceOverride: true } : {}),
        ...(type === 'sale' && customer
          ? { customerId: customer.id, customerName: customer.name }
          : type === 'sale' && typedCustomerName
            ? { customerName: typedCustomerName }
            : {}),
        ...(type === 'purchase' && (supplier || supplierIsNew)
          ? {
              supplierId: supplier?.id ?? null,
              supplierName: supplier?.name ?? supplierName.trim(),
              ...(supplierIsNew ? { newSupplier: true } : {}),
            }
          : {}),
      }
      const ref = `WKL-DRAFT` // replaced by real ref from createDraft
      const risk = computeRisk(type, total)
      const summary = `${type === 'sale' ? 'بيع' : 'شرا'} ${fmtQty(qtyN, arUnit(item.unit))} ${item.name} بـ${egp(total)}${type === 'sale' && (customer || typedCustomerName) ? ` — ${customer?.name ?? typedCustomerName}` : ''}${type === 'purchase' && (supplier || supplierIsNew) ? ` — من ${supplier?.name ?? supplierName.trim()}` : ''}`
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
        ...(type === 'sale' && customer
          ? [{ label: 'العميل', value: customer.name }]
          : type === 'sale' && typedCustomerName
            ? [{ label: 'العميل', value: `${typedCustomerName} — مش مسجل`, hint: 'مسودة نقدي بالاسم. لو عايزه مسجل قولي «سجله» وأنا أسجله' }]
            : []),
        ...(type === 'purchase' && (supplier || supplierIsNew)
          ? [{ label: 'المورد', value: `${supplier?.name ?? supplierName.trim()}${supplierIsNew ? ' — هيتسجل جديد' : ''}` }]
          : []),
        ...(creditField ? [creditField] : []),
      ], [
        { label: `مخزون ${item.name}`, value: `${fmtQty(item.stockQty, arUnit(item.unit))} ← ${fmtQty(item.stockQty + (type === 'sale' ? -qtyN : qtyN), arUnit(item.unit))}`, tone: 'neutral' },
        { label: 'الخزنة', value: egp(type === 'sale' ? paid : -paid), tone: type === 'sale' ? 'good' : 'bad' },
        ...(type === 'purchase' && total - paid > 0 && (supplier || supplierIsNew)
          ? [{ label: 'المستحق للمورد', value: egp(total - paid), tone: 'bad' as const }]
          : []),
      ], dangerNote ?? RISK_META[risk].hint)
      // R49: the cash card's hint promised «لو عايزه مسجل قولي» — hold the
      // typed name so the owner's NEXT message «سجله» knows who to register.
      if (type === 'sale' && typedCustomerName && ctx.conversationId) {
        await savePendingRequest({
          businessId: business.id,
          conversationId: ctx.conversationId,
          userId: user.id,
          kind: 'cash_new_customer',
          slots: {
            itemId: item.id,
            itemName: item.name,
            qty: qtyN,
            unit: item.unit,
            unitLabel: null,
            paid,
            supplierName: null,
            suggestedSupplier: null,
            total,
            unitPrice: qtyN > 0 ? total / qtyN : null,
            customerName: typedCustomerName,
            openingBalance: null,
            sourceText: text,
          },
          question: '',
        })
      }
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
      const rawLabel = String(f.label ?? '')
      const label = rawLabel || (norm.includes('كهربا') ? 'كهربا' : norm.includes('ايجار') ? 'إيجار' : norm.includes('تليفون') ? 'تليفون' : '')
      const payload = label ? { label, total: amount } : { total: amount }
      const risk = computeRisk(type, amount)
      // «مصروف مصروف بـ١٢٥» was the summary of every unlabelled expense —
      // the type already says «مصروف», so the word must not repeat.
      const summary = label ? `مصروف ${label} بـ${egp(amount)}` : `مصروف بـ${egp(amount)}`
      const card = fieldsToCard('', type, risk, summary, [
        ...(label ? [{ label: 'البند', value: label }] : []),
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
        if (customer.balance <= 0) {
          // R46: the customer owes us NOTHING (zero or credit). Collecting from
          // them is not a collection of existing debt — never clamp to 0 and
          // never crash in validation. One precise question, employee voice.
          return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'المبلغ', failMessage: `${customer.name} مالوش مديونية عندك دلوقتي (رصيده ${egp(customer.balance)}) — الـ ${egp(requested)} دي عربون ولا سلفة؟ قولّي وأنا أسجلها بالظبط` }
        }
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
      // R44: the sub-intent fragment may have lost the supplier's name (it sits
      // in another segment of the same sentence) — the full sentence is the
      // fallback evidence, never a guess.
      const supplier =
        matchEntity(supplierName, suppliers)?.entity ??
        matchEntity(text, suppliers)?.entity ??
        (ctx.fullText ? matchEntity(ctx.fullText, suppliers)?.entity : null) ??
        null
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
      const explicitName = String(f.customerName ?? f.name ?? '').trim()
      const customer = explicitName ? matchEntity(explicitName, customers)?.entity ?? null : matchEntity(text, customers)?.entity ?? null
      // A name WAS typed but it is not in the member list. Saying «لمين؟» again
      // makes the owner think the agent ignored him — name the missing person
      // and offer the fix. («اشتركت سارة …» when سارة is not registered.)
      // Name hint for the «مش مسجّل» message. Prefer the ل+name tail (glued OR
      // spaced: «لكابتن حسام», «ل كابتن حسام»), then the verb-object forms
      // «اشتراك فلان» / «جددت فلان». The word right after «اشتراك» is usually
      // the PLAN (شهري/سنوي), not a name — plan/time tokens are excluded.
      const hintedRaw =
        text.match(/(?:^|\s)ل(?:ـ)?\s*([^،,.؟?\s][^،,.؟?،]{1,19})$/)?.[1]
        ?? text.match(/(?:اشتركت|جددت|جدد|اشتراك|لـ)\s+([^\s،,؟?0-9]{2,20})/)?.[1]
      const PLAN_HINTS = /^(?:اشتراك|تجديد|شهر|شهري|شهرا|شهراً|شهريين|شهرين|شهور|شهران|سنه|سنة|سنوي|ربع|ربعين|ثلث|ثلاثه|أربعه|نص سنه|نصف سنه|سنه ونصف)$/
      const hintedName = hintedRaw && !PLAN_HINTS.test(normalizeAr(hintedRaw)) ? hintedRaw : null
      if (!customer && !explicitName && hintedName && normalizeAr(hintedName).length >= 2) {
        return {
          ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'العضو',
          failMessage: `مفيش عضو مسجّل باسم «${hintedName}» — اتأكد من الاسم أو ضيفه من شاشة الأعضاء`,
        }
      }
      // A name WAS typed («جدد اشتراك سنوي لطارق») — never re-ask «لمين؟»;
      // the unregistered-name path below handles it.
      if (!customer && !explicitName && isRenewal) return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'العضو', failMessage: 'تجديد لمين؟' }
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

    case 'price_change': {
      const rawItemName = String(f.itemName ?? f.name ?? '')
      const item = matchEntity(rawItemName || text, items)?.entity ?? null
      if (!item) return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'الصنف', failMessage: 'سعر أنهي صنف؟' }
      // Deterministic parse fills what the model missed (and wins when the
      // model only echoed a bare number).
      const parsed = parsePriceChange(text)
      const pounds =
        typeof f.newPrice === 'number' && f.newPrice > 0
          ? f.newPrice
          : typeof f.price === 'number' && f.price > 0
            ? f.price
            : parsed?.pounds ?? null
      if (pounds == null || !(pounds > 0)) {
        return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'السعر الجديد', failMessage: `سعر ${item.name} دلوقتي ${egp(item.sellPrice)} — يبقى كام؟` }
      }
      const mode = String(f.priceMode ?? parsed?.mode ?? 'absolute')
      const sign = Number(f.priceSign ?? parsed?.sign ?? 1) < 0 ? -1 : 1
      const newPrice = mode === 'delta' ? item.sellPrice + sign * Math.round(pounds * 100) : Math.round(pounds * 100)
      if (newPrice <= 0) {
        return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'السعر الجديد', failMessage: `الحساب ده هيخلي سعر ${item.name} بالسالب — السعر دلوقتي ${egp(item.sellPrice)}` }
      }
      const delta = newPrice - item.sellPrice
      const pct = item.sellPrice > 0 ? Math.round((delta / item.sellPrice) * 1000) / 10 : null
      const payload = { itemId: item.id, itemName: item.name, newPrice, field: 'sellPrice' }
      const risk = computeRisk(type)
      const summary = `سعر ${item.name}: ${egp(item.sellPrice)} ← ${egp(newPrice)}`
      const card = fieldsToCard('', type, risk, summary, [
        { label: 'الصنف', value: item.name },
        { label: 'السعر الحالي', value: egp(item.sellPrice) },
        { label: 'السعر الجديد', value: egp(newPrice) },
        ...(pct != null ? [{ label: 'التغيير', value: `${delta >= 0 ? '+' : ''}${egp(delta)}${pct !== 0 ? ` (${pct >= 0 ? '+' : ''}${pct}%)` : ''}` }] : []),
      ], [{ label: 'هامش الصنف', value: `${egp(newPrice - item.costPrice)} للوحدة بعد التغيير`, tone: newPrice - item.costPrice >= 0 ? 'good' : 'bad' }], RISK_META[risk].hint)
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
      let ref = String(f.ref ?? '') || (norm.match(/WKL-\d+/)?.[0] ?? '')
      let original = ref ? await db.operation.findFirst({ where: { businessId: business.id, ref } }) : null
      // R41 «موظف حقيقي»: no number? The owner talks about the work, not the
      // ledger — «اعكس شرا السمنه» means the most recent operation whose
      // summary carries that word. Match summary words INTO the message
      // (recent first) so the user never has to learn a ref format.
      if (!original && !ref) {
        const GENERIC = new Set(['شرا', 'شراء', 'بيع', 'عملية', 'عمليات', 'مسودة', 'قطعة', 'قطعا', 'صنف', 'جديد', 'صنف', 'يوم', 'اليوم', 'عكس', 'اعكس', 'تصحيح', 'خطأ', 'جنيه', 'المورد', 'العميل'])
        const candidates = await db.operation.findMany({
          where: { businessId: business.id, status: { in: ['SUCCEEDED', 'AWAITING_APPROVAL'] }, reversedByRef: null },
          orderBy: { createdAt: 'desc' },
          take: 12,
        })
        let best: { op: typeof candidates[number]; score: number } | null = null
        for (const c of candidates) {
          const words = new Set(normalizeAr(c.summary).replace(/[«»،,؟?!.()٠-٩0-9]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !GENERIC.has(w)))
          const score = [...words].reduce((s, w) => s + (norm.includes(w) ? 1 : 0), 0)
          if (score > 0 && (!best || score > best.score)) best = { op: c, score }
        }
        if (best) {
          original = best.op
          ref = best.op.ref
        }
      }
      // R47: «آخر بيع» / «آخر شرا» — the TYPE word pins the operation type, no
      // summary overlap needed: take the most recent op of that type.
      if (!original) {
        const typeMap: Array<[RegExp, string]> = [
          [/بيع|بعت/, 'sale'],
          [/شرا|شراء|جبت/, 'purchase'],
          [/مصروف|صرفت|صرف/, 'expense'],
          [/تحصيل|حصلت|قبض/, 'collection'],
          [/دفعة|سداد|سدد|دفع/, 'payment'],
        ]
        for (const [re, ot] of typeMap) {
          if (re.test(norm)) {
            const last = await db.operation.findFirst({
              where: { businessId: business.id, type: ot, status: 'SUCCEEDED', reversedByRef: null },
              orderBy: { createdAt: 'desc' },
            })
            if (last) {
              original = last
              ref = last.ref
            }
            break
          }
        }
        // «الغيت اللي فات» — no type word: the most recent FINANCIAL operation
        // (reversable types only — a customer_add has no reversal path).
        if (!original) {
          const last = await db.operation.findFirst({
            where: {
              businessId: business.id,
              type: { in: ['sale', 'purchase', 'expense', 'collection', 'payment', 'stock_adjustment', 'membership'] },
              status: 'SUCCEEDED',
              reversedByRef: null,
            },
            orderBy: { createdAt: 'desc' },
          })
          if (last) {
            original = last
            ref = last.ref
          }
        }
      }
      if (!original) return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'رقم العملية', failMessage: 'عايز تعكس أنهي عملية؟ اكتب رقمها (زي WKL-1006) أو اسم الصنف بتاعها' }
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
  // R39: the model may draft a catalog price change as a tool too.
  set_price: {
    opType: 'price_change',
    fields: (a) => ({ itemName: brainArgStr(a, 'item', 'itemName', 'name'), newPrice: brainArgNum(a, 'price', 'newPrice', 'amount', 'value') }),
  },
  update_price: {
    opType: 'price_change',
    fields: (a) => ({ itemName: brainArgStr(a, 'item', 'itemName', 'name'), newPrice: brainArgNum(a, 'price', 'newPrice', 'amount', 'value') }),
  },
  record_price_change: {
    opType: 'price_change',
    fields: (a) => ({ itemName: brainArgStr(a, 'item', 'itemName', 'name'), newPrice: brainArgNum(a, 'price', 'newPrice', 'amount', 'value') }),
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

// ---------------------------------------------------------------------------
// PRE-STEP WATERFALL — dsh `agent/pre-step` semantics merged into Wakil (R45).
// Every turn walks the hook list before admission; the first authoritative
// reject wins and the turn ends with a deterministic safe reply. Hooks are
// typed and ordered; adding a guard = adding one row (no core patching —
// the same «no privileged core» principle as DeepSeek Harness).
// ---------------------------------------------------------------------------

type PreStepVerdict = { ok: true } | { ok: false; reason: string; reply: string }
interface PreStepCtx {
  business: Business
  text: string
  norm: string
}

/** Pure decision: is a stated money amount absurd for THIS business?
 *  Baseline = average of recent committed ops; the flag fires at
 *  max(50× baseline, 20,000 EGP). A live typo (1,000 typed as 1,000,000)
 *  must produce a specific question, never a draft. */
export function absurdAmountCheck(
  text: string,
  baselineEgp: number,
  opts: { confirmed?: boolean } = {},
): { amountEgp: number; baselineEgp: number; multiplier: number } | null {
  if (opts.confirmed) return null
  if (!/(^| )(بعت|بيع|اشتريت|جبت|حصلت|قبضت|سددت|سداد|دفعت|ادفع|صرفت|سجل)( |$)/.test(toWesternDigits(normalizeAr(text)))) return null
  const nums = (toWesternDigits(text).match(/\d[\d,]*\.?\d*/g) ?? []).map((n) => Number(n.replace(/,/g, ''))).filter((n) => Number.isFinite(n))
  if (nums.length === 0) return null
  const amountEgp = Math.max(...nums)
  if (amountEgp < 1000) return null // small amounts are never flagged
  const hasBaseline = baselineEgp > 0
  const baseline = hasBaseline ? baselineEgp : 0
  // with a real baseline: 50× it, floored at 20k; without one: the 20k floor
  const threshold = hasBaseline ? Math.max(50 * baseline, 20000) : 20000
  if (amountEgp < threshold) return null
  return { amountEgp, baselineEgp: baseline, multiplier: hasBaseline ? Math.round(amountEgp / baseline) : 0 }
}

const WRITE_VERB_CONFIRMED_RE = /(متأكد|متاكد|مؤكد|تاكيد|تأكيد|أكيد|أكيد كده)/

async function absurdAmountHook({ business, text }: PreStepCtx): Promise<PreStepVerdict> {
  if (!WRITE_VERB_CONFIRMED_RE.test(normalizeAr(text))) {
    // baseline from the last 30 committed operations (payload totals, piastres)
    const ops = await db.operation.findMany({
      where: { businessId: business.id, status: 'COMMITTED' },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: { payload: true },
    })
    let baselineEgp = 0
    if (ops.length > 0) {
      let sum = 0
      for (const o of ops) {
        try {
          const p = JSON.parse(o.payload) as { total?: number; amount?: number }
          const v = p.total ?? p.amount ?? 0
          if (typeof v === 'number' && v > 0) sum += v
        } catch { /* op without structured payload */ }
      }
      baselineEgp = sum / ops.length / 100
    }
    const hit = absurdAmountCheck(text, baselineEgp)
    if (hit) {
      const pretty = (v: number) => Math.round(v).toLocaleString('en-US')
      return {
        ok: false,
        reason: 'absurd_amount',
        reply: `واصف قبل ما أعمل أي حاجة: المبلغ اللي في الرسالة **${pretty(hit.amountEgp)} جنيه** — ده حوالي **${pretty(hit.multiplier)}×** متوسط حركاتك (${pretty(hit.baselineEgp)} جنيه). لو الرقم صح وقصدته بالظبط، قولي «متأكد» وأنا أشغّله فورًا، ولو فيه غلطة كتابية قولي الرقم الصح.`,
      }
    }
  }
  return { ok: true }
}

async function promptBudgetAuditHook({ text }: PreStepCtx): Promise<PreStepVerdict> {
  // Audit seam (dsh `agent/request` context pressure): long turns get a
  // telemetry mark so context growth is visible, never silently dropped.
  if (text.length > 2000) {
    console.log(`[pre-step] long-turn-admitted chars=${text.length}`)
  }
  return { ok: true }
}

const PRE_STEP_HOOKS: { id: string; run: (ctx: PreStepCtx) => Promise<PreStepVerdict> }[] = [
  { id: 'absurd-amount', run: absurdAmountHook },
  { id: 'prompt-budget-audit', run: promptBudgetAuditHook },
]

async function runPreStepWaterfall(ctx: PreStepCtx): Promise<PreStepVerdict> {
  for (const h of PRE_STEP_HOOKS) {
    try {
      const v = await h.run(ctx)
      if (!v.ok) return v
    } catch {
      // A crashing hook must never block the turn (fail-open, logged).
      console.error(`[pre-step] hook ${h.id} crashed — skipped`)
    }
  }
  return { ok: true }
}


/** R44 — desk calculator, zero LLM: «حسبلي ٢٠٠ ضرب ١٥» / «١٥٪ من ٥٠ كام؟».
 * A real employee does this in his head; offline used to return a network
 * apology for the most trivial ask in the shop. Returns null when the text
 * is not a clean two-number calculation (never guesses). */
function deterministicCalc(text: string): { expr: string; value: number } | null {
  // digits first: normalizeAr keeps ٠-٩, safeCalculate would see them, but the
  // number scan below needs western digits to even COUNT them
  const s = toWesternDigits(normalizeAr(text))
  const nums = (s.match(/\d+(?:\.\d+)?/g) ?? []).map(Number).filter((n) => Number.isFinite(n))
  if (nums.length < 2) return null
  if (!/(حاسب|حسب|احسب|كم يساوي|يساوي|ضرب|اضرب|ضربه|قسمة|قسمه|تقسيم|اقسم|جمع|مجموع|زود|اضيف|اطرح|طرح|ناقص|٪|%)/.test(s)) return null
  // percent-of first: «١٥٪ من ٥٠٠» = (15/100)*500
  const mPct = s.match(/(\d+(?:\.\d+)?)\s*٪?\s*(?:من|في|ع|على)\s*(\d+(?:\.\d+)?)/)
  if (mPct && /٪|%/.test(s)) {
    const expr = `(${mPct[1]}/100)*${mPct[2]}`
    const r = safeCalculate(expr)
    if (r.ok) return { expr: `${mPct[1]}% × ${mPct[2]}`, value: r.value }
    return null
  }
  let op: string | null = null
  if (/(ضرب|اضرب|ضربه|ضربه في|x|×)/.test(s)) op = '*'
  else if (/(قسمة|قسمه|تقسيم|اقسم|÷|\/)/.test(s)) op = '/'
  else if (/(جمع|مجموع|زود|اضيف|اضيف|\+)/.test(s)) op = '+'
  else if (/(طرح|اطرح|ناقص|اقل|-)/.test(s)) op = '-'
  if (!op) return null
  const [a, b] = nums
  const expr = `${a}${op}${b}`
  const r = safeCalculate(expr)
  if (!r.ok) return null
  const sym = op === '*' ? '×' : op === '/' ? '÷' : op
  return { expr: `${a} ${sym} ${b}`, value: r.value }
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
  tasks?: SubtaskDTO[] | null
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
/**
 * R34 — the idempotency key of one draft.
 *
 * The owner's network drops mid-reply; the composer offers «جرّب تاني» with the
 * SAME `turnId`. The key is then derived from (turn, op type, summary), so the
 * retried turn hits `createDraft`'s existing-key path and gets the draft that
 * already exists instead of a twin. A turn that really does create two
 * different drafts still gets two keys (type/summary differ).
 */
const opSeqs = new WeakMap<TurnContext, Map<string, number>>()

function turnIdem(ctx: TurnContext, type: string, summary: string): string {
  const base = `${ctx.business.id}:${ctx.user.id}`
  if (!ctx.turnId) return `${base}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
  let h = 0
  const key = `${type}|${summary}`
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0
  // Two IDENTICAL ops in one turn must both be drafted («بعت ٢ لبن» مرتين) —
  // the n-th occurrence gets an `-n` suffix, and a retry replays 1,2,… in the
  // same order so it still lands on the same keys.
  let seqs = opSeqs.get(ctx)
  if (!seqs) {
    seqs = new Map()
    opSeqs.set(ctx, seqs)
  }
  const n = (seqs.get(key) ?? 0) + 1
  seqs.set(key, n)
  return `${base}:${ctx.turnId}:${type}:${(h >>> 0).toString(36)}${n > 1 ? `-${n}` : ''}`
}

export async function runAgentTurn(ctx: TurnContext, emit: TurnEmit): Promise<TurnResult> {
  return withModelHealth(() => runMeasuredTurn(ctx, emit))
}

async function runMeasuredTurn(ctx: TurnContext, emit: TurnEmit): Promise<TurnResult> {
  ensurePrismaFresh() // dev-server prisma hot-reload seam (no-op on fresh processes)
  const t0 = Date.now()
  let ttftMs: number | null = null
  let sawFirstToken = false
  const meta: TurnMeta = { kind: 'chat', fallback: false, notesJotted: 0, startedAt: t0 }
  llmHealth.retried = false
  llmHealth.fellBack = false
  llmHealth.servedBy = null
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
  void decisionEngine.syncSystemOnMutation({
    businessId: args.businessId,
    userId: args.userId,
    mutationKind: 'system_updated',
    mutationType: args.type,
    detail: args.summary,
  }).catch(() => null)
  const danger = result.findings.some((f) => f.severity === 'danger')
  return { findings: result.findings, confidence: result.confidence, risk: danger ? 'R3' : undefined, ms: result.ms }
}

async function runAgentTurnInner(ctx: TurnContext, emit: TurnEmit, meta: TurnMeta): Promise<TurnResult> {
  const liveUser = await requireBusinessUser(ctx.business.id, ctx.user.id)
  const ownedConversation = await db.conversation.findFirst({ where: { id: ctx.conversationId, businessId: ctx.business.id, userId: liveUser.id }, select: { id: true } })
  if (!ownedConversation) throw new AuthorizationError()
  ctx = { ...ctx, user: liveUser }
  const { business, user, text } = ctx
  // Manual-shop commands run before provider discovery, catalog loading, and broad cash reads.
  const cashbook = await cashbookTurn(ctx, emit)
  if (cashbook) return cashbook
  const v = getVertical(business.type)
  const model = await resolveModel(ctx.modelKey)
  const modelLabel = modelLabelFor(model)
  // «الشفافية»: when the SELECTED model cannot be reached, the user must not
  // receive an unmarked local-engine reply as if it were the model's words.
  // Set at the first provider failure; appended to the final reply.
  let providerDownNote: string | null = null
  const noteProviderDown = () => {
    if (providerDownNote || model.source !== 'external') return
    providerDownNote = `⚠️ موديل «${model.label}» مش متوصّل من السيرفر ده دلوقتي (شبكة أو مفتاح) — الرد اللي فات ده خرج من المحرك التحليلي المحلي.`
  }
  /** Append + stream the transparency note once; used on every reply path. */
  const withProviderNote = (text: string): string => {
    if (!providerDownNote || !meta.fallback) return text
    emit({ event: 'delta', text: `\n\n${providerDownNote}` })
    return `${text.trim()}\n\n${providerDownNote}`
  }

  // Load context once (memories raised to 8; pending ops count for the persona;
  // R15: «ورقة وكيل» scratchpad notes for prompt injection; R16: «أدوات
  // بتاعتك» the owner's own tools — one prompt line so the agent knows them)
  // Catalog comes from the 5-second cache (invalidated on every committed
  // write); memories/notes/tools stay live because they change mid-conversation.
  const catalogPromise = getCatalog(business.id)
  // «سرعة»: the recall pass is timed like every other pass — «فتكرت من ذاكرتي»
  // used to be the ONE step with no milliseconds, which made the trace look
  // like it had skipped work it had actually done.
  const recallClock = Date.now()
  const [{ items, customers, suppliers }, memories, pendingCount, notesSection, userTools] = await Promise.all([
    catalogPromise,
    db.agentMemory.findMany({ where: { businessId: business.id, userId: user.id, active: true }, orderBy: { updatedAt: 'desc' }, take: 80 }),
    db.operation.count({ where: { businessId: business.id, status: 'AWAITING_APPROVAL' } }),
    notesContext(ctx.conversationId),
    activeTools(business.id),
  ])
  const middlewareOut = await decisionEngine.routeAndPrepare({
    text,
    business,
    userId: user.id,
    items,
    customers,
    suppliers,
    memories,
  }).catch(() => null)

  // Only single-action short commands (< 35 chars, no questions/conjunctions/multi-step) short-circuit.
  // Complex, multi-task, or analytical prompts ALWAYS flow to the model so the agent serves the user comprehensively.
  const isDirectSingleCommand =
    !middlewareOut?.analysis?.dag?.isMultiStep &&
    text.trim().length <= 35 &&
    !/[؟?]|(ازاي|ليه|كام|مين|فين|حلل|اقترح|خطة|تاسك|مهمة|كمان|وبرضه|وفي نفس الوقت|\n)/.test(text) &&
    !text.includes(' و ') &&
    !text.includes(' ثم ') &&
    !text.includes(' مع ')

  if (isDirectSingleCommand && middlewareOut?.autoExecutedPlugin) {
    const autoExec = middlewareOut.autoExecutedPlugin
    if (autoExec.cards && autoExec.cards.length > 0) {
      emit({ event: 'cards', cards: autoExec.cards })
      return {
        replyText: `نفذتلك المطلوب مباشرة عبر قدرة «${autoExec.plugin.name}»: ${autoExec.summaryText}`,
        cards: autoExec.cards,
        modelLabel,
        thinking: [
          { label: 'محرك اتخاذ القرار (Decision Engine)', detail: `تم اختيار وتنفيذ «${autoExec.plugin.name}» مباشرة من سجل الأدوات`, state: 'done', icon: 'execute' },
        ],
      }
    }
  }

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

  // ---- PRE-STEP WATERFALL (DeepSeek-Harness `agent/pre-step`, R45) ----
  // Typed hooks validate the turn BEFORE any path is admitted (direct
  // commands, deterministic passes, or the model). A hook can authoritatively
  // REJECT — a dangerous or absurd payload never reaches the model, the user
  // gets a specific safe question instead (stop-and-ask).
  const preStep = await runPreStepWaterfall({ business, text, norm })
  if (!preStep.ok) {
    done(IDX.understand, 'بوابة الأمان قبل التنفيذ — استفسار محدد')
    done(IDX.reply)
    await streamDeterministic(preStep.reply, emit, 450)
    return { replyText: preStep.reply, card: null, cards: null, thinking: steps, modelLabel, actions: [] }
  }


  // ---- PASS 0y: Desk calculation → instant, deterministic, zero LLM (R44) ----
  // «حسبلي ٢٠ ضرب ١٥» must NEVER ride the model (offline it died as a
  // network apology; live it wasted a completion on arithmetic).
  const calc = deterministicCalc(text)
  if (calc) {
    const pretty = toArabicNum(calc.value)
    const replyText = `حسبتها لك: ${calc.expr} = **${pretty}** (${fmtCalcNumber(calc.value)}) — وأبقي معك لأي حاجة تانية من الشغل.`
    done(IDX.understand, 'حساب فوري من الحاسبة — من غير موديل')
    done(IDX.reply)
    await streamDeterministic(replyText, emit, 400)
    return { replyText, card: null, cards: null, thinking: steps, modelLabel, actions: [] }
  }

  // ---- PASS 0z: Greeting → instant, deterministic, zero LLM (R40) ----
  // «السلام عليكم» used to fall through to the model (free chat) — with no
  // live model it came back as the «النت تقيل» network message, and with a
  // weak model it could get small-talk instead of work. A greeting is a
  // greeting: warm, brief, and steered straight back to the job.
  if (isGreeting(norm)) {
    const replyText = greetingReply(user.name)
    done(IDX.understand, 'تحية — برد فور من غير موديل')
    done(IDX.reply)
    await streamDeterministic(replyText, emit, 600)
    const actions: ChatActionDTO[] = [
      { id: 'act-today', label: 'لوحة اليوم', view: 'today', icon: 'today', tone: 'primary' },
    ]
    emit({ event: 'actions', actions })
    return { replyText, card: null, cards: null, thinking: steps, modelLabel, actions }
  }

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
  if (saveRequest && containsMemorySecret(saveRequest.text)) {
    const replyText = 'لحمايتك، مش هحفظ كلمات مرور أو رموز أمان في ذاكرة المحادثة. استخدم مدير كلمات مرور أو إعدادات الأسرار المخصصة.'
    await streamDeterministic(replyText, emit, 400)
    return { replyText, modelLabel, thinking: steps, actions: null }
  }
  if (saveRequest) {
    await requirePermission(business.id, user.id, 'memory.manage')
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
    await requirePermission(business.id, user.id, 'memory.manage')
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

  // ---- PASS 0e: PENDING multi-turn request (R41 «موظف حقيقي») ----
  // The owner's information arrives in pieces: quantity + payment first,
  // supplier + total later. A real employee does not restart from zero — he
  // holds the request and asks ONE targeted question for what is missing.
  // Deterministic on purpose: the follow-up is either (a) COMPLETED → a
  // new-item purchase draft, (b) partial → one follow-up question, or
  // (c) clearly a new topic → released and handled normally.
  let pendingWriteIntent: ExtractedIntent | null = null
  /** R48: a completed credit-to-new-customer request = TWO deterministic subs. */
  let creditSubs: SubIntent[] | null = null
  if (ctx.conversationId) {
    const pending = await getActivePendingRequest(business.id, ctx.conversationId)
    if (pending && (pending.kind === 'purchase_new_item' || pending.kind === 'purchase_known_item')) {
      const isKnown = pending.kind === 'purchase_known_item'
      const suppliersNow = await db.supplier.findMany({ where: { businessId: business.id }, select: { name: true } })
      const filled = fillPendingSlots(norm, pending.slots, suppliersNow.map((s) => s.name))
      const slots: NewItemSlots = {
        ...pending.slots,
        supplierName: filled.supplierName ?? pending.slots.supplierName,
        total: filled.total ?? pending.slots.total,
        unitPrice: filled.unitPrice ?? pending.slots.unitPrice,
      }
      // The user's LATEST message overrides memory: an explicit supplier
      // always beats a stale suggestion.
      if (filled.supplierName) slots.suggestedSupplier = null
      let changed = filled.changed
      // Suggested supplier + total, no explicit supplier = the owner
      // confirmed by silence («بيتعود»: first time asks, next proposes, and
      // a total-without-objection is a yes).
      if (!slots.supplierName && slots.suggestedSupplier && (slots.total != null || slots.unitPrice != null)) {
        slots.supplierName = slots.suggestedSupplier
      }
      // A bare YES accepts the PROPOSED supplier: the question ended with
      // «نفس المورد؟» — «ايوه / نفسه / تمام» IS the answer.
      const CONFIRM_RE = /^(?:ايوه|ايوا|نعم|نفسه|نفسها|نفس المورد|تمام|موافق|اوه|اي)[\s؟?!.،,]*(?:يا\s+\S+)?[\s؟?!.،,]*$/
      if (!slots.supplierName && slots.suggestedSupplier && CONFIRM_RE.test(norm)) {
        slots.supplierName = slots.suggestedSupplier
        changed = true
      }
      // A known item prices itself from the catalog — the total is optional.
      const complete = !!slots.supplierName && slots.qty != null && (isKnown || slots.total != null || slots.unitPrice != null)
      if (!changed && looksLikeNewTopic(norm)) {
        // The owner moved on — release the request, process the new topic.
        await markPendingDone(ctx.conversationId, 'cancelled')
      } else if (complete) {
        // (a) done — the deterministic purchase draft OVERRIDES whatever the
        // model/rules would have made of this follow-up.
        pendingWriteIntent = {
          intent: 'write',
          opType: 'purchase',
          fields: {
            ...(isKnown && slots.itemId ? { itemId: slots.itemId } : {}),
            itemName: slots.itemName,
            qty: slots.qty,
            unit: slots.unit,
            unitLabel: slots.unitLabel,
            supplierName: slots.supplierName,
            total: slots.total,
            unitPrice: slots.unitPrice,
            paid: slots.paid,
            newItem: !isKnown,
          },
        }
        await markPendingDone(ctx.conversationId, 'resolved')
        // Learning loop: next time this item is mentioned, its supplier is
        // PROPOSED instead of asked. A known item with catalog pricing keeps
        // the fact price-free (the catalog is the source of truth).
        const unitPriceEgp = slots.unitPrice ?? (slots.total != null && slots.qty ? slots.total / slots.qty : null)
        const memText = isKnown && unitPriceEgp == null
          ? `${slots.itemName}: آخر مرة جت من ${slots.supplierName}`
          : `${slots.itemName}: آخر مرة جت من ${slots.supplierName} (سعر الوحدة ${egp(unitPriceEgp ?? 0)})`
        const dup = memories.some((m) => normalizeAr(m.text) === normalizeAr(memText))
        if (!dup) {
          await db.agentMemory.create({
            data: { businessId: business.id, userId: user.id, kind: 'fact', category: 'supply_chain', text: memText, confidence: 90 },
          })
        }
      } else {
        // (b) partial — or unchanged but not a new topic: ask what is
        // missing, one question, in the employee's voice.
        const q = changed ? pendingFollowUpText(slots, pending.kind) : pendingQuestionText(slots, pending.kind)
        await savePendingRequest({
          businessId: business.id,
          conversationId: ctx.conversationId,
          userId: user.id,
          kind: pending.kind,
          slots,
          question: q,
        })
        done(IDX.understand, 'طلب معلق مفتوح — بكمّل الناقص')
        done(IDX.reply)
        await streamDeterministic(q, emit, 900)
        return { replyText: q, card: null, cards: null, thinking: steps, modelLabel, actions: null }
      }
    }
    // ---- R48: CREDIT sale held for an unregistered customer ----
    // The owner's ONE answer completes it: «عليه ٢٠» (or «جديد») → register the
    // customer WITH his opening balance, then draft the sale on his account.
    if (pending && pending.kind === 'credit_new_customer') {
      const s = pending.slots
      const name = s.customerName ?? ''
      const balance = parseCreditBalance(norm)
      if (balance == null) {
        // Release ONLY on a fresh work command («بعت ٢ تونة لأم حسن» / «الغيت
        // اللي فات») or a real READ question («كم علي أم حسن؟»). Confusion
        // («ما ايه») or silence is NOT a new topic — a real employee simply
        // repeats the one question he asked.
        const readQ = (() => {
          const r = ruleBasedIntent(text, business.type)
          return r.intent === 'read' && !!r.tool && !/[0-9٠-٩]/.test(text)
        })()
        if (isCreditCommand(norm) || readQ) {
          await markPendingDone(ctx.conversationId, 'cancelled')
        } else {
          const q = pendingQuestionText(s, 'credit_new_customer')
          await savePendingRequest({
            businessId: business.id,
            conversationId: ctx.conversationId,
            userId: user.id,
            kind: 'credit_new_customer',
            slots: s,
            question: q,
          })
          done(IDX.understand, 'طلب معلق مفتوح — بكمّل الناقص')
          done(IDX.reply)
          await streamDeterministic(q, emit, 900)
          return { replyText: q, card: null, cards: null, thinking: steps, modelLabel, actions: null }
        }
      } else {
        creditSubs = [
          { intent: 'write', opType: 'customer_add', fields: { name, balance }, sourceText: text },
          {
            intent: 'write',
            opType: 'sale',
            fields: {
              ...(s.itemId ? { itemId: s.itemId } : {}),
              itemName: s.itemName,
              qty: s.qty,
              customerName: name,
              creditNewCustomer: true,
            },
            sourceText: s.sourceText || text,
          },
        ]
        await markPendingDone(ctx.conversationId, 'resolved')
        done(IDX.understand, `طلب معلق اكتمل — بتسجيل «${name}» وأنزل عليه البيعة`)
      }
    }
    // ---- R49: CASH sale drafted under a typed name («— مش مسجل») ----
    // The card's hint promised «لو عايزه مسجل قولي» — hold the name so the
    // owner's «سجله» knows WHO. No open question was asked, so: a register
    // command completes it (one customer_add draft); ANYTHING else releases
    // silently and is handled normally. Never a re-ask.
    if (pending && pending.kind === 'cash_new_customer') {
      if (isRegisterCommand(norm)) {
        const name = pending.slots.customerName ?? ''
        const balance = parseCreditBalance(norm) ?? 0
        pendingWriteIntent = { intent: 'write', opType: 'customer_add', fields: { name, balance } }
        await markPendingDone(ctx.conversationId, 'resolved')
        done(IDX.understand, `«${name}» — بتسجله عميل`)
      } else {
        await markPendingDone(ctx.conversationId, 'cancelled')
      }
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
  const autoResearchBlocked =
    wantsAutoResearch &&
    (isActionableIntent(ruleBasedIntent(text, business.type)) ||
      !!creditSubs ||
      // R49: «سجله عليه ٥٠» is a completed pending, not a research question
      !!pendingWriteIntent)
  // R48: «عليه ٢٠» (a balance answer) must never trigger auto-research — a
  // completed credit request owns the turn (creditSubs), and an answer to the
  // open credit question is a slot fill, not a research question.
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
    if (researchResult.llmFallback) {
      meta.fallback = true
      noteProviderDown() // the SELECTED model never produced the report
    }
    // stream the VERIFIED report letter-by-letter (research already emitted
    // its thinking/step/cards events incl. the sources card BEFORE any delta)
    await streamDeterministic(researchResult.reportText, emit, 2600)
    const researchFinal = withProviderNote(researchResult.reportText)
    const researchActions: ChatActionDTO[] = [
      { id: 'act-research-stats', label: 'افتح الإحصائيات', view: 'stats', icon: 'chart', tone: 'primary' },
      { id: 'act-research-journal', label: 'سجل العمليات', view: 'journal', icon: 'journal', tone: 'outline' },
    ]
    emit({ event: 'actions', actions: researchActions })
    await bumpMemoryUsage(memCtx.referencedIds)
    return {
      replyText: researchFinal,
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
    let brainTasks: SubtaskDTO[] | null = null
    const brainFacts: VerifyFact[] = []
    const allCards: ResultCardDTO[] = []
    const usedTools: string[] = []
    let draftCard: ActionCardDTO | null = null
    let draftOpId: string | undefined
    let anyDraft = false
    // R41 «موظف حقيقي»: a write that opened a pending multi-turn request —
    // its question replaces the model's reply verbatim (deterministic).
    let pendingQuestionFromWrite: string | null = null
    const replyParts: string[] = []
    const confirmedMutationReplies: string[] = []
    const resultsForModel: Record<string, unknown>[] = []
    // A tool that FAILED (missing money, over-debt collection, unknown item) —
    // the owner must hear about it even if the model answers with small talk.
    const brainFailures: string[] = []
    // The last-resort line when a tool failed without a specific message.
    const GENERIC_TOOL_FAIL = 'الإجراء المطلوب لم ينفذ أو يتأكد من السجل؛ مفيش نجاح مؤكد. راجع البيانات والصلاحيات أو حدد التفاصيل الناقصة.'
    let rounds = 0
    // R18 dedupe: the same tool+args signature must never execute twice in
    // ONE turn (the model sometimes re-issues its earlier call when it
    // echoes JSON) — a repeat reports back instead of drafting a duplicate.
    const executedSigs = new Set<string>()
    const executedResults = new Map<string, Record<string, unknown>>()

    // dynamic thinking timeline: understand(done) + mem + [tool steps…] + verify + reply
    const toolSteps: ThinkingStep[] = []

    // If decision middleware pre-executed a plugin on a complex query, provide its cards and findings to the model
    if (!isDirectSingleCommand && middlewareOut?.autoExecutedPlugin) {
      const autoExec = middlewareOut.autoExecutedPlugin
      if (autoExec.cards && autoExec.cards.length > 0) {
        allCards.push(...autoExec.cards)
        emit({ event: 'cards', cards: allCards })
        brainFacts.push(...factsFromCards(autoExec.cards))
      }
      resultsForModel.push({
        tool: autoExec.plugin.slug,
        ok: true,
        summary: autoExec.summaryText,
        pluginName: autoExec.plugin.name,
        precomputed: true,
      })
      usedTools.push(autoExec.plugin.slug)
      toolSteps.push({
        label: `القدرة الذكية: ${autoExec.plugin.name}`,
        detail: autoExec.summaryText.slice(0, 60),
        state: 'done',
        icon: 'execute',
      })
    }
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
      const sig = toolSignature(call.tool, call.args)
      if (executedSigs.has(sig)) {
        const prior = executedResults.get(sig)
        resultsForModel.push(prior ? { ...prior, duplicate: true } : { tool: call.tool, ok: false, duplicate: true, pending: true, error: 'الأداة قيد التنفيذ؛ لا تعتبر التكرار نجاحًا' })
        return
      }
      executedSigs.add(sig)
      const report = (result: Record<string, unknown>) => {
        executedResults.set(sig, result)
        if (result.ok === false && brainFailures.length === 0) brainFailures.push(GENERIC_TOOL_FAIL)
        resultsForModel.push(result)
      }
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
            report({ tool: call.tool, ok: false, error: run.error ?? 'فشل' })
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
          report({
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
            report({
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
          report({
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
          report({
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
            report({ tool: call.tool, ok: false, error: `صلاحية ${user.name} مش بتسمح بعملية ${TYPE_AR[w.opType] ?? w.opType}` })
            replyParts.push(`عملية ${TYPE_AR[w.opType] ?? w.opType} محتاجة صلاحية أعلى — مش من اختصاصك.`)
            return
          }
          const resolved = await resolveWrite({ ...ctx, text }, { intent: 'write', opType: w.opType, fields: w.fields(call.args) }, emit, memCtx)
          if (!resolved.ok) {
            step.detail = `ناقص: ${resolved.missing ?? ''}`
            if (resolved.pendingQuestion) {
              // R41: the request is HELD, not failed — a follow-up will
              // complete it. The question below REPLACES this turn's reply.
              pendingQuestionFromWrite = resolved.pendingQuestion
              report({
                tool: call.tool,
                ok: false,
                pending: true,
                error: `طلب معلق — تم حفظه والوكيل بيسأل المستخدم سؤال متابعة: ${resolved.pendingQuestion}`,
              })
              return
            }
            // Push the SPECIFIC failure first: report() seeds a generic
            // «الإجراء لم ينفذ» line only while brainFailures is still empty.
            brainFailures.push(resolved.failMessage ?? `ناقص ${resolved.missing ?? 'بيانات'} — ${TYPE_AR[resolved.opType] ?? resolved.opType} ماتسجلتش`)
            report({
              tool: call.tool,
              ok: false,
              error: `${resolved.failMessage ?? resolved.missing ?? 'ناقصة بيانات'} — العملية دي ماتسجلتش خالص، ولازم تقول للمستخدم كده بصراحة في ردك`,
            })
            replyParts.push(`طلب ناقص بيانات: ${resolved.failMessage ?? resolved.missing ?? ''}`)
            return
          }
          const idem = turnIdem(ctx, resolved.opType, resolved.summary)
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
            const escalated =
              reflection.risk === 'R3' && resolved.card.risk !== 'R3'
                ? `R3 — ${reflection.findings.find((f) => f.severity === 'danger')?.message ?? 'العملية دي محتاجة سبب'}`.trim()
                : undefined
            draftCard = {
              ...resolved.card,
              ref: draft.ref,
              opId: draft.id,
              risk: (reflection.risk === 'R3' ? 'R3' : resolved.card.risk) as typeof resolved.card.risk,
              dangerNote: escalated ?? resolved.card.dangerNote,
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
          report({ tool: call.tool, ok: true, ref: draft.ref, summary: resolved.summary, note: 'مسودة مستنية اعتماد — مبتنفذش لوحدها', ...(resolved.issues?.length ? { تنبيه: resolved.issues.join('؛ ') } : {}) })
          replyParts.push(`جهزت مسودة «${TYPE_AR[resolved.opType] ?? resolved.opType}» (${draft.ref}): ${resolved.summary} — مستنية اعتمادك.`)
          // A draft can carry a caveat the owner MUST read (e.g. the amount was
          // lowered to the real debt) — it goes through the same failure guard so
          // a chatty model can never bury it.
          if (resolved.issues?.length) brainFailures.push(...resolved.issues)
          await trackUsage(business.id, user.id, 'tool', resolved.opType)
          return
        }
        // Presentation plugins cannot execute JS/CSS, grant roles, or touch money.
        if (call.tool === 'configure_workspace') {
          const preferences = await updateWorkspacePreferences(business.id, user.id, call.args)
          report({ tool: call.tool, ok: true, preferences })
          confirmedMutationReplies.push('حفظت إعدادات واجهتك لحسابك في المنشأة دي؛ الحسابات والصلاحيات متغيرتش.')
          await trackUsage(business.id, user.id, 'tool', call.tool)
          return
        }
        if (call.tool === 'list_plugins') {
          const plugins = await getBusinessPlugins(business.id)
          report({ tool: call.tool, ok: true, plugins: plugins.map((p) => ({ slug: p.slug, name: p.name, installed: p.installed, active: p.active })) })
          return
        }
        if (call.tool === 'install_plugin') {
          await requirePermission(business.id, user.id, 'tools.manage')
          if (!/ثبت|ثبّت|ركب|ركّب|فعل|فعّل|ابني|انشئ|أنشئ|ضيف|أضف|اضف|عايز.*(?:قدرة|ميزة|نظام|أداة)/.test(text)) throw new Error('تثبيت إضافة يحتاج طلب صريح')
          const prompt = String(call.args.prompt ?? '').trim().slice(0, 1200)
          if (!prompt || containsMemorySecret(prompt)) throw new Error('وصف الإضافة غير صالح')
          const plugin = await synthesizePluginWithAI({ businessId: business.id, userId: user.id, prompt, preferredName: String(call.args.name ?? '').slice(0, 80) || undefined })
          report({ tool: call.tool, ok: true, slug: plugin.slug, name: plugin.name, active: plugin.active })
          confirmedMutationReplies.push(`ثبّت إضافة «${plugin.name}»؛ دي خطوات تحليل معتمدة، مش كود حر ولا صلاحية جديدة.`)
          return
        }
        if (call.tool === 'toggle_plugin') {
          await requirePermission(business.id, user.id, 'tools.manage')
          if (typeof call.args.active !== 'boolean') throw new Error('حدد التفعيل أو الإيقاف')
          const plugin = (await getBusinessPlugins(business.id)).find((p) => p.slug === call.args.slug && p.installed)
          if (!plugin) throw new Error('إضافة غير مثبتة في المنشأة')
          const updated = await togglePluginActive(plugin.id, call.args.active, business.id, user.id)
          if (!updated) throw new Error('لم يتأكد تغيير الإضافة')
          report({ tool: call.tool, ok: true, slug: updated.slug, active: updated.active })
          confirmedMutationReplies.push(`${updated.active ? 'فعّلت' : 'وقفت'} الإضافة «${updated.name}» في المنشأة دي.`)
          return
        }
        if (call.tool === 'run_plugin') {
          const slug = String(call.args.slug ?? '')
          const plugin = (await getActivePlugins(business.id)).find((p) => p.slug === slug)
          if (!plugin) throw new Error('الإضافة غير مثبتة أو غير مفعلة؛ اطلب تفعيلها من صاحب الصلاحية')
          const result = await executePlugin({ businessId: business.id, pluginOrSlug: slug })
          allCards.push(...result.cards)
          if (result.cards.length) emit({ event: 'cards', cards: result.cards })
          report({ tool: call.tool, ok: true, summary: result.summaryText })
          return
        }
        // ---- memory_save (the model's own long-term learning tool) ----
        if (call.tool === 'memory_save') {
          await requirePermission(business.id, user.id, 'memory.manage')
          const memText = String(call.args.text ?? '').trim().slice(0, 200)
          if (containsMemorySecret(memText)) {
            const error = 'مش هحفظ كلمات مرور أو رموز أمان في الذاكرة.'
            report({ tool: 'memory_save', ok: false, error })
            brainFailures.push(error)
            return
          }
          if (memText.length < 3) {
            report({ tool: 'memory_save', ok: false, error: 'نص فاضي' })
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
          report({ tool: 'memory_save', ok: true, saved: true, duplicate: dup })
          replyParts.push(dup ? `دي محفوظة عندي أصلًا ✅ — «${memText}»` : `اتحفظت في ذاكرتي ✅ — «${memText}»`)
          modelSavedMemory = true
          return
        }
        // ---- memory_forget ----
        if (call.tool === 'memory_forget') {
          await requirePermission(business.id, user.id, 'memory.manage')
          const q = String(call.args.query ?? call.args.text ?? '').trim()
          const target = findMemoryByReference(q, memories)
          if (target) {
            await db.agentMemory.update({ where: { id: target.id }, data: { active: false, updatedAt: new Date() } })
            step.detail = target.text.slice(0, 60)
            report({ tool: 'memory_forget', ok: true, forgotten: target.text.slice(0, 80) })
            replyParts.push(`اتمسحت من ذاكرتي ✅ — «${target.text.slice(0, 100)}»`)
          } else {
            step.detail = 'ملقيتش حاجة بالشكل ده'
            report({ tool: 'memory_forget', ok: false, error: 'ملقيتش حاجة بالشكل ده' })
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
            report({ tool: 'calculate', ok: true, expression: prettyExpr, value: calc.value })
            replyParts.push(`${prettyExpr} = ${valueAr}`)
          } else {
            step.detail = calc.error
            report({ tool: 'calculate', ok: false, error: calc.error })
          }
          await trackUsage(business.id, user.id, 'tool', 'calculate')
          return
        }
        // ---- schedule_task (R18 «مهمة مجدولة» — reminders land in the chat) ----
        if (call.tool === 'schedule_task') {
          await requirePermission(business.id, user.id, 'automation.manage')
          if (/اقترح|اقتراح|لا تنشئ|ماتفع[لّ]|نفكر/.test(text) || !/فكرني|ذكرني|جدول|تذكير|موافق|أكد|تاكيد|تأكيد/.test(text)) {
            report({ tool: call.tool, ok: false, error: 'اعرض اقتراح فقط، واطلب موافقة صريحة بالموعد والتكرار قبل إنشاء مهمة' })
            replyParts.push('ده اقتراح فقط؛ محتاج موافقتك وموعد وتكرار محددين بتوقيت القاهرة قبل التفعيل.')
            return
          }
          const title = String(call.args.title ?? call.args.reminder ?? '').trim().slice(0, 140)
          const whenLabel = String(call.args.whenLabel ?? call.args.when ?? '').trim().slice(0, 80)
          if (!title) {
            step.detail = 'عنوان المهمة فاضي'
            report({ tool: 'schedule_task', ok: false, error: 'title مطلوب' })
            return
          }
          const rawTool = String(call.args.tool ?? '').trim()
          const taskTool = READ_TOOLS.has(rawTool) ? rawTool : 'remind'
          if (rawTool && rawTool !== 'remind' && !READ_TOOLS.has(rawTool)) throw new Error('ممنوع جدولة أداة كتابة مالية')
          const when = resolveCairoSchedule(whenLabel)
          if (!when || when <= new Date()) {
            report({ tool: call.tool, ok: false, error: 'حدد موعدًا مستقبليًا مفهومًا؛ لا نفترض غدًا أو وقتًا افتراضيًا' })
            return
          }
          const recurrence = call.args.recurrence == null ? null : String(call.args.recurrence)
          if (recurrence && !['daily', 'weekly', 'monthly'].includes(recurrence)) throw new Error('تكرار غير صالح')
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
              recurrence,
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
          report({ tool: 'schedule_task', ok: true, task: title, when: whenLabel || whenAr })
          confirmedMutationReplies.push(`حفظت مهمة «${title}» في ${whenLabel} بتوقيت القاهرة${recurrence ? `؛ التكرار: ${recurrence}` : '؛ مرة واحدة'}. تقرير أو تذكير فقط، مش حركة فلوس.`)
          await trackUsage(business.id, user.id, 'tool', 'schedule_task')
          return
        }
        // ---- set_persona (R18: the model tunes its own operating tone) ----
        if (call.tool === 'set_persona') {
          await requirePermission(business.id, user.id, 'business.configure')
          const raw = String(call.args.tone ?? call.args.style ?? '').trim()
          const key = toneKey(raw)
          if (!key) {
            step.detail = 'نبرة مش معروفة'
            report({ tool: 'set_persona', ok: false, error: 'اختار: ودود / رسمي / مختصر' })
            return
          }
          await db.agentSettings.upsert({
            where: { businessId: business.id },
            update: { tone: key, updatedAt: new Date() },
            create: { businessId: business.id, vertical: business.type, tone: key },
          })
          step.detail = TONE_AR[key] ?? key
          report({ tool: 'set_persona', ok: true, tone: key })
          replyParts.push(`ظبطت نبرتي من دلوقتي ✅ — ${TONE_AR[key] ?? key}.`)
          await trackUsage(business.id, user.id, 'tool', 'set_persona')
          return
        }
        // ---- decompose_and_run_tasks / subagents coordinator ----
        if (call.tool === 'decompose_and_run_tasks' || call.tool === 'run_tasks' || call.tool === 'subagents') {
          const goal = String(call.args.goal ?? call.args.task ?? text)
          const subtasks = await decomposeGoalIntoSubtasks(goal, business.id, business.type)
          emit({ event: 'tasks', tasks: subtasks })
          step.detail = `فككت الهدف لـ ${subtasks.length} مهام ووزعتها على المتخصصين`
          const pipelineResult = await executeSubagentPipeline(subtasks, business.id, (t) => {
            emit({ event: 'task_update', task: t })
          })
          brainTasks = pipelineResult.completedTasks
          for (const c of pipelineResult.cards) allCards.push(c)
          if (allCards.length > 0) emit({ event: 'cards', cards: allCards })
          for (const t of pipelineResult.completedTasks) {
            if (t.resultSummary) replyParts.push(`- **${t.agentLabel}**: ${t.resultSummary}`)
          }
          report({
            tool: 'decompose_and_run_tasks',
            ok: true,
            tasksCount: subtasks.length,
            completed: pipelineResult.completedTasks.map((t) => ({ role: t.agentLabel, summary: t.summary })),
          })
          await trackUsage(business.id, user.id, 'tool', 'subagents_coordinator')
          return
        }
        // ---- unknown tool ----
        report({ tool: call.tool, ok: false, error: 'أداة غير معروفة' })
        step.detail = 'أداة مش معروفة — تجاهلتها'
      } catch (err) {
        console.error('[brain] tool exec failed:', call.tool, err)
        step.detail = err instanceof AuthorizationError ? 'الصلاحية لا تسمح بالإجراء' : 'تعذّر تأكيد نتيجة الإجراء'
        brainFailures.push(err instanceof AuthorizationError ? 'صلاحيتك الحالية مش بتسمح بالإجراء ده — مغيرتش صلاحياتك.' : 'تعذّر تأكيد نتيجة الإجراء من السجل؛ راجعها قبل إعادة المحاولة.')
        report({ tool: call.tool, ok: false, error: 'فشل تنفيذ الأداة' })
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
      const workspace = await getWorkspacePreferences(business.id, user.id)
      const plugins = await getActivePlugins(business.id)
      const baseBrain = buildAgentSystemPrompt({
        business,
        user,
        items,
        customers,
        suppliers,
        memories,
        snapshot,
        history: undefined, // Sent as real dialogue roles, never promoted to system authority.
        tone: settings?.tone ?? undefined,
        workspace,
        pluginsSection: pluginsPromptSection(plugins),
        middlewareRuntimeTail: middlewareOut?.dynamicRuntimeTail ?? undefined,
      })
      // R46 Mode 2: learned CLI-Anything harnesses (real executables installed on this
      // machine with the owner's permission) are appended — the model SEES them.
      const harnessBlock = await harnessesPromptBlock(business.id).catch(() => '')
      const baseBrain2 = harnessBlock ? `${baseBrain}\n\n${harnessBlock}` : baseBrain
      const brainSystem = notesSection ? `${baseBrain2}\n\n${evidenceBlock('conversation-notes', notesSection, 4_000)}` : baseBrain2
      // DeepSeek-Harness: the whole capability surface is ONE typed registry;
      // the model gets the real schemas and picks the tool itself.
      const brainTools = brainToolSchemas()
      const historyMsgs = recentDialogue(ctx.history)
      const convo: LLMMessage[] = [
        { role: 'system', content: brainSystem },
        ...historyMsgs,
        { role: 'user', content: text },
      ]
      // PROMPT-ARRIVAL AUDIT: exactly what the model receives, every turn.
      // systemChars is the FULL stable prompt (never truncated); userChars is
      // the owner's current message verbatim.
      const historyChars = historyMsgs.reduce((n, m) => n + m.content.length, 0)
      console.log(
        `[brain-audit] model=${model.key} systemChars=${brainSystem.length} historyMsgs=${historyMsgs.length} historyChars=${historyChars} userChars=${text.length} tools=${brainTools.length}`,
      )
      let raw = await completeChat(model, convo, { tools: brainTools })
      let calls = parseBrainReply(raw)
      let totalCalls = 0
      while (calls && totalCalls < 6) {
        rounds++
        convo.push({ role: 'assistant', content: raw.slice(0, 1200) })
        const batch = calls.slice(0, Math.min(4, 6 - totalCalls))
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
        console.log(
          `[brain-audit] model=${model.key} round=${rounds + 1} convoMsgs=${convo.length + 1} tools=${brainTools.length}`,
        )
        raw = await completeChat(model, convo, { tools: brainTools })
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
      noteProviderDown()
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
    // A QUESTION that the model tried to answer with a WRITE it could not even
    // fill («الاشتراكات اللي هتنتهي» → «اشتراك جديد لمين؟») is the wrong-tool
    // class the owner hears immediately. The rule ladder knows this sentence is
    // a READ; hand the turn to it instead of shipping the model's apology.
    if (!anyDraft && usedTools.length === 0 && brainFailures.length > 0) {
      const rule = ruleBasedIntent(text, business.type)
      if (rule.intent === 'read' && rule.tool) return null
    }

    if (!executedAnyTool && usedTools.length === 0 && !anyDraft && !finalText.trim()) {
      return null
    }

    // ---------- «مفيش رقم بيدخل غلط»: a FAILED tool may not be glossed over ----
    // Live evidence (R29): «حصلت ٢٠٠ من أم حسن» while she owed ١٢٥ → the tool
    // refused (correct) but the model answered with a friendly «قولّي تحب نعمل
    // إيه» and the owner never learned the operation was rejected. Any tool
    // failure the model's prose does not acknowledge is stated verbatim.
    if (brainFailures.length > 0 && executedResults.size > 0 && [...executedResults.values()].every((r) => r.ok === false)) {
      const uniq = [...new Set(brainFailures)]
      finalText = uniq.filter((f) => f !== GENERIC_TOOL_FAIL || uniq.length <= 1).join('\n\n')
      meta.fallback = true
    }
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
      const pendingHonest = /(مسود|مستني|بانتظار|اعتماد|اعتمد)/.test(t2) && !/(تم (خصم|تنفيذ|تسجيل|تحصيل|سداد)|(^|\s)(خصمت|نفذت|سجلت|حصلت|دفعت)(\s|[.،]|$))/.test(t2)
      if (!grounded || !pendingHonest) {
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

    if (!anyDraft && confirmedMutationReplies.length > 0) finalText = [...confirmedMutationReplies, ...new Set(brainFailures)].join('\n\n')

    // R41 «موظف حقيقي»: a write that OPENED a pending request — its question
    // OWNS this turn's reply. Deterministic, in the employee's voice; the
    // model's small talk never rephrases the follow-up question.
    if (pendingQuestionFromWrite) {
      finalText = pendingQuestionFromWrite
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
      tasks: brainTasks,
      thinking: steps,
      modelLabel,
      opId: draftOpId,
      actions: brainActions.length > 0 ? brainActions : null,
      verified: brainVerified.verified,
    }
  }

  // R41: a COMPLETED pending request is a deterministic write — it bypasses
  // the brain loop so the model cannot re-interpret the follow-up sentence
  // («المورد … والحساب 2000» is slots for the open request, not a new command).
  // R48: a COMPLETED credit-to-new-customer request owns the turn — it is two
  // deterministic writes, and the model (or deep research) must not take over.
  if (!pendingWriteIntent && !creditSubs) {
    // All user queries flow through the genuine Gemini model via runBrainTurn() first.
    // Rule-based intent patterns are preserved strictly as an offline fallback when the LLM
    // is unreachable or times out, never intercepting when the model is operational.
    const brainTurn = await runBrainTurn()
    if (brainTurn) return brainTurn
  }

  // Offline fallback helper patterns (used ONLY when LLM call fails or times out)
  const arithmeticRule = (() => {
    const r = ruleBasedIntent(text, business.type)
    return r.intent === 'read' && r.tool === 'get_period_totals' ? r : null
  })()
  const readQuestionRule = (() => {
    const r = ruleBasedIntent(text, business.type)
    if (r.intent !== 'read' || !r.tool) return null
    const SAFE = new Set([
      'get_daily_summary',
      'get_cash_position',
      'list_low_stock',
      'list_expiring',
      'list_receivables',
      'list_payables',
      'forecast_stockout',
      'get_profit_margin',
      'expense_breakdown',
      'compare_periods',
      'get_period_totals',
      'get_stock_value',
      'get_top_items',
      'get_dead_stock',
      'get_customer_ranking',
      'get_staff_performance',
      'get_price_check',
      'get_reorder_list',
      'get_profit_by_item',
      'get_supplier_history',
      'get_contact_info',
      'get_financial_position',
    ])
    if (!SAFE.has(r.tool)) return null
    const hasDigits = /[0-9٠-٩۰-۹]/.test(text)
    const t = normalizeAr(text).trim()
    const questionShaped =
      /[؟?]\s*$/.test(text) ||
      /^(مين|من|ايه|إيه|كام|فين|امتى|إمتى|ازاي|إزاي|ليه|هل|بكام|قدايه|قد\s*ايه|عندي|عندى|معايا|فاضل|باقي)\b/.test(t)
    return !hasDigits && questionShaped ? r : null
  })()
  const priceWriteRule = (() => {
    const r = ruleBasedIntent(text, business.type)
    return r.intent === 'write' && r.opType === 'price_change' ? r : null
  })()
  const offlineFallbackRule = priceWriteRule ?? arithmeticRule ?? readQuestionRule

  // ---- PASS 1: Understand (LLM with deterministic multi-split + rule fallback) ----
  let llmRaws: RawIntentJson[] = []
  let llmSingle: ExtractedIntent | null = null
  if (pendingWriteIntent) {
    // R41: the completed pending request OWNS this turn — no model, no rules.
    llmSingle = pendingWriteIntent
    done(IDX.understand, 'طلب معلق اكتمل — بجهّز المسودة من معلوماتك')
  } else if (creditSubs) {
    // R48: same guarantee for the two-draft credit completion.
    done(IDX.understand, 'طلب معلق اكتمل — بتسجيل العميل وأنزل عليه البيعة')
  } else {
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
      noteProviderDown()
    done(IDX.understand, 'فهمت الطلب بالقواعد المحلية (الموديل مش متاح)')
  }
  }

  // R41: a completed pending request is exactly ONE deterministic write — the
  // splitter must not fan the follow-up into a multi-intent turn.
  if (pendingWriteIntent) llmRaws = []

  const detSubs = splitSubIntents(text, business.type)

  let subs: SubIntent[] = []
  if (pendingWriteIntent) {
    // R41: the completed pending request OWNS the turn — no multi-split, no
    // rule fallback. The follow-up sentence is slots for the open request,
    // never a new command (deterministic guarantee).
  } else if (llmRaws.length >= 2) {
    subs = normalizeMultiIntents(llmRaws, text)
    if (subs.length === 1) {
      // the array collapsed to one valid request → single path with it
      const only = subs[0]
      llmSingle = { intent: only.intent, tool: only.tool, opType: only.opType, fields: only.fields, replyHint: only.replyHint }
      subs = []
    }
  } else if (!llmSingle && detSubs.length >= 2) {
    // LLM failed / offline: use deterministic multi-intent split
    subs = detSubs.map((s) => ({ ...s }))
  } else if (detSubs.length >= 2 && llmSingle?.intent === 'write') {
    subs = detSubs.map((s) => ({ ...s }))
    if (subs[0].intent === 'write') {
      subs[0] = { ...llmSingle, intent: 'write', opType: subs[0].opType, sourceText: subs[0].sourceText, fields: { ...llmSingle.fields, ...subs[0].fields } }
    }
  } else if (detSubs.length === 1 && detSubs[0].intent === 'write' && llmSingle?.intent === 'read') {
    // leading READ + trailing write the LLM caught («ملخص اليوم وبعت 10 عود»)
    subs = [detSubs[0], { intent: 'write', opType: llmSingle.opType, fields: llmSingle.fields, sourceText: text }]
  } else if (!llmSingle) {
    // Offline / LLM-failure fallback ONLY: rule-based intent
    const rule = offlineFallbackRule ?? ruleBasedIntent(text, business.type)
    llmSingle = rule
  }

  // R48: a completed credit-to-new-customer request OWNS this turn — it is
  // exactly TWO deterministic writes (register, then sell), no model, no rules.
  if (creditSubs) {
    llmRaws = []
    llmSingle = null
    subs = creditSubs
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
  let fallbackTasks: SubtaskDTO[] | null = null

  if (subs.length >= 2) {
    // ================= MULTI-INTENT TURN =================
    const N = subs.length
    const overflow = N - Math.min(N, 4)
    const capped = subs.slice(0, 4)
    fallbackTasks = await decomposeGoalIntoSubtasks(text, business.id, business.type)
    emit({ event: 'tasks', tasks: fallbackTasks })
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
        const resolved = await resolveWrite({ ...ctx, text: sub.sourceText, fullText: ctx.text }, { intent: 'write', opType, fields: sub.fields ?? {}, replyHint: sub.replyHint }, emit, memCtx)
        if (!resolved.ok) {
          steps[1 + memStep.length + i].state = 'done'
          pushThinking()
          emit({ event: 'step', label: stepLabel, state: 'done' })
          // R41: a part that OPENED a pending request — its follow-up
          // question is quoted verbatim in the combined reply.
          if (resolved.pendingQuestion) {
            situationParts.push(`الطلب ${AR_ORDINALS[i]}/${Math.min(N, 4)} — طلب معلق مفتوح`)
            replyParts.push(resolved.pendingQuestion)
            continue
          }
          situationParts.push(`الطلب ${AR_ORDINALS[i]}/${Math.min(N, 4)} — ناقص ${resolved.missing ?? ''}: ${resolved.failMessage ?? ''}`)
          replyParts.push(`طلب رقم ${AR_ORDINALS[i]} ناقص بيانات: ${resolved.failMessage ?? resolved.missing ?? ''}`)
          continue
        }
        const idem = turnIdem(ctx, resolved.opType, resolved.summary)
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
    // R46 Mode 2: when the brain surfaced the harness PERMISSION card, attach
    // server-stamped quick-consent buttons — a clarification tap, never a
    // financial approval. The owner's tap sends the consent sentence that makes
    // the brain re-invoke the tool with confirmed=true.
    if (tool === 'cli_harness_install') {
      const isPermissionCard = cards.some((c) => c.kind === 'kv' && c.title.includes('إذن البني'))
      if (isPermissionCard) {
        actions = [
          { id: 'act-harness-yes', label: 'أيوة — ابدأ', view: 'chat', icon: 'book', tone: 'primary', reply: 'أيوة — عندك الإذن، ابدأ البناء' },
          { id: 'act-harness-no', label: 'متعملش دلوقتي', view: 'chat', icon: 'book', tone: 'outline', reply: 'متعملش دلوقتي — بس قولي لو غيّرت رأيي' },
        ]
      }
    }
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
        if (resolved.pendingQuestion) {
          // R41: pending multi-turn request — the question IS the turn.
          done(IDX.verify, 'طلب معلق — بكمّل الناقص')
          done(IDX.reply)
          await streamDeterministic(resolved.pendingQuestion, emit, 900)
          return { replyText: resolved.pendingQuestion, card: null, cards: null, thinking: steps, modelLabel, actions: null }
        }
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
        const idem = turnIdem(ctx, resolved.opType, resolved.summary)
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
        // The card is what the OWNER sees. If «تأمل» escalated the draft to R3,
        // the card must say so — otherwise he approves a sensitive operation
        // with no reason prompt while the DB thinks it is R3 (live R30).
        const escalation =
          reflection.risk === 'R3' && resolved.card.risk !== 'R3'
            ? `R3 — ${reflection.findings.find((f) => f.severity === 'danger')?.message ?? 'العملية دي محتاجة سبب'}`.trim()
            : undefined
        card = {
          ...resolved.card,
          ref: draft.ref,
          opId: draft.id,
          risk: (reflection.risk === 'R3' ? 'R3' : resolved.card.risk) as typeof resolved.card.risk,
          dangerNote: escalation ?? resolved.card.dangerNote,
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
      noteProviderDown()
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
        if (chunk.type === 'reasoning') {
          continue
        }
        if (chunk.type !== 'content') continue
        replyText += chunk.text
        emit({ event: 'delta', text: chunk.text })
      }
    } catch (err) {
      console.error('[harness] reply stream failed:', err)
      noteProviderDown()
      // R44 (full-suite load flake, 33 cases): a cut-off stream must never
      // surface as a turn error. The fallback chain below renders from
      // VERIFIED state (situation / cards / permission) — no number is
      // invented, and money stays safe: draft turns never stream here (their
      // reply is the deterministic contract branch above).
      meta.fallback = true
      replyText = ''
      if (!replyText.trim()) {
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

  // ---- Transparency: an unreachable SELECTED model is never silent ----
  replyText = withProviderNote(replyText)

  // ---- PASS 5: Deep-link action buttons (after deltas, before done) ----
  if (actions && actions.length > 0) {
    emit({ event: 'actions', actions })
  }

  await bumpMemoryUsage(memCtx.referencedIds)
  return {
    replyText,
    card,
    cards,
    tasks: fallbackTasks,
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
