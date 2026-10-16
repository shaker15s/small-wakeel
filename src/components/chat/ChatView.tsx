// وكيل — ChatView: the conversation-first heart of the app.
// Letter-by-letter streaming, visible thinking, live action cards, approvals,
// model switching — all wired to the SSE harness.

'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { Check, ChevronDown, Cpu, Loader2 } from 'lucide-react'
import { api, messageToTurn, streamChat } from '@/lib/api'
import { getVertical } from '@/lib/verticals'
import { useWakil, QUERY_KEYS } from '@/lib/store'
import type { ActionCardDTO, BusinessLite, ChatTurn, ThinkingStep } from '@/lib/types'
import { AgentAvatar, type AgentState } from './AgentAvatar'
import { MessageBubble } from './MessageBubble'
import { Composer } from './Composer'
import { TIER_AR } from '@/lib/labels'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'

interface ChatViewProps {
  business: BusinessLite
  userId: string
}

export function ChatView({ business, userId }: ChatViewProps) {
  const vertical = getVertical(business.type)
  const modelKey = useWakil((s) => s.modelKey)
  const setModel = useWakil((s) => s.setModel)
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [live, setLive] = useState<ChatTurn | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [busyOpId, setBusyOpId] = useState<string | null>(null)
  const [modelOpen, setModelOpen] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const nearBottomRef = useRef(true)
  const busyOpRef = useRef<string | null>(null)

  // ---- load conversation ----
  const { data, isLoading, refetch } = useQuery({
    queryKey: QUERY_KEYS.chat(business.id, userId),
    queryFn: () => api.chat(business.id, userId),
  })
  useEffect(() => {
    if (data) {
      setTurns(data.messages.map(messageToTurn))
      setConversationId(data.conversation.id)
    }
  }, [data])

  // ---- smart scroll: follow only when user is near bottom ----
  const scrollToBottom = useCallback((smooth = true) => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }, [])
  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140
  }, [])
  useEffect(() => {
    if (nearBottomRef.current) scrollToBottom(false)
  }, [turns, live?.text, live?.thinking?.length, scrollToBottom])

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

  const enabledExternal = (providersData?.providers ?? []).flatMap((p) => p.models).filter((m) => m.enabled)

  // ---- send a message → stream the turn ----
  const send = useCallback(
    async (text: string) => {
      if (sending || !text.trim()) return
      setSending(true)
      const userTurn: ChatTurn = {
        id: `local-user-${Date.now()}`,
        role: 'user',
        text: text.trim(),
        createdAt: new Date().toISOString(),
      }
      setTurns((prev) => [...prev, userTurn])
      nearBottomRef.current = true

      const liveTurn: ChatTurn = {
        id: `local-live-${Date.now()}`,
        role: 'assistant',
        text: '',
        thinking: [{ label: 'بفهم طلبك', detail: 'بحلل الجملة وأستخرج القصد والحقول', state: 'active', icon: 'understand' }],
        createdAt: new Date().toISOString(),
        streaming: true,
      }
      setLive({ ...liveTurn })

      try {
        await streamChat(
          { businessId: business.id, userId, text: text.trim(), modelKey, conversationId },
          {
            onStart: (cid) => setConversationId(cid),
            onThinking: (steps) => setLive((l) => (l ? { ...l, thinking: steps } : l)),
            onStep: () => undefined,
            onCard: (card) => setLive((l) => (l ? { ...l, card } : l)),
            onCards: (cards) => setLive((l) => (l ? { ...l, cards } : l)),
            onDelta: (d) => setLive((l) => (l ? { ...l, text: l.text + d } : l)),
            onDone: (messageId, modelLabel) => {
              setLive((l) => (l ? { ...l, id: messageId, streaming: false, modelLabel } : l))
            },
            onError: (message) => {
              toast({ title: 'مشكلة', description: message, variant: 'destructive' })
              setLive((l) =>
                l
                  ? { ...l, text: l.text || 'حصل خطأ — جرّب تاني', streaming: false }
                  : l,
              )
            },
          },
        )
      } catch (err) {
        toast({ title: 'مشكلة', description: 'الاتصال اتقطع — جرّب تاني', variant: 'destructive' })
        setLive((l) => (l ? { ...l, text: l.text || 'الاتصال اتقطع — جرّب تاني', streaming: false } : l))
      } finally {
        setSending(false)
        // finalize: move live → turns
        setLive((l) => {
          if (l) setTurns((prev) => [...prev, { ...l, streaming: false }])
          return null
        })
        void refetch()
        void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.overview(business.id, userId) })
        void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.operations(business.id) })
      }
    },
    [sending, business.id, userId, modelKey, conversationId, toast, refetch, queryClient],
  )

  // ---- approvals ----
  const approve = useCallback(
    async (card: ActionCardDTO, reason?: string) => {
      if (!card.opId) return
      setBusyOpId(card.opId)
      busyOpRef.current = card.opId
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
        toast({ title: 'مشكلة في الاعتماد', description: err instanceof Error ? err.message : 'جرّب تاني', variant: 'destructive' })
      } finally {
        setBusyOpId(null)
        busyOpRef.current = null
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

  const liveAvatarState: AgentState = live
    ? live.streaming && !live.text
      ? 'thinking'
      : live.streaming && live.text
        ? 'writing'
        : live.card || live.cards
          ? 'executing'
          : 'idle'
    : 'idle'

  const showWelcome = !isLoading && turns.length === 0 && !live

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* header: vertical label + model picker */}
      <div className="flex items-center justify-between gap-2 border-b border-border/70 bg-card/60 px-3 py-2 backdrop-blur-sm sm:px-4">
        <div className="flex items-center gap-2">
          <AgentAvatar state="idle" size="sm" />
          <div className="min-w-0">
            <p className="truncate text-sm font-bold">{business.name}</p>
            <p className="truncate text-[11px] text-muted-foreground">{vertical.label} — {vertical.headerLabel}</p>
          </div>
        </div>

        {/* model picker */}
        <div className="relative">
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5 rounded-full text-xs font-medium"
            onClick={() => setModelOpen((v) => !v)}
            aria-label="تبديل الموديل"
            aria-expanded={modelOpen}
          >
            <Cpu className="size-3.5 text-wakil-amber" />
            <span className="max-w-28 truncate">{currentLabel}</span>
            <ChevronDown className={`size-3 transition-transform ${modelOpen ? 'rotate-180' : ''}`} />
          </Button>
          {modelOpen && (
            <>
              <button className="fixed inset-0 z-40 cursor-default" aria-label="اقفل" onClick={() => setModelOpen(false)} />
              <motion.div
                initial={{ opacity: 0, y: -4, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ duration: 150 }}
                className="absolute end-0 z-50 mt-1.5 w-56 overflow-hidden rounded-xl border border-border bg-popover shadow-lg"
              >
                <p className="border-b border-border/60 px-3 py-2 text-[11px] font-semibold text-muted-foreground">الموديلات الداخلية</p>
                {[
                  { key: 'builtin-deep', label: 'عميق مفكّر', sub: 'glm-4.6 · للمهام المعقدة' },
                  { key: 'builtin-air', label: 'خفيف سريع', sub: 'glm-4.6 · سريع ويكفي' },
                ].map((m) => (
                  <ModelRow key={m.key} label={m.label} sub={m.sub} active={modelKey === m.key} onClick={() => { setModel(m.key); setModelOpen(false) }} />
                ))}
                {enabledExternal.length > 0 && (
                  <>
                    <p className="border-y border-border/60 bg-muted/40 px-3 py-2 text-[11px] font-semibold text-muted-foreground">مزوّدين خارجيين</p>
                    {enabledExternal.map((m) => (
                      <ModelRow
                        key={m.id}
                        label={m.label}
                        sub={`${TIER_AR[m.tier] ?? m.tier} · ${m.remoteId}`}
                        active={modelKey === `ext:${m.id}`}
                        onClick={() => { setModel(`ext:${m.id}`); setModelOpen(false) }}
                      />
                    ))}
                  </>
                )}
                <p className="px-3 py-2 text-[10px] leading-relaxed text-muted-foreground">
                  تقدر تضيف مزوّدين من الإعدادات
                </p>
              </motion.div>
            </>
          )}
        </div>
      </div>

      {/* messages */}
      <div ref={scrollRef} onScroll={onScroll} className="scroll-warm min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-4">
        {isLoading && (
          <div className="space-y-3" aria-label="بيحمّل المحادثة">
            <div className="h-16 animate-pulse rounded-2xl bg-muted" />
            <div className="h-24 animate-pulse rounded-2xl bg-muted/70" />
            <div className="h-16 animate-pulse rounded-2xl bg-muted/50" />
          </div>
        )}

        {showWelcome && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 260 }}
            className="mx-auto flex max-w-md flex-col items-center gap-4 py-8 text-center"
          >
            <AgentAvatar state="idle" size="lg" />
            <div>
              <h2 className="text-lg font-bold">أهلاً بيك 👋</h2>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{vertical.welcome}</p>
            </div>
            <div className="flex flex-wrap justify-center gap-1.5">
              {vertical.examples.map((ex) => (
                <button
                  key={ex}
                  onClick={() => void send(ex)}
                  className="press rounded-full border border-border bg-card px-3.5 py-2 text-xs hover:bg-accent"
                >
                  {ex}
                </button>
              ))}
            </div>
          </motion.div>
        )}

        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          {turns.map((t) => (
            <MessageBubble key={t.id} turn={t} onApprove={approve} onReject={reject} busyOpId={busyOpId} />
          ))}
          {live && (
            <div className="card-enter">
              {live.streaming && !live.text ? (
                <div className="flex items-center gap-2.5">
                  <AgentAvatar state={liveAvatarState} size="md" />
                  <div className="rounded-2xl rounded-ss-sm border border-border bg-card px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <span className="thinking-dot size-1.5 rounded-full bg-wakil-amber" />
                      <span className="thinking-dot size-1.5 rounded-full bg-wakil-amber" />
                      <span className="thinking-dot size-1.5 rounded-full bg-wakil-amber" />
                      <span className="ms-2 text-xs text-muted-foreground">وكيل بيفكر…</span>
                    </div>
                    {live.thinking && live.thinking.length > 1 && (
                      <ul className="mt-2 space-y-1">
                        {live.thinking.filter((s) => s.state !== 'pending').slice(-3).map((s, i) => (
                          <li key={i} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                            {s.state === 'done' ? <Check className="size-3 text-emerald-600" /> : <Loader2 className="size-3 animate-spin text-wakil-amber" />}
                            {s.label}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              ) : (
                <MessageBubble turn={live} busyOpId={busyOpId} />
              )}
            </div>
          )}
        </div>
      </div>

      {/* composer */}
      <div className="border-t border-border/70 bg-card/60 px-3 pb-3 pt-2 backdrop-blur-sm sm:px-4">
        <div className="mx-auto max-w-2xl">
          <Composer chips={vertical.chips} onSend={send} disabled={sending} />
          <p className="mt-1.5 hidden text-center text-[10px] text-muted-foreground sm:block">
            وكيل بيسأل قبل ما ينفذ — كل عملية بتتحقق بعد التنفيذ
          </p>
        </div>
      </div>
    </div>
  )
}

function ModelRow({ label, sub, active, onClick }: { label: string; sub: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-2 px-3 py-2.5 text-start transition-colors hover:bg-accent ${active ? 'bg-accent/70' : ''}`}
    >
      <span className="min-w-0">
        <span className="block truncate text-xs font-semibold">{label}</span>
        <span className="block truncate text-[10px] text-muted-foreground">{sub}</span>
      </span>
      {active && <Check className="size-4 shrink-0 text-wakil-amber" />}
    </button>
  )
}
