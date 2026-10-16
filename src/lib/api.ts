// وكيل — typed client API + SSE chat streaming reader (frontend)

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
} from './types'

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `فشل الطلب (${res.status})`)
  }
  return res.json() as Promise<T>
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? `فشل الطلب (${res.status})`)
  }
  return res.json() as Promise<T>
}

async function patch<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? `فشل الطلب (${res.status})`)
  }
  return res.json() as Promise<T>
}

async function del(url: string): Promise<void> {
  const res = await fetch(url, { method: 'DELETE' })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? `فشل الطلب (${res.status})`)
  }
}

export const api = {
  bootstrap: () => get<BootstrapDTO>('/api/bootstrap'),
  overview: (businessId: string, userId: string) =>
    get<OverviewDTO>(`/api/overview?businessId=${businessId}&userId=${userId}`),
  items: (businessId: string) => get<ItemDTO[]>(`/api/items?businessId=${businessId}`),
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
  deleteProvider: (id: string) => fetch(`/api/providers/${id}`, { method: 'DELETE' }),
  createTask: (t: { businessId: string; userId: string; title: string; tool: string; fields?: Record<string, unknown>; whenLabel?: string; recurrence?: string }) =>
    post<{ task: ScheduledTaskDTO }>('/api/tasks', t),
  tickTasks: () => post<{ ran: number; due: number }>('/api/tasks/tick', {}),
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
  onActions?: (actions: ChatActionDTO[]) => void
  onDelta?: (text: string) => void
  /** carried on the done event — R15 self-verification + deep-research metadata */
  onDone?: (
    messageId: string,
    modelLabel: string,
    meta?: { verified?: VerifyDTO; research?: ResearchDTO },
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
  },
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) {
    handlers.onError?.('مش قادر أوصل للسيرفر — جرّب تاني')
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
          | { event: 'cards'; cards: ResultCardDTO[] }
          | { event: 'actions'; actions: ChatActionDTO[] }
          | { event: 'delta'; text: string }
          | { event: 'done'; messageId: string; modelLabel: string; verified?: VerifyDTO; research?: ResearchDTO }
          | { event: 'error'; message: string }
        switch (ev.event) {
          case 'start': handlers.onStart?.(ev.conversationId, ev.messageId); break
          case 'thinking': handlers.onThinking?.(ev.steps); break
          case 'step': handlers.onStep?.(ev.label, ev.state); break
          case 'card': handlers.onCard?.(ev.card); break
          case 'cards': handlers.onCards?.(ev.cards); break
          case 'actions': handlers.onActions?.(ev.actions); break
          case 'delta': handlers.onDelta?.(ev.text); break
          case 'done':
            handlers.onDone?.(ev.messageId, ev.modelLabel, { verified: ev.verified, research: ev.research })
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
    thinking: m.thinking ?? null,
    modelLabel: m.modelLabel ?? null,
    actions: m.actions ?? null,
    createdAt: m.createdAt,
    outcome: m.outcome ?? undefined,
    research: m.research ?? null,
    verified: m.verified ?? null,
  }
}
