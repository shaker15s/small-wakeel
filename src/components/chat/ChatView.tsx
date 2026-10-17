'use client'

// وكيل — ChatView (R18 «آبل جلاس»): the conversation-first heart of the app,
// full-bleed. The whole screen belongs to the chat now:
//   • NO fixed header — a FLOATING GLASS PILL at the top center: hidden by
//     default, springs in when the user hovers the top strip (or taps the
//     peeking وكيل avatar — touch-friendly). It carries the business
//     switcher, new chat, history, «ورقة وكيل», notifications, theme, and
//     a jump back to the app views — every icon in its own circle.
//   • The composer FLOATS at the bottom over the messages (glass + gradient
//     scrim) and AUTO-HIDES while the user reads history (scrolled up) —
//     never while there's a live draft or focus. The model picker moved
//     INSIDE the composer (opens upward, scrollable).
//   • The reading column widened to max-w-4xl — the screen finally breathes
//     full width; no side voids.
//   • Auto-scroll still follows the stream only while near the bottom; the
//     jump-to-bottom FAB appears (glass circle) once the user scrolls away.
// The battle-tested streaming logic (SSE contract, storm-safe queue,
// buffered card reveal, retry) is preserved verbatim from R15.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion, MotionConfig } from 'framer-motion'
import { ChevronDown, History, LayoutGrid, Loader2, Moon, NotebookPen, Search, SquarePen, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'

import { api, messageToTurn, streamChat, type ChatTurnWithMeta } from '@/lib/api'
import { getVertical } from '@/lib/verticals'
import { useWakil, QUERY_KEYS, type ViewKey } from '@/lib/store'
import type {
  ActionCardDTO,
  AlertDTO,
  BusinessLite,
  ChatActionDTO,
  ChatTurn,
  QuickCommandDTO,
  ResultCardDTO,
  SuggestionDTO,
} from '@/lib/types'
import { openCommandPalette } from '@/components/app/CommandPalette'
import { AgentAvatar, type AgentState } from './AgentAvatar'
import { MessageBubble } from './MessageBubble'
import { Composer } from './Composer'
import { ConversationDrawer } from './ConversationDrawer'
import { NotesSheet } from './NotesSheet'
import { TOOL_ICONS } from './QuickCommandsManager'
import { BusinessMenu } from '@/components/app/BusinessMenu'
import { NotificationBell } from '@/components/app/NotificationBell'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useToast } from '@/hooks/use-toast'

interface ChatViewProps {
  business: BusinessLite
  businesses: BusinessLite[]
  userId: string
  /** deep-link navigation from agent action buttons (e.g. «افتح الإحصائيات») */
  onNavigate?: (view: ViewKey) => void
}

const arNum = (n: number): string => new Intl.NumberFormat('ar-EG').format(n)

