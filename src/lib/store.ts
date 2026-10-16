// وكيل — client state (Zustand). Persisted prefs: business/user/model choice.

'use client'

import { create } from 'zustand'

export type ViewKey =
  | 'chat'
  | 'today'
  | 'inventory'
  | 'journal'
  | 'accounts'
  | 'stats'
  | 'reports'
  | 'settings'
  | 'memory'

export const VIEW_LABELS: Record<ViewKey, string> = {
  chat: 'المحادثة',
  today: 'اليوم',
  inventory: 'المخزون',
  journal: 'السجل',
  accounts: 'الحسابات',
  stats: 'الإحصائيات',
  reports: 'التقارير',
  settings: 'الإعدادات',
  memory: 'ذاكرة وكيل',
}

interface WakilState {
  // session
  businessId: string | null
  userId: string | null
  modelKey: string | null
  view: ViewKey
  dark: boolean
  onboardingDone: boolean
  // conversation (last-used per business — so switching businesses keeps context)
  activeConversationId: string | null
  // setters
  setSession: (businessId: string, userId: string) => void
  setActiveConversation: (id: string | null) => void
  setModel: (modelKey: string | null) => void
  setView: (view: ViewKey) => void
  toggleDark: () => void
  finishOnboarding: () => void
  hydrate: () => void
}

const LS = {
  business: 'wakil.businessId',
  user: 'wakil.userId',
  model: 'wakil.modelKey',
  onboarding: 'wakil.onboarding',
  /** per-business last-used conversation key (wakil.conversation.{businessId}) */
  conversation: (businessId: string) => `wakil.conversation.${businessId}`,
}

export const useWakil = create<WakilState>((set, get) => ({
  businessId: null,
  userId: null,
  modelKey: 'builtin-deep',
  view: 'chat',
  dark: false,
  onboardingDone: false,
  activeConversationId: null,
  setSession: (businessId, userId) => {
    localStorage.setItem(LS.business, businessId)
    localStorage.setItem(LS.user, userId)
    // restore the last-used conversation for THIS business (kept in its own key)
    const storedConversation =
      typeof window !== 'undefined' ? localStorage.getItem(LS.conversation(businessId)) : null
    set({ businessId, userId, view: 'chat', activeConversationId: storedConversation })
  },
  setActiveConversation: (id) => {
    const businessId = get().businessId
    if (businessId) {
      if (id) localStorage.setItem(LS.conversation(businessId), id)
      else localStorage.removeItem(LS.conversation(businessId))
    }
    set({ activeConversationId: id })
  },
  setModel: (modelKey) => {
    localStorage.setItem(LS.model, modelKey ?? 'builtin-deep')
    set({ modelKey })
  },
  setView: (view) => set({ view }),
  toggleDark: () => set({ dark: !get().dark }),
  finishOnboarding: () => {
    localStorage.setItem(LS.onboarding, '1')
    set({ onboardingDone: true })
  },
  hydrate: () => {
    if (typeof window === 'undefined') return
    const businessId = localStorage.getItem(LS.business)
    set({
      businessId,
      userId: localStorage.getItem(LS.user),
      modelKey: localStorage.getItem(LS.model) ?? 'builtin-deep',
      onboardingDone: localStorage.getItem(LS.onboarding) === '1',
      // page reload → return to the last-used conversation of the hydrated business
      activeConversationId: businessId ? localStorage.getItem(LS.conversation(businessId)) : null,
    })
  },
}))

/** Invalidate all TanStack Query caches for lists after a mutation. */
export const QUERY_KEYS = {
  overview: (b: string, u: string) => ['overview', b, u] as const,
  items: (b: string) => ['items', b] as const,
  operations: (b: string) => ['operations', b] as const,
  chat: (b: string, u: string) => ['chat', b, u] as const,
  /** chat history scoped to ONE conversation (null → follow the latest) */
  chatConversation: (b: string, u: string, c: string | null) => ['chat', b, u, c ?? 'latest'] as const,
  members: (b: string) => ['members', b] as const,
  tasks: (b: string) => ['tasks', b] as const,
  memories: (b: string) => ['memories', b] as const,
  reports: (b: string, r: string) => ['reports', b, r] as const,
  providers: ['providers'] as const,
  conversations: (b: string, u: string) => ['conversations', b, u] as const,
  suggestions: (b: string, u: string) => ['suggestions', b, u] as const,
  quickCommands: (b: string) => ['quickCommands', b] as const,
  radar: (b: string) => ['radar', b] as const,
}
