import { sessionFetch } from './saas/client'
// وكيل — typed client API + SSE chat streaming reader (frontend)

import { useWakil } from './store'
import type {
  BootstrapDTO,
  OverviewDTO,
  ItemDTO,
  OperationDTO,
  MessageDTO,
  CustomerDTO,
  ScheduledTaskDTO,
  MemoryDTO,
  ReportsDTO,
  ActionCardDTO,
  ChatActionDTO,
  ConversationSummaryDTO,
  QuickCommandDTO,
  ResultCardDTO,
  SuggestionDTO,
  ThinkingStep,
  ChatTurn,
  NoteDTO,
  ResearchDTO,
  VerifyDTO,
  CustomToolDTO,
  MorningBriefDTO,
  SubtaskDTO,
} from './types'

/**
 * Access token handling (see docs/SECURITY.md).
 *
 * Development demo can require a shared token. The dev client picks it up
 * from the URL once (`?token=…`), remembers it, and replays it on every call —
 * for local demos only. Production uses the explicit tab-scoped credential form.
 */
const TOKEN_LS_KEY = 'wakil.token'

function accessToken(): string | null {
  if (typeof window === 'undefined') return null
  try {
    if (process.env.NODE_ENV === 'production') return window.sessionStorage.getItem(TOKEN_LS_KEY)
    const fromUrl = new URLSearchParams(window.location.search).get('token')
    if (fromUrl) {
      window.localStorage.setItem(TOKEN_LS_KEY, fromUrl)
      // keep the token out of the address bar / history / referrer
      const clean = window.location.pathname + window.location.hash
      window.history.replaceState({}, '', clean)
      return fromUrl
    }
    return window.localStorage.getItem(TOKEN_LS_KEY)
  } catch {
    return null
  }
}

/** Pilot credentials are tab-scoped in production; never use a sharing URL. */
export function setAccessToken(token: string): void {
  window.sessionStorage.setItem(TOKEN_LS_KEY, token.trim())
  if (process.env.NODE_ENV !== 'production') window.localStorage.setItem(TOKEN_LS_KEY, token.trim())
  else window.localStorage.removeItem(TOKEN_LS_KEY)
}

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status; this.name = 'ApiError' }
}

/**
 * Every request carries the *actor context* the server needs to enforce tenant
 * isolation: which business and which user the browser is currently acting as,
 * plus the access token when one is configured. This is what lets
 * PATCH/DELETE-by-id routes prove ownership without every call site passing ids.
 */
function apiHeaders(extra?: Record<string, string>, includeActor = true): Record<string, string> {
  const headers: Record<string, string> = { ...(extra ?? {}) }
  const state = useWakil.getState()
  if (includeActor && state.businessId) headers['x-wakil-business'] = state.businessId
  if (includeActor && state.userId) headers['x-wakil-user'] = state.userId
  const token = accessToken()
  if (token) headers['x-wakil-token'] = token
  return headers
}

async function get<T>(url: string, includeActor = true): Promise<T> {
  const res = await sessionFetch(url, { cache: 'no-store', headers: apiHeaders(undefined, includeActor) })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new ApiError(body.error ?? `فشل الطلب (${res.status})`, res.status)
  }
  return res.json() as Promise<T>
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await sessionFetch(url, {
    method: 'POST',
    headers: apiHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? `فشل الطلب (${res.status})`)
  }
  return res.json() as Promise<T>
}

async function patch<T>(url: string, body: unknown): Promise<T> {
  const res = await sessionFetch(url, {
    method: 'PATCH',
    headers: apiHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? `فشل الطلب (${res.status})`)
  }
  return res.json() as Promise<T>
}

async function del(url: string): Promise<void> {
  const res = await sessionFetch(url, { method: 'DELETE', headers: apiHeaders() })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? `فشل الطلب (${res.status})`)
  }
}

export interface ItemImportResult {
  total: number
  created: number
  updated: number
  skipped: number
  unknownHeaders: string[]
  errors: { row: number; message: string }[]
  dryRun?: boolean
  preview?: { name: string; sellPrice: number; stockQty: number }[]
}

// R75 / PR-007 — onboarding state machine (Business Profile)
export interface OnboardingProfileAnswer {
  value: string | number | null
  source: 'owner'
  answeredAt: string
  skipped: boolean
  corrected?: boolean
}
export interface OnboardingProfileQuestion {
  key: string
  label: string
  help?: string
  required: boolean
  financial: boolean
  choices?: string[]
  skipAllowed: boolean
  prefill?: 'businessName' | 'businessType'
}
export interface OnboardingProfileState {
  businessId: string
  stage: 'not_started' | 'interviewing' | 'proposed' | 'confirmed'
  answers: Record<string, OnboardingProfileAnswer>
  consents: Record<string, { granted: boolean; at: string }>
  pending: string[]
  questions: OnboardingProfileQuestion[]
  openingCashStatedAt: string | null
}

