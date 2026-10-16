'use client'

// وكيل — ChatView: the conversation-first heart of the app, rebuilt to
// ChatGPT/Claude quality. The live turn lives INSIDE the turns list (same DOM
// node from first thinking frame to final card reveal — zero flicker):
//   • pre-text → ThinkingIndicator (3 rotating animation modes + statuses)
//   • deltas   → ONLY the streamed text + caret + compact step line
//   • card / cards / actions are BUFFERED in closure refs — never rendered
//     mid-stream — then revealed BELOW the finished text with a staggered
//     spring (fixes «الكروت بتظهر فوق الرد»).
// Round 14 adds the conversation layer: «محادثة جديدة» + history drawer
// (ConversationDrawer) + dynamic suggestion chips that follow the user's work
// + the user's own quick tools pinned in the Composer.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion, MotionConfig } from 'framer-motion'
import type { LucideIcon } from 'lucide-react'
import { Brain, Check, ChevronDown, Cpu, History, Loader2, Scale, Sparkles, SquarePen, Zap } from 'lucide-react'
import { api, messageToTurn, streamChat } from '@/lib/api'
import { getVertical } from '@/lib/verticals'
import { useWakil, QUERY_KEYS, type ViewKey } from '@/lib/store'
import { TIER_AR } from '@/lib/labels'
import type {
  ActionCardDTO,
  BusinessLite,
  ChatActionDTO,
  ChatTurn,
  ModelConfigDTO,
  QuickCommandDTO,
  ResultCardDTO,
  SuggestionDTO,
} from '@/lib/types'
import { AgentAvatar, type AgentState } from './AgentAvatar'
import { MessageBubble } from './MessageBubble'
import { Composer } from './Composer'
import { ConversationDrawer } from './ConversationDrawer'
import { TOOL_ICONS } from './QuickCommandsManager'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useToast } from '@/hooks/use-toast'

interface ChatViewProps {
  business: BusinessLite
  userId: string
  /** deep-link navigation from agent action buttons (e.g. «افتح الإحصائيات») */
  onNavigate?: (view: ViewKey) => void
}

const BUILTIN_MODELS = [
  {
    key: 'builtin-deep',
    label: 'عميق مفكّر',
    sub: 'glm-4.6 · للمهام المعقدة',
    icon: Brain,
  },
  {
    key: 'builtin-air',
    label: 'خفيف سريع',
    sub: 'glm-4.5-air · سريع ويكفي',
    icon: Zap,
  },
] as const

const TIER_ICONS: Record<string, LucideIcon> = { air: Zap, balanced: Scale, deep: Brain }