export function ChatView({ business, businesses, userId, onNavigate }: ChatViewProps) {
  const vertical = getVertical(business.type)
  const modelKey = useWakil((s) => s.modelKey)
  const setModel = useWakil((s) => s.setModel)
  const setSession = useWakil((s) => s.setSession)
  const activeConversationId = useWakil((s) => s.activeConversationId)
  const setActiveConversation = useWakil((s) => s.setActiveConversation)
  // «ابدأ يومك» hands the composer a ready sentence — send it once, then clear
  const pendingPrompt = useWakil((s) => s.pendingPrompt)
  const clearPrompt = useWakil((s) => s.clearPrompt)
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { theme, setTheme } = useTheme()

  const [turns, setTurns] = useState<ChatTurnWithMeta[]>([])
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
  const [notesOpen, setNotesOpen] = useState(false)
  // composer auto-hide protection: a live draft/focus pins the composer open
  const [drafting, setDrafting] = useState(false)
  // floating pill: hover OR pinned (tap on the peeking avatar)
  const [pillPinned, setPillPinned] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const nearBottomRef = useRef(true)
  const sendingRef = useRef(false)
  // R34: text + id of the last send, so «جرّب تاني» re-sends the SAME turn
  const retryRef = useRef<{ text: string; turnId: string } | null>(null)
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
  /* eslint-disable react-hooks/set-state-in-effect -- Deliberate: this effect
     mirrors an EXTERNAL store (the React Query cache) into the local transcript,
     which is exactly the pattern the rule's docs call out as valid. Every branch
     runs only when the query data / conversation key actually changed, so no
     cascading render loop is possible (the rule cannot see that invariant). */
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
  /* eslint-enable react-hooks/set-state-in-effect */

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

  // ---- providers for the model picker (rendered INSIDE the composer) ----
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

  // ---- notifications (same query key as AppShell → shared cache, no extra fetch) ----
  const { data: overview } = useQuery({
    queryKey: QUERY_KEYS.overview(business.id, userId),
    queryFn: () => api.overview(business.id, userId),
    refetchInterval: 30_000,
  })
  const alerts = useMemo(() => overview?.alerts ?? [], [overview])

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

  // ---- «ورقة وكيل» count (the agent's scratchpad for THIS conversation) ----
  // same key as the sheet's own query → one fetch, badge + sheet stay in sync
  const notesQ = useQuery({
    queryKey: QUERY_KEYS.notes(business.id, loadedConvId ?? 'none'),
    queryFn: () => api.notes(business.id, loadedConvId as string),
    enabled: !!loadedConvId,
    retry: 1,
    refetchOnWindowFocus: false,
  })
  const notesCount = notesQ.data?.length ?? 0

  // ---- send a message → stream the turn (ChatGPT order guaranteed) ----
  // STORM-SAFE QUEUE (R15 CEO fix): sends that arrive mid-stream are NOT
  // dropped — they queue and auto-flush the instant the live turn finishes
  // (the silent-loss bug the adversarial audit caught with 3 rapid messages).
  const pendingSendsRef = useRef<Array<{ text: string; opts?: { suggestionId?: string; deepResearch?: boolean } }>>([])
  const [queuedCount, setQueuedCount] = useState(0)

  const send = useCallback(
    async (
      text: string,
      opts?: { suggestionId?: string; deepResearch?: boolean; turnId?: string; replaceTurnId?: string },
    ) => {
      if (!text.trim()) return
      const trimmed = text.trim()
      if (sendingRef.current) {
        // a turn is live → queue this one; it sends automatically on done
        pendingSendsRef.current.push({ text: trimmed, opts })
        setQueuedCount(pendingSendsRef.current.length)
        return
      }
      sendingRef.current = true
      setSending(true)
      setFailedId(null)
      setRevealId(null)
      // retry keeps the id (and therefore the server-side turn), a fresh send
      // mints one — `crypto.randomUUID` needs a secure context, hence the shim
      const turnId =
        opts?.turnId ?? globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
      retryRef.current = { text: trimmed, turnId }
      // the conversation the scratchpad invalidation targets at done time
      let convId = activeConversationId ?? loadedConvId

      const userLocalId = `local-user-${Date.now()}`
      const liveId = `local-live-${Date.now()}`

      setTurns((prev) => {
        // a retry replaces the failed pair (question + dead answer) instead of
        // stacking a duplicate question under it
        let base = prev
        if (opts?.replaceTurnId) {
          const idx = prev.findIndex((t) => t.id === opts.replaceTurnId)
          if (idx >= 0) {
            const start = idx > 0 && prev[idx - 1].role === 'user' ? idx - 1 : idx
            base = prev.filter((_, i) => i < start || i > idx)
          }
        }
        return [
          ...base,
          { id: userLocalId, role: 'user', text: trimmed, createdAt: new Date().toISOString() },
          {
            id: liveId,
            role: 'assistant',
            text: '',
            thinking: [],
            createdAt: new Date().toISOString(),
            streaming: true,
          },
        ]
      })
      nearBottomRef.current = true
      setNearBottom(true)

      // BUFFERS: card/cards/actions stay out of render until the stream ends
      const buf = {
        card: null as ActionCardDTO | null,
        cards: null as ResultCardDTO[] | null,
        plan: null as string[] | null,
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
            deepResearch: opts?.deepResearch ?? false,
            turnId,
          },
          {
            onStart: (cid, userMessageId) => {
              // a new conversation may be created server-side when none was
              // passed — track it so later sends stay in the same thread
              setLoadedConvId(cid)
              convId = cid
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
            // R28: the agent announces the read-only plan it is running, so a
            // compound question shows its work instead of a long silence
            onPlan: (steps) => {
              buf.plan = steps
              patchTurn({ plan: steps })
            },
            onActions: (actions) => {
              buf.actions = actions
            },
            onDelta: (d) => {
              const id = doneId ?? liveId
              setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, text: t.text + d } : t)))
            },
            onDone: (messageId, modelLabel, meta) => {
              doneId = messageId
              // finalize IN PLACE (same DOM node) + reveal the buffers below text
              // (R15: done carries the verification ledger + research metadata)
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
                        verified: meta?.verified ?? null,
                        research: meta?.research ?? null,
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
          // «ورقة وكيل» — the agent jots notes while it works; refresh the
          // scratchpad (header badge + sheet) after every completed turn
          if (convId) {
            void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.notes(business.id, convId) })
          }
        } else {
          // stream closed without done/error — treat as a failed turn
          patchTurn({ streaming: false })
          setFailedId(doneId ?? liveId)
          toast({ title: 'مشكلة', description: 'الرد مشكتلش — جرّب تاني', variant: 'destructive' })
        }
        // STORM-SAFE QUEUE: flush the next queued message (if any) now that
        // the live turn finished — the audit's rapid-fire test stays lossless.
        const next = pendingSendsRef.current.shift()
        setQueuedCount(pendingSendsRef.current.length)
        if (next) void send(next.text, next.opts)
      }
    },
    [business.id, userId, modelKey, activeConversationId, loadedConvId, toast, queryClient],
  )

  // A recommendation tapped on اليوم becomes a real request here — the owner
  // never retypes what the agent already worked out.
  useEffect(() => {
    if (!pendingPrompt) return
    clearPrompt()
    void send(pendingPrompt)
  }, [pendingPrompt, clearPrompt, send])

  const retry = useCallback(() => {
    const last = retryRef.current
    if (!last) return
    // same turnId → the server reuses the turn (or replays the finished reply,
    // `replayed: true`) and never drafts the op twice
    void send(last.text, { turnId: last.turnId, replaceTurnId: failedId ?? undefined })
  }, [send, failedId])

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
  // Not wrapped in useCallback on purpose: the React Compiler cannot preserve
  // the manual memoization here (ref-guarded async handler) and the eslint
  // rule flags the mismatch. A plain handler is correct and cheaper to reason
  // about; it is only passed to click targets that re-render anyway.
  const startNewChat = async () => {
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
  }

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
  const pillAvatarState: AgentState =
    failedId && lastTurn?.id === failedId
      ? 'error'
      : lastTurn?.role === 'assistant' && lastTurn.streaming
        ? lastTurn.text
          ? 'writing'
          : 'thinking'
        : 'idle'
  const showWelcome = !isLoading && turns.length === 0
  const showJump = !nearBottom && !isLoading
  // the composer auto-hides while reading history — but a live draft/focus
  // pins it open («مربع الكتابة يختفي لما أعمل سكرول لفوق» — إلا لو بيكتب)
  const composerVisible = nearBottom || drafting

  // hero chips: dynamic when the endpoint answers, else 2 vertical fallbacks
  const heroSuggestions = !suggestionsQ.isPending && (suggestionsQ.data?.length ?? 0) > 0 ? suggestionsQ.data : null
  const heroFallback = vertical.examples.slice(0, 2)

  return (
    <MotionConfig reducedMotion="user">
      <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
        {/* ===== floating glass pill (hover-reveal / tap-pin) ===== */}
        <FloatingPill
          business={business}
          businesses={businesses}
          avatarState={pillAvatarState}
          notesCount={notesCount}
          notesDisabled={!loadedConvId}
          alerts={alerts}
          pinned={pillPinned}
          setPinned={setPillPinned}
          creating={creating}
          onNewChat={() => void startNewChat()}
          onHistory={() => setDrawerOpen(true)}
          onNotes={() => setNotesOpen(true)}
          onNavigate={onNavigate}
          theme={theme}
          onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        />

        {/* ===== messages — full-bleed scroll, content passes UNDER the glass ===== */}
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="scroll-warm h-full overflow-y-auto overflow-x-clip"
        >
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 pb-44 pt-16 sm:px-6">
            {isLoading && (
              <div className="flex flex-col gap-5" role="status" aria-label="بيحمّل المحادثة">
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
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                className="flex flex-col items-center gap-4 py-10 text-center"
              >
                <AgentAvatar state="idle" size="lg" />
                <div>
                  {/* the greeting is the first thing a new owner sees — it gets
                      the same kinetic treatment as the marketing surface
                      (words rise 55ms apart) instead of a static <h2> */}
                  <h2 className="text-lg font-bold" aria-label="أهلاً بيك">
                    {['أهلاً', 'بيك', '👋'].map((w, i) => (
                      <span key={w} style={{ ['--word-i' as string]: i }} className="kinetic-word">
                        {w}
                        {i < 2 ? ' ' : ''}
                      </span>
                    ))}
                  </h2>
                  <p className="blur-in mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground" style={{ animationDelay: '0.22s' }}>
                    {vertical.welcome}
                  </p>
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
                        className="press chip-lift rounded-full border border-border bg-card/70 px-3.5 py-2 text-xs backdrop-blur-sm transition-all hover:border-wakil-amber/50 hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      >
                        {ex}
                      </motion.button>
                    ))
                  )}
                </div>
              </motion.div>
            )}

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

        {/* ===== floating auto-hide composer (glass over the messages) ===== */}
        <motion.div
          initial={false}
          animate={{
            y: composerVisible ? 0 : 180,
            opacity: composerVisible ? 1 : 0,
          }}
          transition={{ type: 'spring', stiffness: 340, damping: 34, opacity: { duration: 0.18 } }}
          className="composer-scrim pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-8"
          aria-hidden={!composerVisible}
        >
          <div className="pointer-events-auto mx-auto w-full max-w-4xl px-4 pb-3 sm:px-6">
            <Composer
              commands={commandsQ.data ?? []}
              suggestions={suggestionsQ.data ?? []}
              onSend={send}
              onCommandTap={handleCommandTap}
              onSuggestionTap={sendSuggestion}
              disabled={sending}
              queuedCount={queuedCount}
              modelKey={modelKey}
              setModel={setModel}
              enabledExternal={enabledExternal}
              currentLabel={currentLabel}
              onModelToast={toast}
              onDraftingChange={setDrafting}
            />
            <p className="mt-1.5 text-center text-[10px] text-muted-foreground/80">
              وكيل بيسأل قبل ما ينفذ — كل عملية بتتحقق بعد التنفيذ
            </p>
          </div>
        </motion.div>

        {/* ===== jump-to-bottom (glass FAB — appears when the composer hid) ===== */}
        <AnimatePresence>
          {showJump && (
            <motion.div
              key="jump"
              initial={{ scale: 0.5, opacity: 0, y: 8 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.5, opacity: 0, y: 8 }}
              transition={{ type: 'spring', stiffness: 420, damping: 26 }}
              className="absolute inset-x-0 bottom-5 z-10 flex justify-center"
            >
              <button
                type="button"
                onClick={() => scrollToBottom(true)}
                aria-label="انزل لآخر المحادثة"
                className="glass press-apple icon-seat size-11 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <ChevronDown className="size-5" aria-hidden="true" />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

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

        {/* ===== «ورقة وكيل» — the scratchpad sheet (read-only) ===== */}
        {notesOpen && loadedConvId && (
          <NotesSheet
            businessId={business.id}
            conversationId={loadedConvId}
            onClose={() => setNotesOpen(false)}
          />
        )}
      </div>
    </MotionConfig>
  )
}