export interface SearchHitDTO {
  kind: 'item' | 'customer' | 'supplier' | 'operation' | 'note'
  id: string
  title: string
  subtitle: string
  ref?: string
  tone?: 'good' | 'warn' | 'bad'
  score: number
}

export interface SearchResultDTO {
  query: string
  total: number
  groups: Record<string, number>
  results: SearchHitDTO[]
}

const patchWorkspace = (businessId: string, userId: string, value: import('./workspace-options').WorkspacePatch) => patch<import('./workspace-options').WorkspacePreferences>('/api/workspace/preferences', { businessId, userId, ...value })

export interface CashbookDTO {
  pendingOps: OperationDTO[]
  cash: number | null
  openingCashKnown: boolean
  currentCashKnown: boolean
  cashIn: number
  cashOut: number
  cashCountAdjustment: number
  receivable: number; payable: number; today: string
  reminders: { id: string; subject: string }[]
  customers: { id: string; name: string; balance: number }[]
  suppliers: { id: string; name: string; balance: number }[]
  entries: { id: string; kind: string; amount: number; partyName: string; dateSource: string; occurredOn: string; dueOn: string | null; cashDelta: number; operationRef: string; recordedAt: string; note: string; operation: { reversedByRef: string | null } }[]
}
export const api = {
  speechStatus: () => get<{ available: boolean; providerLabel: string | null }>('/api/speech'),
  speechSettings: () => get<{ providerId: string; remoteId: string }>('/api/speech/settings'),
  saveSpeechSettings: (body: { providerId: string; remoteId: string } | { disabled: true }) => post('/api/speech/settings', body),
  transcribe: async (audio: Blob, signal?: AbortSignal) => {
    const res = await sessionFetch('/api/speech', { method: 'POST', headers: apiHeaders({ 'content-type': audio.type, 'x-wakil-audio-consent': 'review-only' }), body: audio, signal })
    const result = await res.json()
    if (!res.ok) throw new ApiError(result.error ?? 'تعذر تحويل التسجيل', res.status)
    return result as { text: string; reviewRequired: true }
  },

  cashbook: (businessId: string, userId: string) => get<CashbookDTO>(`/api/cashbook?businessId=${encodeURIComponent(businessId)}&userId=${encodeURIComponent(userId)}`),
  setWorkflow: (mode: 'cashbook' | 'inventory', businessId: string, userId: string) => post<{ mode: string }>('/api/cashbook', { mode, businessId, userId }),
  workspacePreferences: (businessId: string, userId: string) => get<import('./workspace-options').WorkspacePreferences>(`/api/workspace/preferences?businessId=${encodeURIComponent(businessId)}&userId=${encodeURIComponent(userId)}`),
  updateWorkspacePreferences: (businessId: string, userId: string, patch: import('./workspace-options').WorkspacePatch) => patchWorkspace(businessId, userId, patch),
  bootstrap: () => get<BootstrapDTO>('/api/bootstrap', false),
  createBusiness: (body: { name: string; type: string; ownerName?: string; openingCash?: number; customItems?: string[] }) =>
    post<{ business: import('./types').BusinessLite }>('/api/bootstrap', body),
  overview: (businessId: string, userId: string) =>
    get<OverviewDTO>(`/api/overview?businessId=${businessId}&userId=${userId}`),
  items: (businessId: string) => get<ItemDTO[]>(`/api/items?businessId=${businessId}`),
  importItems: (body: {
    businessId: string
    userId: string
    csv: string
    updateExisting?: boolean
    dryRun?: boolean
  }) => post<ItemImportResult>('/api/items/import', body),
  // R75 / PR-007 — the onboarding state machine (Business Profile)
  onboardingProfile: (businessId: string, userId: string) =>
    get<OnboardingProfileState>(`/api/onboarding/profile?businessId=${businessId}&userId=${userId}`),
  answerOnboardingProfile: (businessId: string, userId: string, key: string, value?: string | number | null, skip = false) =>
    post<OnboardingProfileState>('/api/onboarding/profile', { businessId, userId, key, value, skip }),
  setOnboardingConsent: (businessId: string, userId: string, key: string, granted: boolean) =>
    post<OnboardingProfileState>('/api/onboarding/profile/consent', { businessId, userId, key, granted }),
  confirmOnboardingProfile: (businessId: string, userId: string) =>
    post<OnboardingProfileState>('/api/onboarding/profile/confirm', { businessId, userId }),
  search: (businessId: string, q: string, limit = 12) =>
    get<SearchResultDTO>(`/api/search?businessId=${businessId}&q=${encodeURIComponent(q)}&limit=${limit}`),
  operations: (businessId: string, status?: string) =>
    get<OperationDTO[]>(`/api/operations?businessId=${businessId}${status ? `&status=${status}` : ''}`),
  chat: (
    businessId: string,
    userId: string,
    /** when set → load THIS conversation's history (null → latest) */
    conversationId?: string | null,
  ) =>
    get<{ conversation: { id: string; title: string; createdAt: string; updatedAt: string }; messages: MessageDTO[] }>(
      `/api/chat?businessId=${businessId}&userId=${userId}${conversationId ? `&conversationId=${conversationId}` : ''}`,
    ),
  members: (businessId: string) => get<CustomerDTO[]>(`/api/members?businessId=${businessId}`),
  tasks: (businessId: string) =>
    get<{ tasks: ScheduledTaskDTO[] }>(`/api/tasks?businessId=${businessId}`).then((r) =>
      Array.isArray(r) ? (r as unknown as ScheduledTaskDTO[]) : r.tasks,
    ),
  memories: (businessId: string) => get<MemoryDTO[]>(`/api/memories?businessId=${businessId}`),
  reports: (businessId: string, range: '7d' | '30d') =>
    get<ReportsDTO>(`/api/reports?businessId=${businessId}&range=${range}`),
  providers: () => get<{ providers: import('./types').ProviderDTO[] }>('/api/providers'),
  addProvider: (p: { name: string; baseUrl: string; apiKey: string }) =>
    post<{ provider: import('./types').ProviderDTO }>('/api/providers', p),
  saveProviderModels: (id: string, models: { remoteId: string; label: string; tier: string; enabled: boolean }[]) =>
    post<{ provider: import('./types').ProviderDTO }>(`/api/providers/${id}`, { models }),
  deleteProvider: (id: string) => fetch(`/api/providers/${id}`, { method: 'DELETE', headers: apiHeaders() }),
  createTask: (t: { businessId: string; userId: string; title: string; tool: string; fields?: Record<string, unknown>; whenLabel?: string; recurrence?: string }) =>
    post<{ task: ScheduledTaskDTO }>('/api/tasks', t),
  tickTasks: (opts?: { businessId?: string; force?: boolean; taskIds?: string[] }) =>
    post<{ ran: number; due: number }>('/api/tasks/tick', opts ?? {}),
  addMemory: (m: { businessId: string; userId: string; text: string; kind?: string }) =>
    post<MemoryDTO>('/api/memories', m),
  confirmOperation: (opId: string, action: 'approve' | 'reject', userId: string, reason?: string) =>
    post<{ operation: OperationDTO; outcome?: { ok: boolean; checks: { label: string; expected: string; actual: string; pass: boolean }[]; effects: { label: string; value: string; tone: string }[]; failReason?: string } }>(
      `/api/operations/${opId}/confirm`,
      { action, userId, reason },
    ),
  // — المحادثات (سجل المحادثات القديمة)
  conversations: (businessId: string, userId: string) =>
    get<ConversationSummaryDTO[]>(`/api/conversations?businessId=${businessId}&userId=${userId}`),
  createConversation: (businessId: string, userId: string, title?: string) =>
    post<ConversationSummaryDTO>('/api/conversations', { businessId, userId, title }),
  updateConversation: (id: string, patchBody: { title?: string; pinned?: boolean; archived?: boolean }) =>
    patch<ConversationSummaryDTO>('/api/conversations', { id, ...patchBody }),
  deleteConversation: (id: string) => del(`/api/conversations?id=${id}`),
  // — الاقتراحات الديناميكية (بتتغير مع شغلك)
  suggestions: (businessId: string, userId: string) =>
    get<SuggestionDTO[]>(`/api/suggestions?businessId=${businessId}&userId=${userId}`),
  // — «ابدأ يومك»: تلات توصيات محسوبة من السجل نفسه (بدون موديل)
  morningBrief: (businessId: string, userId: string) =>
    get<MorningBriefDTO>(`/api/morning-brief?businessId=${businessId}&userId=${userId}`),
  // — أدواتك السريعة (user-extensible tools)
  quickCommands: (businessId: string) => get<QuickCommandDTO[]>(`/api/quick-commands?businessId=${businessId}`),
  createQuickCommand: (c: { businessId: string; userId: string; label: string; prompt: string; icon: string }) =>
    post<QuickCommandDTO>('/api/quick-commands', c),
  updateQuickCommand: (
    id: string,
    patchBody: { label?: string; prompt?: string; icon?: string; sortOrder?: number },
  ) => patch<QuickCommandDTO>('/api/quick-commands', { id, ...patchBody }),
  touchQuickCommand: (id: string) => patch<QuickCommandDTO>('/api/quick-commands', { id, touch: true }),
  deleteQuickCommand: (id: string) => del(`/api/quick-commands?id=${id}`),
  // — ورقة وكيل (scratchpad notes — the agent writes, the UI reads only)
  notes: (businessId: string, conversationId: string) =>
    get<NoteDTO[]>(`/api/notes?businessId=${businessId}&conversationId=${conversationId}`),
  // — أدوات بتاعتك (R16 — user-extensible tools the agent runs during deep research)
  tools: (businessId: string, userId: string) =>
    get<CustomToolDTO[]>(`/api/tools?businessId=${businessId}&userId=${userId}`),
  createTool: (t: { businessId: string; userId: string; name: string; kind: string; config: Record<string, unknown> }) =>
    post<CustomToolDTO>('/api/tools', t),
  updateTool: (id: string, patchBody: { active?: boolean; name?: string; config?: Record<string, unknown> }) =>
    patch<CustomToolDTO>('/api/tools', { id, ...patchBody }),
  deleteTool: (id: string) => del(`/api/tools?id=${id}`),
  // — معمارية البلاجنز الذكية (Dynamic AI Plugin Harness)
  plugins: (businessId: string) =>
    get<{ plugins: import('./types').AgentPluginDTO[] }>(`/api/plugins?businessId=${businessId}`).then((r) => r.plugins),
  installPlugin: (body: { businessId: string; userId: string; prompt?: string; slug?: string; name?: string; runImmediately?: boolean }) =>
    post<{
      plugin: import('./types').AgentPluginDTO
      cards?: ResultCardDTO[]
      alerts?: import('./types').ProactiveAlertDTO[]
      summaryText?: string
    }>('/api/plugins', { ...body, action: 'install' }),
  runPlugin: (body: { businessId: string; slug: string }) =>
    post<{
      plugin: import('./types').AgentPluginDTO
      cards: ResultCardDTO[]
      alerts: import('./types').ProactiveAlertDTO[]
      summaryText: string
    }>('/api/plugins', { ...body, action: 'run' }),
  togglePlugin: (id: string, active: boolean) =>
    patch<{ plugin: import('./types').AgentPluginDTO }>('/api/plugins', { id, active }),
  deletePlugin: (id: string) => del(`/api/plugins?id=${id}`),
  // — محرك المهام الخلفية المتوازية ورادار المخاطر والفرص (Concurrent Background Tasks & Proactive Alerts)
  backgroundTasks: (businessId: string) =>
    get<{
      jobs: import('./types').BackgroundJobDTO[]
      proactiveAlerts: import('./types').ProactiveAlertDTO[]
    }>(`/api/background-tasks?businessId=${businessId}`),
  dispatchBackgroundTasks: (body: {
    businessId: string
    userId: string
    conversationId?: string | null
    jobKinds?: import('./types').BackgroundJobKind[]
    catalogUpdates?: { name: string; sellPriceEgp?: number; buyPriceEgp?: number; stockQty?: number; minQty?: number }[]
    postToChat?: boolean
  }) => post<import('./types').BackgroundBatchResultDTO>('/api/background-tasks', body),
}

