// وكيل — global app state (Zustand) + React Query cache keys.
// Preserves the full useWakil / VIEW_LABELS / QUERY_KEYS contract and adds
// Superpower Command Palette (Cmd+K), Dynamic Business Builder Modal, and
// cross-view instant agent prompts.

import { create } from 'zustand'

export type ViewKey =
  | 'chat'
  | 'today'
  | 'inventory'
  | 'journal'
  | 'accounts'
  | 'stats'
  | 'reports'
  | 'memory'
  | 'settings'

export const VIEW_LABELS: Record<ViewKey, string> = {
  chat: 'وكيل',
  today: 'اليوم',
  inventory: 'المخزون',
  journal: 'السجل',
  accounts: 'الحسابات',
  stats: 'الإحصائيات',
  reports: 'التقارير',
  memory: 'ذاكرة وكيل',
  settings: 'الإعدادات',
}

export const QUERY_KEYS = {
  bootstrap: ['bootstrap'] as const,
  overview: (businessId: string, userId: string) => ['overview', businessId, userId] as const,
  items: (businessId: string) => ['items', businessId] as const,
  operations: (businessId: string) => ['operations', businessId] as const,
  members: (businessId: string) => ['members', businessId] as const,
  tasks: (businessId: string) => ['tasks', businessId] as const,
  memories: (businessId: string) => ['memories', businessId] as const,
  reports: (businessId: string, range: string) => ['reports', businessId, range] as const,
  providers: ['providers'] as const,
  chat: (businessId: string, userId: string) => ['chat', businessId, userId] as const,
  chatConversation: (businessId: string, userId: string, conversationId?: string | null) =>
    ['chat', businessId, userId, conversationId ?? 'latest'] as const,
  conversations: (businessId: string, userId: string) => ['conversations', businessId, userId] as const,
  suggestions: (businessId: string, userId: string) => ['suggestions', businessId, userId] as const,
  quickCommands: (businessId: string) => ['quickCommands', businessId] as const,
  radar: (businessId: string) => ['radar', businessId] as const,
  notes: (businessId: string, conversationId: string) => ['notes', businessId, conversationId] as const,
  tools: (businessId: string, userId?: string) => ['tools', businessId, userId ?? 'all'] as const,
  plugins: (businessId: string) => ['plugins', businessId] as const,
  backgroundTasks: (businessId: string) => ['backgroundTasks', businessId] as const,
  morningBrief: (businessId: string, userId: string) => ['morning-brief', businessId, userId] as const,
}

const STORAGE_KEY = 'wakil.session.v2'
const ONBOARDING_KEY = 'wakil.onboarded.v1'

export type PluginStudioTab = 'plugins' | 'background' | 'alerts'

interface WakilState {
  businessId: string | null
  userId: string | null
  view: ViewKey
  modelKey: string
  activeConversationId: string | null
  onboardingDone: boolean
  /** Superpower Command Palette (Cmd+K / Ctrl+K) */
  commandPaletteOpen: boolean
  /** Dynamic Business & Vertical Builder Modal */
  businessBuilderOpen: boolean
  /** Dynamic Plugin Harness & Concurrent Background Task Studio Modal */
  pluginStudioOpen: boolean
  pluginStudioTab: PluginStudioTab
  /** Cross-view prompt queued for immediate execution in ChatView */
  pendingPrompt: { text: string; deepResearch?: boolean } | null
  /** Interactive Sound Effects toggle (Web Audio API) */
  soundEnabled: boolean

  setSession: (businessId: string, userId: string) => void
  setView: (view: ViewKey) => void
  setModel: (modelKey: string) => void
  setActiveConversation: (conversationId: string | null) => void
  hydrate: () => void
  finishOnboarding: () => void
  reopenOnboarding: () => void
  toggleSound: () => void
  setCommandPaletteOpen: (open: boolean) => void
  setBusinessBuilderOpen: (open: boolean) => void
  setPluginStudioOpen: (open: boolean, tab?: PluginStudioTab) => void
  askAgent: (text: string, opts?: { deepResearch?: boolean }) => void
  queuePrompt: (text: string) => void
  clearPrompt: () => void
  consumePendingPrompt: () => { text: string; deepResearch?: boolean } | null
}

export const useWakil = create<WakilState>((set, get) => ({
  businessId: null,
  userId: null,
  view: 'chat',
  modelKey: 'auto',
  activeConversationId: null,
  onboardingDone: true,
  commandPaletteOpen: false,
  businessBuilderOpen: false,
  pluginStudioOpen: false,
  pluginStudioTab: 'plugins',
  pendingPrompt: null,
  soundEnabled: true,

  setSession: (businessId, userId) => {
    set({ businessId, userId, activeConversationId: null })
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ businessId, userId, modelKey: get().modelKey }))
      } catch {
        /* ignore */
      }
    }
  },

  setView: (view) => set({ view }),

  setModel: (modelKey) => {
    set({ modelKey })
    if (typeof window !== 'undefined') {
      try {
        const cur = get()
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ businessId: cur.businessId, userId: cur.userId, modelKey }),
        )
      } catch {
        /* ignore */
      }
    }
  },

  setActiveConversation: (activeConversationId) => set({ activeConversationId }),

  hydrate: () => {
    if (typeof window === 'undefined') return
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      const onboarded = localStorage.getItem(ONBOARDING_KEY) === '1'
      const soundRaw = localStorage.getItem('wakil.sound.v1')
      const soundEnabled = soundRaw === null ? true : soundRaw !== '0'
      if (raw) {
        const parsed = JSON.parse(raw) as { businessId?: string; userId?: string; modelKey?: string }
        set({
          businessId: parsed.businessId ?? null,
          userId: parsed.userId ?? null,
          modelKey: parsed.modelKey ?? 'auto',
          onboardingDone: onboarded,
          soundEnabled,
        })
      } else {
        set({ onboardingDone: onboarded, soundEnabled })
      }
    } catch {
      /* ignore */
    }
  },

  finishOnboarding: () => {
    set({ onboardingDone: true })
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(ONBOARDING_KEY, '1')
      } catch {
        /* ignore */
      }
    }
  },

  reopenOnboarding: () => {
    set({ onboardingDone: false })
  },

  toggleSound: () => {
    const next = !get().soundEnabled
    set({ soundEnabled: next })
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('wakil.sound.v1', next ? '1' : '0')
      } catch {
        /* ignore */
      }
    }
  },

  setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),
  setBusinessBuilderOpen: (businessBuilderOpen) => set({ businessBuilderOpen }),
  setPluginStudioOpen: (pluginStudioOpen, tab) =>
    set((state) => ({
      pluginStudioOpen,
      pluginStudioTab: tab ?? state.pluginStudioTab,
    })),
  askAgent: (text, opts) =>
    set({
      view: 'chat',
      pendingPrompt: { text, deepResearch: opts?.deepResearch },
    }),
  queuePrompt: (text) =>
    set({
      view: 'chat',
      pendingPrompt: { text },
    }),
  clearPrompt: () => set({ pendingPrompt: null }),
  consumePendingPrompt: () => {
    const p = get().pendingPrompt
    if (p) set({ pendingPrompt: null })
    return p
  },
}))

export const useWakeel = useWakil
