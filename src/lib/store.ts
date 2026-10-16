// وكيل — client state (Zustand). Persisted prefs: business/user/model choice.

'use client'

import { create } from 'zustand'

export type ViewKey = 'chat' | 'today' | 'inventory' | 'journal' | 'accounts' | 'stats' | 'reports' | 'settings'

export const VIEW_LABELS: Record<ViewKey, string> = {
  chat: 'المحادثة',
  today: 'اليوم',
  inventory: 'المخزون',
  journal: 'السجل',
  accounts: 'الحسابات',
  stats: 'الإحصائيات',
  reports: 'التقارير',
  settings: 'الإعدادات',
}

interface WakilState {
  // session
  businessId: string | null
  userId: string | null
  modelKey: string | null
  view: ViewKey
  dark: boolean
  onboardingDone: boolean
  // setters
  setSession: (businessId: string, userId: string) => void
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
}

export const useWakil = create<WakilState>((set, get) => ({
  businessId: null,
  userId: null,
  modelKey: 'builtin-deep',
  view: 'chat',
  dark: false,
  onboardingDone: false,
  setSession: (businessId, userId) => {
    localStorage.setItem(LS.business, businessId)
    localStorage.setItem(LS.user, userId)
    set({ businessId, userId, view: 'chat' })
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
    set({
      businessId: localStorage.getItem(LS.business),
      userId: localStorage.getItem(LS.user),
      modelKey: localStorage.getItem(LS.model) ?? 'builtin-deep',
      onboardingDone: localStorage.getItem(LS.onboarding) === '1',
    })
  },
}))

/** Invalidate all TanStack Query caches for lists after a mutation. */
export const QUERY_KEYS = {
  overview: (b: string, u: string) => ['overview', b, u] as const,
  items: (b: string) => ['items', b] as const,
  operations: (b: string) => ['operations', b] as const,
  chat: (b: string, u: string) => ['chat', b, u] as const,
  members: (b: string) => ['members', b] as const,
  tasks: (b: string) => ['tasks', b] as const,
  memories: (b: string) => ['memories', b] as const,
  reports: (b: string, r: string) => ['reports', b, r] as const,
  providers: ['providers'] as const,
}