// ---------------------------------------------------------------------------
// SSE chat streaming — the حرف بحرف reader
// ---------------------------------------------------------------------------
export interface StreamHandlers {
  /** start carries BOTH the conversation id and the persisted user-message id —
   *  the caller can swap the optimistic local user turn id for the real one so
   *  later refetches reconcile by key (zero remount flicker). */
  onStart?: (conversationId: string, userMessageId: string) => void
  onThinking?: (steps: ThinkingStep[]) => void
  onStep?: (label: string, state: 'active' | 'done') => void
  onCard?: (card: ActionCardDTO) => void
  onCards?: (cards: ResultCardDTO[]) => void
  /** R28: the read-only plan the agent is about to run (label per step) */
  onPlan?: (steps: string[]) => void
  /** Autonomous sub-agent coordinator decomposition tasks */
  onTasks?: (tasks: SubtaskDTO[]) => void
  onTaskUpdate?: (task: SubtaskDTO) => void
  onActions?: (actions: ChatActionDTO[]) => void
  onDelta?: (text: string) => void
  /** carried on the done event — R15 self-verification + deep-research metadata */
  onDone?: (
    messageId: string,
    modelLabel: string,
    meta?: { verified?: VerifyDTO; research?: ResearchDTO; tasks?: SubtaskDTO[] },
  ) => void
  onError?: (message: string) => void
}

