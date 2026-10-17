// وكيل — shared type contracts

export type Vertical = 'supermarket' | 'gym' | 'pharmacy' | 'attar'
export type Role = 'owner' | 'cashier' | 'reception' | 'supervisor'
export type Risk = 'R0' | 'R1' | 'R2' | 'R3' | 'R4'
export type OpStatus =
  | 'RECEIVED'
  | 'AWAITING_APPROVAL'
  | 'EXECUTING'
  | 'SUCCEEDED'
  | 'FAILED_SAFE'
  | 'OUTCOME_UNKNOWN'
  | 'CANCELLED'

export type OpType =
  | 'sale'
  | 'purchase'
  | 'expense'
  | 'collection'
  | 'payment'
  | 'stock_adjustment'
  | 'membership'
  | 'attendance'
  /** R29: master data the owner can create by talking — «ضيف أحمد وعليه ٥٠٠» */
  | 'customer_add'
  | 'supplier_add'
  | 'reversal'

export interface BusinessLite {
  id: string
  name: string
  type: Vertical
  users: UserLite[]
}
export interface UserLite {
  id: string
  name: string
  role: Role
  title?: string | null
}

export interface ItemDTO {
  id: string
  name: string
  aliases: string
  unit: string
  category: string
  costPrice: number // piastres
  sellPrice: number
  stockQty: number
  lowStockThreshold: number
  barcode?: string | null
  batchNo?: string | null
  expiresAt?: string | null
  daysToExpiry?: number | null
  valueAtCost?: number
}

export interface CustomerDTO {
  id: string
  name: string
  phone?: string | null
  balance: number
  plan?: string | null
  expiresAt?: string | null
  daysLeft?: number | null
}
export interface SupplierDTO {
  id: string
  name: string
  phone?: string | null
  balance: number
}

export interface OperationDTO {
  id: string
  ref: string
  type: OpType
  status: OpStatus
  source: string
  risk: Risk
  summary: string
  payload: Record<string, unknown>
  result?: Record<string, unknown> | null
  userId: string
  userName?: string
  reason?: string | null
  failReason?: string | null
  createdAt: string
  executedAt?: string | null
  decidedAt?: string | null
  reversalOfRef?: string | null
  reversedByRef?: string | null
}

export interface AlertDTO {
  level: 'info' | 'warning' | 'danger'
  text: string
  action?: { label: string; view?: string }
}

export interface OverviewDTO {
  cash: { opening: number; in: number; out: number; net: number }
  today: {
    sales: number
    purchases: number
    expenses: number
    collections: number
    payments: number
    /** every op touched today (drafts included) */
    opsCount: number
    /** ops that actually EXECUTED today — 0 means «النهاردة لسه مفيش حركة» */
    doneCount: number
  }
  pendingOps: OperationDTO[]
  lowStock: ItemDTO[]
  expiring: ItemDTO[]
  receivables: CustomerDTO[]
  payables: SupplierDTO[]
  recentOps: OperationDTO[]
  alerts: AlertDTO[]
}

export interface MessageDTO {
  id: string
  role: 'user' | 'assistant'
  text: string
  card?: ActionCardDTO | null
  cards?: ResultCardDTO[] | null
  /** R28: read-only plan labels the agent announced before running it */
  plan?: string[] | null
  thinking?: ThinkingStep[] | null
  modelLabel?: string | null
  /** deep-link action buttons rendered under the reply (e.g. «افتح الإحصائيات») */
  actions?: ChatActionDTO[] | null
  /** post-execution outcome synced from the operation's current state */
  outcome?: CardOutcomeDTO | null
  /** deep-research metadata (plan + cited sources) — R15 */
  research?: ResearchDTO | null
  /** self-verification result — R15 («اتأكدت الأرقام») */
  verified?: VerifyDTO | null
  createdAt: string
}

/** A deep-link button the agent attaches to a reply — وكيل بيفهم التطبيق كله */
export interface ChatActionDTO {
  id: string
  label: string
  view: 'chat' | 'today' | 'inventory' | 'journal' | 'accounts' | 'stats' | 'reports' | 'settings'
  icon?: 'chart' | 'boxes' | 'users' | 'wallet' | 'today' | 'journal' | 'book'
  tone?: 'primary' | 'outline'
}

export interface CardOutcomeDTO {
  ok: boolean
  checks: { label: string; expected: string; actual: string; pass: boolean }[]
  effects: { label: string; value: string; tone: string }[]
  failReason?: string
}

