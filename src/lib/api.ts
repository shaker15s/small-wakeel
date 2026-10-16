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
  ResultCardDTO,
  ThinkingStep,
  ChatTurn,
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

export const api = {
  bootstrap: () => get<BootstrapDTO>('/api/bootstrap'),
  overview: (businessId: string, userId: string) =>
    get<OverviewDTO>(`/api/overview?businessId=${businessId}&userId=${userId}`),
  items: (businessId: string) => get<ItemDTO[]>(`/api/items?businessId=${businessId}`),
  operations: (businessId: string, status?: string) =>
    get<OperationDTO[]>(`/api/operations?businessId=${businessId}${status ? `&status=${status}` : ''}`),
  chat: (businessId: string, userId: string) =>
    get<{ conversation: { id: string; title: string; createdAt: string; updatedAt: string }; messages: MessageDTO[] }>(
      `/api/chat?businessId=${businessId}&userId=${userId}`,
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
}

// ---------------------------------------------------------------------------
// SSE chat streaming — the حرف بحرف reader
// ---------------------------------------------------------------------------
export interface StreamHandlers {
  onStart?: (conversationId: string) => void
  onThinking?: (steps: ThinkingStep[]) => void
  onStep?: (label: string, state: 'active' | 'done') => void
  onCard?: (card: ActionCardDTO) => void
  onCards?: (cards: ResultCardDTO[]) => void
  onDelta?: (text: string) => void
  onDone?: (messageId: string, modelLabel: string) => void
  onError?: (message: string) => void
}

export async function streamChat(
  body: { businessId: string; userId: string; text: string; modelKey?: string | null; conversationId?: string | null },
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
          | { event: 'delta'; text: string }
          | { event: 'done'; messageId: string; modelLabel: string }
          | { event: 'error'; message: string }
        switch (ev.event) {
          case 'start': handlers.onStart?.(ev.conversationId); break
          case 'thinking': handlers.onThinking?.(ev.steps); break
          case 'step': handlers.onStep?.(ev.label, ev.state); break
          case 'card': handlers.onCard?.(ev.card); break
          case 'cards': handlers.onCards?.(ev.cards); break
          case 'delta': handlers.onDelta?.(ev.text); break
          case 'done': handlers.onDone?.(ev.messageId, ev.modelLabel); break
          case 'error': handlers.onError?.(ev.message); break
        }
      } catch {
        // ignore malformed event
      }
    }
  }
}

export function messageToTurn(m: MessageDTO): ChatTurn {
  return {
    id: m.id,
    role: m.role,
    text: m.text,
    card: m.card ?? null,
    cards: m.cards ?? null,
    thinking: m.thinking ?? null,
    modelLabel: m.modelLabel ?? null,
    createdAt: m.createdAt,
    outcome: m.outcome ?? undefined,
  }
}