export function ChatView({ business, userId, onNavigate }: ChatViewProps) {
  const vertical = getVertical(business.type)
  const modelKey = useWakil((s) => s.modelKey)
  const setModel = useWakil((s) => s.setModel)
  const activeConversationId = useWakil((s) => s.activeConversationId)
  const setActiveConversation = useWakil((s) => s.setActiveConversation)
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const [turns, setTurns] = useState<ChatTurn[]>([])
  // the conversation ACTUALLY displayed (from GET / start event) — distinct
  // from the requested one so the query key only re-keys on explicit intent
  const [loadedConvId, setLoadedConvId] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [busyOpId, setBusyOpId] = useState<string | null>(null)
  const [revealId, setRevealId] = useState<string | null>(null)
  const [failedId, setFailedId] = useState<string | null>(null)
  const [nearBottom, setNearBottom] = useState(true)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [creating, setCreating] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const nearBottomRef = useRef(true)
  const sendingRef = useRef(false)
  const retryRef = useRef<string | null>(null)
  const creatingRef = useRef(false)

  // ---- load conversation history (keyed to the ACTIVE conversation) ----
  const { data, isLoading } = useQuery({
    queryKey: QUERY_KEYS.chatConversation(business.id, userId, activeConversationId),
    queryFn: () => api.chat(business.id, userId, activeConversationId),
    refetchOnWindowFocus: false,
  })
  // One effect owns the transcript: it applies the fetched history whenever
  // the data or the target conversation changes, and drops the old transcript
  // while a NEW key has no cached data yet (so stale messages never linger).
  // (deps include the conversation key — a cache-hit key switch can return a
  // deep-equal object via structural sharing, which alone wouldn't re-fire.)
  useEffect(() => {
    if (!data) {
      setTurns([])
      setRevealId(null)
      setFailedId(null)
      return
    }
    if (sendingRef.current) return
    setTurns(data.messages.map(messageToTurn))
    setLoadedConvId(data.conversation.id)
    setRevealId(null)
    setFailedId(null)
  }, [data, business.id, userId, activeConversationId])

  // ---- smart scroll: follow only while the user is near the bottom ----
  const scrollToBottom = useCallback((smooth = true) => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    nearBottomRef.current = true
  }, [])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 140
    nearBottomRef.current = near
    setNearBottom((prev) => (prev === near ? prev : near))
  }, [])

  useEffect(() => {
    if (nearBottomRef.current) scrollToBottom(false)
  }, [turns, scrollToBottom])

  // ---- providers for the model picker ----
  const { data: providersData } = useQuery({
    queryKey: QUERY_KEYS.providers,
    queryFn: () => api.providers(),
  })
  const currentLabel = useMemo(() => {
    if (modelKey === 'builtin-deep') return 'عميق مفكّر'
    if (modelKey === 'builtin-air') return 'خفيف سريع'
    const ext = providersData?.providers.flatMap((p) => p.models).find((m) => `ext:${m.id}` === modelKey)
    return ext?.label ?? 'عميق مفكّر'
  }, [modelKey, providersData])

  // carry the provider name so two providers exposing the same model label
  // (e.g. مزوّد تجريبي + مزوّد الاختبار → وكيل خفيف ×2) stay distinguishable
  const enabledExternal = (providersData?.providers ?? [])
    .flatMap((p) => p.models.map((m) => ({ ...m, providerName: p.name })))
    .filter((m) => m.enabled)

  // ---- dynamic suggestions (the adaptive demos — بتتغير مع شغلك) ----
  const suggestionsQ = useQuery({
    queryKey: QUERY_KEYS.suggestions(business.id, userId),
    queryFn: () => api.suggestions(business.id, userId),
    refetchOnMount: true,
    retry: 1,
  })

  // ---- the user's own quick tools (أدواتك السريعة — always visible) ----
  const commandsQ = useQuery({
    queryKey: QUERY_KEYS.quickCommands(business.id),
    queryFn: () => api.quickCommands(business.id),
  })

  // ---- send a message → stream the turn (ChatGPT order guaranteed) ----
  const send = useCallback(
    async (text: string, opts?: { suggestionId?: string }) => {
      if (sendingRef.current || !text.trim()) return
      const trimmed = text.trim()
      sendingRef.current = true
      setSending(true)
      setFailedId(null)
      setRevealId(null)
      retryRef.current = trimmed

      const userLocalId = `local-user-${Date.now()}`
      const liveId = `local-live-${Date.now()}`

      setTurns((prev) => [
        ...prev,
        { id: userLocalId, role: 'user', text: trimmed, createdAt: new Date().toISOString() },
        {
          id: liveId,
          role: 'assistant',
          text: '',
          thinking: [],
          createdAt: new Date().toISOString(),
          streaming: true,
        },
      ])
      nearBottomRef.current = true
      setNearBottom(true)

      // BUFFERS: card/cards/actions stay out of render until the stream ends
      const buf = {
        card: null as ActionCardDTO | null,
        cards: null as ResultCardDTO[] | null,
        actions: null as ChatActionDTO[] | null,
      }
      let errored = false
      let doneId: string | null = null
      // IMPORTANT: capture the target id at HANDLER-CALL time — closures that
      // resolve it inside the setTurns updater would read `doneId` at flush
      // time and silently drop the final deltas that arrive in the same batch
      // as the done event.
      const patchTurn = (patch: Partial<ChatTurn>) => {
        const id = doneId ?? liveId
        setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)))
      }

      try {
        await streamChat(
          {
            businessId: business.id,
            userId,
            text: trimmed,
            modelKey,
            conversationId: activeConversationId ?? loadedConvId,
            suggestionId: opts?.suggestionId ?? null,
          },
          {
            onStart: (cid, userMessageId) => {
              // a new conversation may be created server-side when none was
              // passed — track it so later sends stay in the same thread
              setLoadedConvId(cid)
              // swap optimistic user id → the real persisted id so any later
              // refetch reconciles by key (no remount → no flicker)
              setTurns((prev) => prev.map((t) => (t.id === userLocalId ? { ...t, id: userMessageId } : t)))
            },
            onThinking: (steps) => patchTurn({ thinking: steps }),
            onStep: (label, state) => {
              const id = doneId ?? liveId
              setTurns((prev) =>
                prev.map((t) =>
                  t.id === id && t.thinking
                    ? { ...t, thinking: t.thinking.map((s) => (s.label === label ? { ...s, state } : s)) }
                    : t,
                ),
              )
            },
            onCard: (card) => {
              buf.card = card
            },
            onCards: (cards) => {
              buf.cards = cards
            },
            onActions: (actions) => {
              buf.actions = actions
            },
            onDelta: (d) => {
              const id = doneId ?? liveId
              setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, text: t.text + d } : t)))
            },
            onDone: (messageId, modelLabel) => {
              doneId = messageId
              // finalize IN PLACE (same DOM node) + reveal the buffers below text
              setTurns((prev) =>
                prev.map((t) =>
                  t.id === liveId
                    ? {
                        ...t,
                        id: messageId,
                        streaming: false,
                        modelLabel,
                        card: buf.card,
                        cards: buf.cards,
                        actions: buf.actions,
                      }
                    : t,
                ),
              )
              setRevealId(messageId)
            },
            onError: (message) => {
              errored = true
              patchTurn({ streaming: false })
              setFailedId(doneId ?? liveId)
              toast({ title: 'مشكلة', description: message, variant: 'destructive' })
            },
          },
        )
      } catch {
        errored = true
        patchTurn({ streaming: false })
        setFailedId(doneId ?? liveId)
        toast({ title: 'مشكلة', description: 'الاتصال اتقطع — جرّب تاني', variant: 'destructive' })
      } finally {
        sendingRef.current = false
        setSending(false)
        if (errored) {
          // keep the failed bubble (retry button) — the server never persisted
          // a reply, so a refetch here would wipe the retry UI
        } else if (doneId) {
          // chat state is already exact locally — refresh the app-wide caches
          void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.overview(business.id, userId) })
          void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.operations(business.id) })
          // the conversation list (title/preview/counts) + suggestions follow
          // the user's work and update live after every turn
          void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.conversations(business.id, userId) })
          void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.suggestions(business.id, userId) })
        } else {
          // stream closed without done/error — treat as a failed turn
          patchTurn({ streaming: false })
          setFailedId(doneId ?? liveId)
          toast({ title: 'مشكلة', description: 'الرد مشكتلش — جرّب تاني', variant: 'destructive' })
        }
      }
    },
    [business.id, userId, modelKey, activeConversationId, loadedConvId, toast, queryClient],
  )

  const retry = useCallback(() => {
    if (retryRef.current) void send(retryRef.current)
  }, [send])

  // ---- suggestion / quick-command chips send their prompt directly ----
  const sendSuggestion = useCallback(
    (s: SuggestionDTO) => {
      void send(s.prompt, { suggestionId: s.id })
    },
    [send],
  )

  const handleCommandTap = useCallback(
    (cmd: QuickCommandDTO) => {
      void send(cmd.prompt)
      // silent usage ping — updates «استخدمته X مرة» in the manager
      api
        .touchQuickCommand(cmd.id)
        .then((updated) => {
          queryClient.setQueryData<QuickCommandDTO[]>(QUERY_KEYS.quickCommands(business.id), (old) =>
            old?.map((c) => (c.id === updated.id ? updated : c)),
          )
        })
        .catch(() => {})
    },
    [send, business.id, queryClient],
  )

  // ---- «محادثة جديدة» → create + activate + empty hero ----
  const startNewChat = useCallback(async () => {
    if (creatingRef.current) return
    creatingRef.current = true
    setCreating(true)
    try {
      const summary = await api.createConversation(business.id, userId)
      setActiveConversation(summary.id)
      setTurns([])
      setRevealId(null)
      setFailedId(null)
      setDrawerOpen(false)
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.conversations(business.id, userId) })
    } catch (err) {
      toast({
        title: 'مشكلة',
        description: err instanceof Error ? err.message : 'جرّب تاني',
        variant: 'destructive',
      })
    } finally {
      creatingRef.current = false
      setCreating(false)
    }
  }, [business.id, userId, setActiveConversation, queryClient, toast])

  // ---- approvals (R2+ / R3 reason flow) ----
  const approve = useCallback(
    async (card: ActionCardDTO, reason?: string) => {
      if (!card.opId) return
      setBusyOpId(card.opId)
      try {
        const res = await api.confirmOperation(card.opId, 'approve', userId, reason)
        setTurns((prev) =>
          prev.map((t) =>
            t.card?.opId === card.opId
              ? { ...t, card: { ...t.card!, status: res.operation.status }, outcome: res.outcome ?? undefined }
              : t,
          ),
        )
        toast({
          title: res.outcome?.ok ? 'تم — موثّق ومتحقق' : 'العملية فشلت بأمان',
          description: res.outcome?.ok
            ? `${res.operation.ref} — ${res.operation.summary}`
            : (res.outcome?.failReason ?? 'راجع التفاصيل'),
          variant: res.outcome?.ok ? 'default' : 'destructive',
        })
        void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.overview(business.id, userId) })
        void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.operations(business.id) })
        void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.items(business.id) })
      } catch (err) {
        toast({
          title: 'مشكلة في الاعتماد',
          description: err instanceof Error ? err.message : 'جرّب تاني',
          variant: 'destructive',
        })
      } finally {
        setBusyOpId(null)
      }
    },
    [userId, business.id, toast, queryClient],
  )

  const reject = useCallback(
    async (card: ActionCardDTO) => {
      if (!card.opId) return
      setBusyOpId(card.opId)
      try {
        const res = await api.confirmOperation(card.opId, 'reject', userId)
        setTurns((prev) =>
          prev.map((t) => (t.card?.opId === card.opId ? { ...t, card: { ...t.card!, status: 'CANCELLED' } } : t)),
        )
        toast({ title: 'اتلغت المسودة', description: `${res.operation.ref} اتلغت بلا أي أثر` })
        void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.overview(business.id, userId) })
      } catch (err) {
        toast({ title: 'مشكلة', description: err instanceof Error ? err.message : 'جرّب تاني', variant: 'destructive' })
      } finally {
        setBusyOpId(null)
      }
    },
    [userId, business.id, toast, queryClient],
  )

  // ---- derived ----
  const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null
  const headerAvatarState: AgentState =
    failedId && lastTurn?.id === failedId
      ? 'error'
      : lastTurn?.role === 'assistant' && lastTurn.streaming
        ? lastTurn.text
          ? 'writing'
          : 'thinking'
        : 'idle'
  const showWelcome = !isLoading && turns.length === 0
  const showJump = !nearBottom && !isLoading

  // hero chips: dynamic when the endpoint answers, else 2 vertical fallbacks
  const heroSuggestions = !suggestionsQ.isPending && (suggestionsQ.data?.length ?? 0) > 0 ? suggestionsQ.data : null
  const heroFallback = vertical.examples.slice(0, 2)

  return (
    <MotionConfig reducedMotion="user">
      <div className="relative flex h-full min-h-0 flex-col">
        {/* ===== compact header: agent + business | new chat + history | model ===== */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/70 bg-card/60 px-3 py-2 backdrop-blur-sm sm:px-4">
          <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
            <AgentAvatar state={headerAvatarState} size="sm" />
            <div className="min-w-0">
              <p className="truncate text-sm font-bold leading-tight">{business.name}</p>
              <p className="truncate text-[11px] leading-tight text-muted-foreground">{vertical.label}</p>
            </div>
            <div className="ms-1 flex shrink-0 items-center gap-1">
              <Button
                variant="outline"
                className="press h-9 shrink-0 gap-1.5 rounded-full px-2.5 text-xs font-medium sm:px-3"
                onClick={() => void startNewChat()}
                disabled={creating}
                aria-label="محادثة جديدة"
                title="محادثة جديدة"
              >
                {creating ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <SquarePen className="size-3.5 text-wakil-amber" aria-hidden="true" />
                )}
                <span className="hidden sm:inline">محادثة جديدة</span>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="press size-9 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
                onClick={() => setDrawerOpen(true)}
                aria-label="المحادثات القديمة"
                title="المحادثات القديمة"
              >
                <History className="size-4" aria-hidden="true" />
              </Button>
            </div>
          </div>

          <ModelPicker
            modelKey={modelKey}
            setModel={setModel}
            enabledExternal={enabledExternal}
            currentLabel={currentLabel}
            onToast={toast}
          />
        </div>

        {/* ===== messages (scroll) + floating jump-to-bottom ===== */}
        <div className="relative min-h-0 flex-1">
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="scroll-warm h-full overflow-y-auto px-3 py-4 sm:px-4"
          >
            {isLoading && (
              <div className="mx-auto flex max-w-2xl flex-col gap-5" role="status" aria-label="بيحمّل المحادثة">
                <div className="ms-auto h-12 w-2/5 animate-pulse rounded-2xl bg-muted" />
                <div className="flex items-start gap-2.5">
                  <div className="size-7 shrink-0 animate-pulse rounded-full bg-muted" />
                  <div className="flex w-full flex-col gap-2">
                    <div className="h-3.5 w-3/4 animate-pulse rounded-full bg-muted/80" />
                    <div className="h-3.5 w-1/2 animate-pulse rounded-full bg-muted/60" />
                  </div>
                </div>
                <div className="h-28 w-full animate-pulse rounded-2xl bg-muted/70" />
              </div>
            )}

            {showWelcome && (
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.26, ease: 'easeOut' }}
                className="mx-auto flex max-w-md flex-col items-center gap-4 py-8 text-center"
              >
                <AgentAvatar state="idle" size="lg" />
                <div>
                  <h2 className="text-lg font-bold">أهلاً بيك 👋</h2>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{vertical.welcome}</p>
                </div>
                <div className="flex flex-wrap justify-center gap-1.5">
                  {suggestionsQ.isPending ? (
                    <div className="flex flex-wrap justify-center gap-1.5" aria-busy="true" aria-label="بيجهّز الاقتراحات">
                      {[0, 1, 2, 3].map((i) => (
                        <span key={i} className="skel h-[4.25rem] w-32 rounded-2xl" />
                      ))}
                    </div>
                  ) : heroSuggestions ? (
                    heroSuggestions.map((s, i) => (
                      <SuggestionPill key={s.id} s={s} index={i} onPick={() => sendSuggestion(s)} />
                    ))
                  ) : (
                    // the suggestion engine is unreachable → silent static fallback
                    heroFallback.map((ex, i) => (
                      <motion.button
                        key={ex}
                        type="button"
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.15 + i * 0.05, duration: 0.22, ease: 'easeOut' }}
                        onClick={() => void send(ex)}
                        className="press rounded-full border border-border bg-card px-3.5 py-2 text-xs transition-all hover:-translate-y-0.5 hover:border-wakil-amber/50 hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      >
                        {ex}
                      </motion.button>
                    ))
                  )}
                </div>
              </motion.div>
            )}

            <div className="mx-auto flex max-w-2xl flex-col gap-5">
              {turns.map((t) => (
                <MessageBubble
                  key={t.id}
                  turn={t}
                  onApprove={approve}
                  onReject={reject}
                  busyOpId={busyOpId}
                  onNavigate={onNavigate}
                  onRetry={t.id === failedId ? retry : undefined}
                  reveal={t.id === revealId}
                  error={t.id === failedId}
                />
              ))}
            </div>
          </div>

          {/* floating scroll-to-bottom (appears when scrolled up) */}
          {showJump && (
            <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
              <motion.button
                type="button"
                initial={{ scale: 0.6, opacity: 0, y: 4 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                transition={{ duration: 0.15, ease: 'easeOut' }}
                onClick={() => scrollToBottom(true)}
                aria-label="انزل لآخر المحادثة"
                className="press pointer-events-auto flex size-10 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-lg shadow-black/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <ChevronDown className="size-4" aria-hidden="true" />
              </motion.button>
            </div>
          )}
        </div>

        {/* ===== composer ===== */}
        <div className="shrink-0 border-t border-border/70 bg-card/60 px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 backdrop-blur-sm sm:px-4 sm:pb-3">
          <div className="mx-auto max-w-2xl">
            <Composer
              commands={commandsQ.data ?? []}
              suggestions={suggestionsQ.data ?? []}
              onSend={send}
              onCommandTap={handleCommandTap}
              onSuggestionTap={sendSuggestion}
              disabled={sending}
            />
            <p className="mt-1.5 hidden text-center text-[10px] text-muted-foreground sm:block">
              وكيل بيسأل قبل ما ينفذ — كل عملية بتتحقق بعد التنفيذ
            </p>
          </div>
        </div>

        {/* ===== conversations drawer (سجل المحادثات القديمة) ===== */}
        {drawerOpen && (
          <ConversationDrawer
            businessId={business.id}
            userId={userId}
            activeId={activeConversationId ?? loadedConvId}
            onClose={() => setDrawerOpen(false)}
            onSwitch={(id) => {
              if (id !== activeConversationId) setActiveConversation(id)
              setDrawerOpen(false)
            }}
            onNewChat={() => void startNewChat()}
            creating={creating}
          />
        )}
      </div>
    </MotionConfig>
  )
}