export interface ActionCardDTO {
  kind: 'draft'
  opId?: string
  ref: string
  type: OpType
  risk: Risk
  title: string
  summary: string
  fields: { label: string; value: string; hint?: string }[]
  effects: { label: string; value: string; tone?: 'good' | 'bad' | 'neutral' }[]
  status: OpStatus
  dangerNote?: string
  /** Self-critique findings shown BEFORE the owner approves. */
  audit?: AuditFindingDTO[]
  /** 0..100 — deterministic confidence derived from the audit. */
  confidence?: number
}

export type ResultCardDTO =
  | {
      kind: 'table'
      title: string
      columns: { key: string; label: string; align?: 'start' | 'end' }[]
      rows: Record<string, string>[]
      footer?: { label: string; value: string }[]
    }
  | { kind: 'kv'; title: string; rows: { label: string; value: string }[] }
  | { kind: 'text'; title: string; body: string }
  | { kind: 'sources'; title: string; sources: SourceDTO[] }

/** «تأمل وكيل» — one deterministic finding about a draft. */
export interface AuditFindingDTO {
  code: 'price_anomaly' | 'oversell' | 'duplicate' | 'overpay' | 'expense_spike' | 'unknown_entity'
  severity: 'info' | 'warn' | 'danger'
  message: string
  detail?: string
}

export interface ThinkingStep {
  label: string // e.g. «بفهم الطلب»
  detail: string
  state: 'done' | 'active' | 'pending'
  icon?: 'understand' | 'search' | 'plan' | 'execute' | 'verify' | 'research' | 'note'
  /** Measured wall-clock cost of this pass (ms) — the «سرعة» signal. */
  ms?: number
}

// ---------------------------------------------------------------------------
// R15 — «الموظف الحقيقي»: deep research + scratchpad + self-verification

/** A cited source gathered during deep research (OpenAI-style numbered citations). */
export interface SourceDTO {
  title: string
  url?: string | null
  snippet?: string | null
  host?: string | null
  /** internal evidence ref (e.g. WKL-2027 / items table) when source is the business DB */
  ref?: string | null
}

/** Persisted on the assistant message when the turn ran in research mode. */
export interface ResearchDTO {
  mode: 'auto' | 'forced' // detected from the text vs user-toggled
  plan: string[] // the plan shown BEFORE gathering («خطة البحث»)
  sources: SourceDTO[] // numbered [١] [٢] … citations
  stepsCount: number
}

/** Self-verification ledger — checked BEFORE the user sees the reply. */
export interface VerifyDTO {
  status: 'verified' | 'corrected' | 'skipped'
  checks: { claim: string; expected: string; actual: string; ok: boolean }[]
  note?: string
}

/** One row of the agent's scratchpad («ورقة وقلم») per conversation. */
export interface NoteDTO {
  id: string
  kind: 'fact' | 'hypothesis' | 'todo' | 'plan' | 'citation'
  text: string
  source?: string | null
  pinned: boolean
  createdAt: string
}

// R16 — «أدوات بتاعتك»: user-extensible tools the agent actually uses
// (web sources scoped to a site + read-only, SSRF-guarded webhooks).

/** A tool the shop owner added himself — the deep-research pipeline runs it. */
export interface CustomToolDTO {
  id: string
  name: string
  kind: 'web_source' | 'webhook'
  /** per-kind shape (only the fields relevant to `kind` are filled) */
  config: {
    /** web_source: hostname only, no scheme (e.g. drogal.com) */
    site?: string
    /** web_source: optional search-term template (defaults to the question) */
    queryTemplate?: string
    /** webhook: full http(s) URL */
    url?: string
    /** webhook: GET | POST (default GET) */
    method?: string
    /** webhook: optional JSON body template */
    bodyTemplate?: string
    /** webhook: optional free-text note */
    note?: string
  }
  active: boolean
  usageCount: number
  lastUsedAt?: string
}

export interface BootstrapDTO {
  businesses: BusinessLite[]
  providers: ProviderDTO[]
}

export interface ProviderDTO {
  id: string
  name: string
  baseUrl: string
  models: ModelConfigDTO[]
}
export interface ModelConfigDTO {
  id: string
  remoteId: string
  label: string
  tier: 'air' | 'balanced' | 'deep'
  enabled: boolean
  /** Last live probe of this model — null means «لسه مااتفحصش». */
  health?: {
    ok: boolean
    supportsTools: boolean
    supportsStreaming: boolean
    ttftMs: number | null
    note: string | null
    checkedAt: string
  } | null
}