export async function streamChat(
  body: {
    businessId: string
    userId: string
    text: string
    modelKey?: string | null
    conversationId?: string | null
    /** set when the user tapped a suggestion chip — feeds the usage ranking */
    suggestionId?: string | null
    /** R15 — «بحث عميق» composer toggle: force the plan-and-execute research pipeline */
    deepResearch?: boolean
    /** R34 — stable per-send id so «جرّب تاني» is idempotent on the server */
    turnId?: string
  },
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await sessionFetch('/api/chat', {
    method: 'POST',
    headers: apiHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) {
    // «الرد الصح للخطأ الصح»: 429 is the one status the owner can fix himself
    // (he typed too fast), and the server already says how long to wait — a
    // generic «مش قادر أوصل» made a working server look broken (live R29).
    if (res.status === 429) {
      const body = (await res.json().catch(() => ({}))) as { error?: string; retryAfter?: number }
      const secs = Number(body.retryAfter ?? 0) || 0
      handlers.onError?.(body.error ?? `طلبات كتير في وقت قصير — استنى ${secs || 5} ثانية وجرّب تاني`)
      return
    }
    handlers.onError?.(res.status === 401 ? 'الجلسة انتهت — حدّث الصفحة' : 'مش قادر أوصل للسيرفر — جرّب تاني')
    return
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      const line = part.trim()
      if (!line.startsWith('data:')) continue
      try {
        const ev = JSON.parse(line.slice(5).trim()) as
          | { event: 'start'; conversationId: string; messageId: string }
          | { event: 'thinking'; steps: ThinkingStep[] }
          | { event: 'step'; label: string; state: 'active' | 'done' }
          | { event: 'card'; card: ActionCardDTO }
          | { event: 'plan'; steps: string[] }
          | { event: 'tasks'; tasks: SubtaskDTO[] }
          | { event: 'task_update'; task: SubtaskDTO }
          | { event: 'cards'; cards: ResultCardDTO[] }
          | { event: 'actions'; actions: ChatActionDTO[] }
          | { event: 'delta'; text: string }
          | { event: 'done'; messageId: string; modelLabel: string; verified?: VerifyDTO; research?: ResearchDTO; tasks?: SubtaskDTO[] }
          | { event: 'error'; message: string }
        switch (ev.event) {
          case 'start': handlers.onStart?.(ev.conversationId, ev.messageId); break
          case 'thinking': handlers.onThinking?.(ev.steps); break
          case 'step': handlers.onStep?.(ev.label, ev.state); break
          case 'card': handlers.onCard?.(ev.card); break
          case 'plan': handlers.onPlan?.(ev.steps); break
          case 'tasks': handlers.onTasks?.(ev.tasks); break
          case 'task_update': handlers.onTaskUpdate?.(ev.task); break
          case 'cards': handlers.onCards?.(ev.cards); break
          case 'actions': handlers.onActions?.(ev.actions); break
          case 'delta': handlers.onDelta?.(ev.text); break
          case 'done':
            handlers.onDone?.(ev.messageId, ev.modelLabel, { verified: ev.verified, research: ev.research, tasks: ev.tasks })
            break
          case 'error': handlers.onError?.(ev.message); break
        }
      } catch {
        // ignore malformed event
      }
    }
  }
}

/** ChatTurn + the R15 deep-research / self-verification metadata persisted on the message. */
export type ChatTurnWithMeta = ChatTurn & {
  /** deep-research metadata (plan + cited sources) — «وضع البحث» */
  research?: ResearchDTO | null
  /** self-verification ledger — «اتأكدت الأرقام» */
  verified?: VerifyDTO | null
}

export function messageToTurn(m: MessageDTO): ChatTurnWithMeta {
  return {
    id: m.id,
    role: m.role,
    text: m.text,
    card: m.card ?? null,
    cards: m.cards ?? null,
    tasks: m.tasks ?? null,
    thinking: m.thinking ?? null,
    modelLabel: m.modelLabel ?? null,
    actions: m.actions ?? null,
    createdAt: m.createdAt,
    outcome: m.outcome ?? undefined,
    research: m.research ?? null,
    verified: m.verified ?? null,
  }
}