// ---------------------------------------------------------------------------
// Dynamic suggestion pill (welcome hero) — icon + label + reason badge
// ---------------------------------------------------------------------------
function SuggestionPill({ s, index, onPick }: { s: SuggestionDTO; index: number; onPick: () => void }) {
  const Icon = TOOL_ICONS[s.icon] ?? Sparkles
  const primary = s.tone === 'primary'
  return (
    <motion.button
      type="button"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.15 + index * 0.05, duration: 0.22, ease: 'easeOut' }}
      onClick={onPick}
      aria-label={s.reasonLabel ? `${s.label} — ${s.reasonLabel}` : s.label}
      title={s.prompt}
      className={cn(
        'press flex min-h-11 max-w-full flex-col items-start gap-0.5 rounded-2xl border px-3.5 py-2 text-start transition-all hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
        primary
          ? 'border-transparent bg-primary text-primary-foreground hover:bg-primary/90'
          : 'border-border bg-card hover:border-wakil-amber/50 hover:bg-accent hover:text-accent-foreground',
      )}
    >
      <span className="flex items-center gap-1.5 text-xs font-medium">
        <Icon
          className={cn('size-3.5 shrink-0', primary ? 'text-primary-foreground/80' : 'text-wakil-amber')}
          aria-hidden="true"
        />
        <span className="max-w-56 truncate">{s.label}</span>
      </span>
      {s.reasonLabel && (
        <span className={cn('text-[10px]', primary ? 'text-primary-foreground/70' : 'text-muted-foreground')}>
          {s.reasonLabel}
        </span>
      )}
    </motion.button>
  )
}