export interface ScheduledTaskDTO {
  id: string
  title: string
  tool: string
  fields: Record<string, unknown>
  whenLabel: string
  scheduledFor: string
  recurrence?: string | null
  status: 'pending' | 'done' | 'failed' | 'cancelled'
  result?: string | null
  failReason?: string | null
  executedAt?: string | null
  createdAt: string
}

export interface MemoryDTO {
  id: string
  kind: 'fact' | 'preference' | 'rule' | 'lexicon' | 'insight'
  category: string
  text: string
  entityRef?: string | null
  confidence: number
  usageCount: number
  active: boolean
  createdAt: string
  updatedAt: string
}

/** One entry in the conversation list (سجل المحادثات القديمة) */
export interface ConversationSummaryDTO {
  id: string
  title: string
  pinned: boolean
  archived: boolean
  lastMessageAt: string
  messageCount: number
  /** preview of the last message (plain text, trimmed) */
  preview: string
  createdAt: string
}

/** A dynamic quick-command chip — computed from live data + usage history (بتتغير مع شغلك) */
/** «ابدأ يومك» — rendered at the top of اليوم; each item is a ready prompt. */
export interface MorningBriefDTO {
  headline: string
  items: {
    id: string
    tone: 'money' | 'stock' | 'time' | 'risk'
    title: string
    why: string
    impact: number
    cta: { label: string; prompt?: string; view?: string }
  }[]
}

export interface SuggestionDTO {
  id: string
  label: string
  /** the exact text sent to the agent when the chip is tapped */
  prompt: string
  reason: 'frequent' | 'alert' | 'vertical' | 'time' | 'memory' | 'custom'
  reasonLabel: string // «بتستخدمه كتير» / «فيه تنبيه» / «خاص بشغلك»
  icon: 'spark' | 'boxes' | 'users' | 'wallet' | 'chart' | 'book' | 'today' | 'alert'
  tone?: 'primary' | 'outline'
}

/** A user-defined tool — أدواتك السريعة (user-extensible tools) */
export interface QuickCommandDTO {
  id: string
  label: string
  prompt: string
  icon: string
  sortOrder: number
  usageCount: number
  createdAt: string
}

/** Owner-only anomaly insight from the honesty radar (رادار الأمانة) */
export interface RadarInsightDTO {
  id: string
  level: 'info' | 'warning' | 'danger'
  title: string
  detail: string
  evidence: { label: string; ref?: string; view: 'journal' | 'accounts' | 'inventory' }[]
}

/** Provider capability probe result (فاحص المزود) */
export interface ProbeResultDTO {
  modelConfigId: string
  ok: boolean
  supportsStreaming: boolean
  supportsTools: boolean
  ttftMs?: number | null
  tps?: number | null
  note?: string | null
}

export interface ReportsDTO {
  range: '7d' | '30d'
  daily: { date: string; sales: number; purchases: number; expenses: number; collections: number; payments: number }[]
  totals: { sales: number; purchases: number; expenses: number; collections: number; payments: number; net: number }
  topItems: { name: string; qty: number; revenue: number }[]
  byType: { type: string; count: number; amount: number }[]
}

// SSE chat stream events (POST /api/chat)
export type ChatStreamEvent =
  | { event: 'start'; conversationId: string; messageId: string }
  | { event: 'thinking'; steps: ThinkingStep[] }
  | { event: 'step'; label: string; state: 'active' | 'done' }
  | { event: 'card'; card: ActionCardDTO }
  | { event: 'cards'; cards: ResultCardDTO[] }
  /** R28: the plan the agent is about to run (multi-step, read-only) */
  | { event: 'plan'; steps: string[] }
  | { event: 'actions'; actions: ChatActionDTO[] }
  | { event: 'delta'; text: string }
  | { event: 'done'; messageId: string; modelLabel: string }
  | { event: 'error'; message: string }

export interface ChatTurn {
  id: string
  role: 'user' | 'assistant'
  text: string
  card?: ActionCardDTO | null
  cards?: ResultCardDTO[] | null
  plan?: string[] | null
  thinking?: ThinkingStep[] | null
  modelLabel?: string | null
  actions?: ChatActionDTO[] | null
  createdAt: string
  streaming?: boolean
  /** post-execution verification shown inside the action card */
  outcome?: {
    ok: boolean
    checks: { label: string; expected: string; actual: string; pass: boolean }[]
    effects: { label: string; value: string; tone: string }[]
    failReason?: string
  }
}