// ---------------------------------------------------------------------------
// FloatingPill — the hover-reveal glass navbar («الناف بار يظهر مع الهافر»)
// ---------------------------------------------------------------------------
function FloatingPill({
  business,
  businesses,
  avatarState,
  notesCount,
  notesDisabled,
  alerts,
  pinned,
  setPinned,
  creating,
  onNewChat,
  onHistory,
  onNotes,
  onNavigate,
  theme,
  onToggleTheme,
}: {
  business: BusinessLite
  businesses: BusinessLite[]
  avatarState: AgentState
  notesCount: number
  notesDisabled: boolean
  alerts: AlertDTO[]
  pinned: boolean
  setPinned: (v: boolean) => void
  creating: boolean
  onNewChat: () => void
  onHistory: () => void
  onNotes: () => void
  onNavigate?: (view: ViewKey) => void
  theme: string | undefined
  onToggleTheme: () => void
}) {
  const [hovered, setHovered] = useState(false)
  const setSession = useWakil((s) => s.setSession)
  const expanded = hovered || pinned

  // HOVER-INTENT (macOS-style): enter clears the pending hide; leave arms a
  // 350ms grace timer — moving between the strip and the pill never flickers,
  // and the pill only folds once the mouse really leaves the top zone.
  // A radix popover being open (business menu / bell) keeps it alive too.
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const checkHide = () => {
    if (document.querySelector('[data-radix-popper-content-wrapper]')) {
      hideTimer.current = setTimeout(checkHide, 350) // a popover is open — retry
      return
    }
    setHovered(false)
  }
  const enter = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = null
    setHovered(true)
  }, [])
  const leave = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(checkHide, 350)
  }, [])
  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current)
    },
    [],
  )

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center">
      {/* hover strip — full-width invisible trigger at the very top */}
      <div
        className="pointer-events-auto absolute inset-x-0 top-0 h-12"
        onMouseEnter={enter}
        onMouseLeave={leave}
        aria-hidden="true"
      />
      {/* focus/hover-follow hint: a keyboard user landing on the pill keeps it open */}
      <div
        onFocusCapture={enter}
        onBlurCapture={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) leave()
        }}
        className="relative flex justify-center"
      >
        <AnimatePresence mode="wait" initial={false}>
          {expanded ? (
            <motion.div
              key="pill"
              initial={{ y: -28, opacity: 0, scale: 0.94 }}
              animate={{ y: 0, opacity: 1, scale: 1 }}
              exit={{ y: -24, opacity: 0, scale: 0.96 }}
              transition={{ type: 'spring', stiffness: 420, damping: 30 }}
              className="glass-strong pointer-events-auto mt-2 flex max-w-[calc(100vw-1.25rem)] items-center gap-0.5 overflow-x-auto rounded-full p-1.5 scroll-warm"
              role="toolbar"
              aria-label="شريط وكيل"
              onMouseEnter={enter}
              onMouseLeave={leave}
            >
              {/* وكيل avatar — its own circle */}
              <button
                type="button"
                onClick={() => setPinned(!pinned)}
                className="press-apple icon-seat size-9 shrink-0"
                aria-label={pinned ? 'اقفل الشريط' : 'ثبّت الشريط'}
                title={pinned ? 'اقفل' : 'ثبّت الشريط'}
              >
                <AgentAvatar state={avatarState} size="sm" />
              </button>

              {/* business switcher — instant portal popover (shrink-safe on mobile) */}
              <div className="shrink-0">
                <BusinessMenu
                  businesses={businesses}
                  active={business}
                  compact
                  onPick={(b, u) => setSession(b, u)}
                />
              </div>

              <span className="mx-0.5 h-5 w-px shrink-0 bg-border" aria-hidden="true" />

              {/* new chat */}
              <Button
                variant="ghost"
                className="press-apple icon-seat size-9 shrink-0 text-muted-foreground hover:text-foreground"
                onClick={onNewChat}
                disabled={creating}
                aria-label="محادثة جديدة"
                title="محادثة جديدة"
              >
                {creating ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <SquarePen className="size-4" aria-hidden="true" />
                )}
              </Button>

              {/* بحث سريع في كل حاجة (⌘K) */}
              <Button
                variant="ghost"
                className="press-apple icon-seat size-9 shrink-0 text-muted-foreground hover:text-foreground"
                onClick={openCommandPalette}
                aria-label="بحث سريع"
                title="بحث سريع (⌘K)"
              >
                <Search className="size-4" aria-hidden="true" />
              </Button>

              {/* history */}
              <Button
                variant="ghost"
                className="press-apple icon-seat size-9 shrink-0 text-muted-foreground hover:text-foreground"
                onClick={onHistory}
                aria-label="المحادثات القديمة"
                title="المحادثات القديمة"
              >
                <History className="size-4" aria-hidden="true" />
              </Button>

              {/* «ورقة وكيل» — scratchpad */}
              <Button
                variant="ghost"
                className="press-apple icon-seat relative size-9 shrink-0 text-muted-foreground hover:text-foreground"
                onClick={onNotes}
                disabled={notesDisabled}
                aria-label="ورقة وكيل"
                title="ورقة وكيل — ملاحظاته من شغله في المحادثة دي"
              >
                <NotebookPen className="size-4" aria-hidden="true" />
                {notesCount > 0 && (
                  <motion.span
                    initial={{ scale: 0.4, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ type: 'spring', stiffness: 420, damping: 22 }}
                    className="num absolute -end-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--wakil-amber)] px-1 text-[9px] font-bold tabular-nums text-white dark:text-black"
                  >
                    {arNum(notesCount)}
                  </motion.span>
                )}
              </Button>

              {/* notifications */}
              <NotificationBell alerts={alerts} onNavigate={(v) => onNavigate?.(v)} />

              {/* theme */}
              <Button
                variant="ghost"
                className="press-apple icon-seat size-9 shrink-0 text-muted-foreground hover:text-foreground"
                aria-label="تبديل الوضع الليلي"
                title="الوضع الليلي"
                onClick={onToggleTheme}
              >
                <motion.span
                  key={theme ?? 'system'}
                  initial={{ rotate: -90, opacity: 0 }}
                  animate={{ rotate: 0, opacity: 1 }}
                  transition={{ duration: 0.15, ease: 'easeOut' }}
                  className="flex"
                >
                  {theme === 'dark' ? <Sun className="size-4.5" aria-hidden="true" /> : <Moon className="size-4.5" aria-hidden="true" />}
                </motion.span>
              </Button>

              {/* back to the app views (desktop) */}
              {onNavigate && (
                <Button
                  variant="ghost"
                  className="press-apple icon-seat hidden size-9 text-muted-foreground hover:text-foreground sm:inline-flex"
                  onClick={() => onNavigate('today')}
                  aria-label="افتح لوحة اليوم"
                  title="لوحة اليوم والإحصائيات"
                >
                  <LayoutGrid className="size-4" aria-hidden="true" />
                </Button>
              )}
            </motion.div>
          ) : (
            /* collapsed: the peeking وكيل avatar — the hover/tap affordance */
            <motion.button
              key="peek"
              type="button"
              initial={{ opacity: 0, y: -12 }}
              animate={{ opacity: 0.62, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ type: 'spring', stiffness: 380, damping: 28 }}
              onClick={() => setPinned(true)}
              onMouseEnter={enter}
              className="glass pointer-events-auto icon-seat mt-2 size-9 opacity-70 transition-opacity hover:opacity-100"
              aria-label="افتح شريط وكيل"
              title="الأدوات والمحادثات — مرّر الماوس هنا"
            >
              <AgentAvatar state={avatarState} size="sm" />
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      {/* pinned → outside click closes the pill */}
      {pinned && (
        <button
          type="button"
          className="fixed inset-0 z-[-1] cursor-default"
          aria-label="اقفل الشريط"
          onClick={() => setPinned(false)}
          tabIndex={-1}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Dynamic suggestion pill (welcome hero) — icon + label + reason badge
// ---------------------------------------------------------------------------
function SuggestionPill({ s, index, onPick }: { s: SuggestionDTO; index: number; onPick: () => void }) {
  const Icon = TOOL_ICONS[s.icon] ?? SquarePen
  const primary = s.tone === 'primary'
  return (
    <motion.button
      type="button"
      initial={{ opacity: 0, y: 8, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ delay: 0.15 + index * 0.05, duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      onClick={onPick}
      aria-label={s.reasonLabel ? `${s.label} — ${s.reasonLabel}` : s.label}
      title={s.prompt}
      className={cn(
        'press chip-lift flex min-h-11 max-w-full flex-col items-start gap-0.5 rounded-2xl border px-3.5 py-2 text-start transition-all focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
        primary
          ? 'border-transparent bg-primary text-primary-foreground hover:bg-primary/90'
          : 'border-border bg-card/70 backdrop-blur-sm hover:border-wakil-amber/50 hover:bg-accent hover:text-accent-foreground',
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