// ---------------------------------------------------------------------------
// Model picker — shadcn Popover (proper focus + outside-click handling)
// ---------------------------------------------------------------------------
function ModelPicker({
  modelKey,
  setModel,
  enabledExternal,
  currentLabel,
  onToast,
}: {
  modelKey: string | null
  setModel: (key: string) => void
  enabledExternal: Array<ModelConfigDTO & { providerName: string }>
  currentLabel: string
  onToast: (t: { title: string; description?: string }) => void
}) {
  const [open, setOpen] = useState(false)

  const select = (key: string, label: string) => {
    setModel(key)
    setOpen(false)
    onToast({ title: 'تم تبديل الموديل', description: label })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className="group h-9 shrink-0 gap-1.5 rounded-full text-xs font-medium"
          aria-label={`تبديل الموديل — الحالي ${currentLabel}`}
        >
          <Cpu className="size-3.5 text-wakil-amber" aria-hidden="true" />
          <span className="max-w-24 truncate">{currentLabel}</span>
          <ChevronDown
            className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180"
            aria-hidden="true"
          />
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-64 rounded-xl p-0" dir="rtl">
        <div className="p-1.5">
          <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold text-muted-foreground">
            الموديلات الداخلية
          </p>
          {BUILTIN_MODELS.map((m) => (
            <ModelRow
              key={m.key}
              icon={m.icon}
              label={m.label}
              sub={m.sub}
              active={modelKey === m.key}
              onSelect={() => select(m.key, m.label)}
            />
          ))}

          {enabledExternal.length > 0 && (
            <>
              <p className="mt-1.5 border-t border-border/60 px-2.5 pb-1 pt-2 text-[11px] font-semibold text-muted-foreground">
                مزوّدين خارجيين
              </p>
              {enabledExternal.map((m) => (
                <ModelRow
                  key={m.id}
                  icon={TIER_ICONS[m.tier] ?? Brain}
                  label={m.label}
                  sub={`${TIER_AR[m.tier] ?? m.tier} · ${m.providerName}`}
                  active={modelKey === `ext:${m.id}`}
                  onSelect={() => select(`ext:${m.id}`, `${m.label} — ${m.providerName}`)}
                />
              ))}
            </>
          )}

          <p className="mt-1.5 border-t border-border/60 px-2.5 py-2 text-[10px] leading-relaxed text-muted-foreground">
            تضيف مزوّدين من الإعدادات ↗
          </p>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function ModelRow({
  icon: Icon,
  label,
  sub,
  active,
  onSelect,
}: {
  icon: LucideIcon
  label: string
  sub: string
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-start transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
        active && 'bg-accent/70',
      )}
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
        <Icon className="size-3.5 text-wakil-amber" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold">{label}</span>
        <span className="block truncate text-[10px] text-muted-foreground">{sub}</span>
      </span>
      {active && (
        <motion.span
          initial={{ scale: 0.4, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 420, damping: 22 }}
          className="flex shrink-0"
        >
          <Check className="size-4 text-wakil-amber" aria-hidden="true" />
        </motion.span>
      )}
    </button>
  )
}
