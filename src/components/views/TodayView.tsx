'use client'

// وكيل — شاشة «اليوم»: لمحة سريعة عن الخزنة والمبيعات والتنبيهات والاعتمادات.

import { useCallback, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Activity,
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  CircleAlert,
  Clock,
  Info,
  Loader2,
  MessageSquare,
  PackageCheck,
  PackageSearch,
  ShieldAlert,
  ShieldCheck,
  ShoppingCart,
  TriangleAlert,
  Wallet,
  X,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { arAgo, arDate, egp, isTodayCairo, qty as fmtQty } from '@/lib/format'
import { arUnit } from '@/lib/verticals'
import { QUERY_KEYS } from '@/lib/store'
import type { ViewKey } from '@/lib/store'
import type { RadarInsightDTO } from '@/lib/types'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import {
  EmptyState,
  ErrorState,
  KpiCard,
  LoadingKpis,
  RiskBadge,
  SectionCard,
  ViewHeader,
  ViewProps,
  arNum,
  safeView,
  TypeBadge,
} from './shared'

const ALERT_STYLE = {
  danger: {
    icon: TriangleAlert,
    circleClass: 'bg-destructive/10 text-destructive',
    rowClass: 'border-destructive/40 bg-destructive/5 hover:bg-destructive/10',
  },
  warning: {
    icon: TriangleAlert,
    circleClass: 'bg-wakil-amber/15 text-wakil-amber',
    rowClass: 'border-wakil-amber/35 bg-accent/60 hover:bg-accent',
  },
  info: {
    icon: Info,
    circleClass: 'bg-wakil-navy/10 text-wakil-navy',
    rowClass: 'border-wakil-navy/25 bg-muted/40 hover:bg-muted/70',
  },
} as const

export default function TodayView({ businessId, userId, onNavigate }: ViewProps) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [busyOpId, setBusyOpId] = useState<string | null>(null)
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: QUERY_KEYS.overview(businessId, userId),
    queryFn: () => api.overview(businessId, userId),
  })

  // Approve/reject straight from the Today card — ops that never went through
  // chat (e.g. seeded drafts) used to deep-link to a chat with no card in it:
  // a dead end. R3 keeps the chat link because it needs a documented reason
  // (the chat flow collects it).
  const decide = useCallback(
    async (opId: string, action: 'approve' | 'reject', ref: string) => {
      if (busyOpId) return
      setBusyOpId(opId)
      try {
        const res = await api.confirmOperation(opId, action, userId)
        toast({
          title: action === 'approve' ? (res.outcome?.ok ? 'تم — موثّق ومتحقق' : 'العملية فشلت بأمان') : 'اتلغت المسودة',
          description:
            action === 'approve'
              ? res.outcome?.ok
                ? `${res.operation.ref} — ${res.operation.summary}`
                : (res.outcome?.failReason ?? 'راجع التفاصيل في السجل')
              : `${res.operation.ref} اتلغت بلا أي أثر`,
          variant: action === 'approve' && !res.outcome?.ok ? 'destructive' : 'default',
        })
        void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.overview(businessId, userId) })
        void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.operations(businessId) })
        void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.items(businessId) })
      } catch (err) {
        toast({
          title: action === 'approve' ? 'مشكلة في الاعتماد' : 'مشكلة',
          description: err instanceof Error ? err.message : 'جرّب تاني',
          variant: 'destructive',
        })
      } finally {
        setBusyOpId(null)
      }
    },
    [busyOpId, userId, businessId, toast, queryClient],
  )

  if (isError) {
    return (
      <div className="mx-auto w-full max-w-5xl px-4 pb-8 pt-2 sm:px-6">
        <ViewHeader title="اليوم" subtitle={arDate(new Date())} />
        <div className="mt-4">
          <ErrorState message={error.message} onRetry={() => refetch()} />
        </div>
      </div>
    )
  }

  const lowStock = data?.lowStock ?? []
  const expiring = data?.expiring ?? []
  const pendingOps = data?.pendingOps ?? []
  const alerts = data?.alerts ?? []

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="mx-auto w-full max-w-5xl space-y-4 px-4 pb-8 pt-2 sm:space-y-5 sm:px-6"
    >
      <ViewHeader title="اليوم" subtitle={arDate(new Date())} />

      {/* KPI row — fixed h-24 cards, no layout shift while loading */}
      {isPending || !data ? (
        <LoadingKpis />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
          <KpiCard
            index={0}
            label="رصيد الخزنة"
            value={egp(data.cash.net)}
            icon={Wallet}
            tone={data.cash.net >= 0 ? 'teal' : 'red'}
            title={`افتتاحي ${egp(data.cash.opening)} — داخل ${egp(data.cash.in)} — خارج ${egp(data.cash.out)}`}
          />
          <KpiCard
            index={1}
            label="مبيعات اليوم"
            value={egp(data.today.sales)}
            icon={ShoppingCart}
            tone="navy"
            title={data.today.sales === 0 && data.recentOps[0] ? `آخر حركة: ${arAgo(data.recentOps[0].createdAt)}` : undefined}
          />
          <KpiCard
            index={2}
            label="عمليات اليوم"
            value={arNum(data.today.opsCount)}
            icon={Activity}
            tone="navy"
          />
          <KpiCard
            index={3}
            label="مستنيات اعتماد"
            value={arNum(pendingOps.length)}
            icon={Clock}
            tone={pendingOps.length > 0 ? 'amber' : 'muted'}
          />
        </div>
      )}

      {/* «الشاشة باينة فاضية» — the day has not started yet. Say so, and show
          when the last real movement was, instead of four zeros with no story.
          R30: the old copy could contradict itself («مفيش حركة — آخر حركة
          كانت النهاردة ٧:٣٣ ص») because `recentOps` counts cancelled QA drafts
          too. Now the sentence matches the facts it was built from. */}
      {data && data.today.doneCount === 0 && (pendingOps.length > 0 || data.recentOps[0]) && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
          <Clock className="size-3.5 shrink-0 text-wakil-amber" aria-hidden />
          {pendingOps.length > 0 ? (
            <>النهاردة لسه مفيش عمليات مكتملة — عندك {arNum(pendingOps.length)} مسودة مستنية قرارك.</>
          ) : data.recentOps[0] && isTodayCairo(data.recentOps[0].createdAt) ? (
            <>النهاردة لسه مفيش عمليات مكتملة — آخر محاولة كانت {arAgo(data.recentOps[0].createdAt)}.</>
          ) : (
            <>النهاردة لسه مفيش حركة — آخر حركة كانت {arAgo(data.recentOps[0]?.createdAt ?? '')}.</>
          )}
        </p>
      )}

      {/* رادار الأمانة — صاحب المنشأة بس (سوبر باور) */}
      <RadarDigest businessId={businessId} userId={userId} onNavigate={onNavigate} />

      {/* تنبيهات */}
      <SectionCard title="تنبيهات" icon={ShieldCheck}>
        {isPending ? (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-3/4" />
          </div>
        ) : alerts.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title="مفيش تنبيهات النهاردة"
            hint="كل حاجة تحت السيطرة — لو حاجة تحتاج انتباهك هنقولك هنا"
          />
        ) : (
          <ul className="space-y-2">
            {alerts.map((a, i) => {
              const style = ALERT_STYLE[a.level] ?? ALERT_STYLE.info
              const Icon = style.icon
              const view = safeView(a.action?.view)
              const content = (
                <>
                  <span
                    className={cn(
                      'flex size-7 shrink-0 items-center justify-center rounded-full',
                      style.circleClass,
                      a.level === 'danger' && 'pulse-ring',
                    )}
                  >
                    <Icon className="size-4" aria-hidden />
                  </span>
                  <p className="min-w-0 flex-1 text-sm leading-relaxed">{a.text}</p>
                  {view && (
                    <>
                      <span className="hidden text-xs font-medium text-muted-foreground sm:inline">
                        {a.action?.label}
                      </span>
                      <ChevronLeft className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    </>
                  )}
                </>
              )
              return (
                <li key={i} className="list-enter" style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
                  {view ? (
                    <button
                      type="button"
                      onClick={() => onNavigate?.(view)}
                      className={cn(
                        'press focus-warm flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-start transition-colors',
                        style.rowClass,
                      )}
                    >
                      {content}
                    </button>
                  ) : (
                    <div
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5',
                        style.rowClass,
                      )}
                    >
                      {content}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </SectionCard>

      {/* مستنيات اعتمادك */}
      <SectionCard
        title="مستنيات اعتمادك"
        icon={Clock}
        action={
          pendingOps.length > 0 ? (
            <CountChip count={pendingOps.length} />
          ) : undefined
        }
      >
        {isPending ? (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-5/6" />
          </div>
        ) : pendingOps.length === 0 ? (
          <EmptyState
            icon={CheckCircle2}
            title="مفيش حاجة مستنية اعتمادك"
            hint="كل العمليات الموثقة اتنفذت — لما وكيل يجهز عملية جديدة هتظهر هنا"
          />
        ) : (
          <ul className="space-y-2.5">
            {pendingOps.map((op, i) => (
              <li
                key={op.id}
                style={{ animationDelay: `${Math.min(i, 6) * 40}ms` }}
                className="card-enter rounded-xl border border-wakil-amber/30 bg-accent/50 p-3.5 transition-colors hover:border-primary/30"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="num font-mono text-xs font-semibold text-muted-foreground">
                    {op.ref}
                  </span>
                  <TypeBadge type={op.type} />
                  <RiskBadge risk={op.risk} />
                </div>
                <p className="mt-2 text-sm leading-relaxed">{op.summary}</p>
                <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    {op.userName ?? '—'} · {op.risk === 'R3' ? 'محتاجة سبب موثق' : 'محتاجة اعتمادك'}
                  </span>
                  {op.risk === 'R3' ? (
                    onNavigate && (
                      <Button size="sm" className="min-h-10" onClick={() => onNavigate('chat')}>
                        <MessageSquare aria-hidden /> راجعها في المحادثة
                      </Button>
                    )
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <Button
                        size="sm"
                        className="min-h-10"
                        disabled={busyOpId === op.id}
                        onClick={() => void decide(op.id, 'approve', op.ref)}
                      >
                        {busyOpId === op.id ? (
                          <Loader2 className="animate-spin" aria-hidden />
                        ) : (
                          <ShieldCheck aria-hidden />
                        )}
                        اعتماد
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="min-h-10"
                        disabled={busyOpId === op.id}
                        onClick={() => void decide(op.id, 'reject', op.ref)}
                      >
                        <X aria-hidden /> رفض
                      </Button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {/* المخزون الناقص — أعلى ٥ */}
      <SectionCard
        title="المخزون الناقص"
        icon={PackageSearch}
        action={
          onNavigate && lowStock.length > 0 ? (
            <Button variant="ghost" size="sm" className="min-h-10" onClick={() => onNavigate('inventory')}>
              شوف كل المخزون <ChevronLeft aria-hidden />
            </Button>
          ) : undefined
        }
      >
        {isPending ? (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-5/6" />
            <Skeleton className="h-11 w-2/3" />
          </div>
        ) : lowStock.length === 0 ? (
          <EmptyState
            icon={PackageCheck}
            title="المخزون كله فوق حد التنبيه"
            hint="لما أي صنف ينزل تحت حده هننبهك هنا فوراً"
          />
        ) : (
          <ul className="divide-y">
            {lowStock.slice(0, 5).map((it) => (
              <li key={it.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <TriangleAlert className="size-4 shrink-0 text-wakil-amber" aria-hidden />
                  <span className="truncate text-sm font-medium">{it.name}</span>
                </div>
                <div className="flex shrink-0 items-baseline gap-2 text-sm">
                  <span className="num font-semibold text-wakil-amber tabular-nums">
                    {fmtQty(it.stockQty, arUnit(it.unit))}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    (الحد: <span className="num tabular-nums">{fmtQty(it.lowStockThreshold, arUnit(it.unit))}</span>)
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {/* صلاحيات قربتخلص — صيدلية بس */}
      {expiring.length > 0 && (
        <SectionCard
          title="أصناف صلاحيتها قربت تخلص"
          icon={CalendarClock}
          action={
            onNavigate && (
              <Button variant="ghost" size="sm" className="min-h-10" onClick={() => onNavigate('inventory')}>
                راجع المخزون <ChevronLeft aria-hidden />
              </Button>
            )
          }
        >
          <ul className="divide-y">
            {expiring.slice(0, 6).map((it) => {
              const d = it.daysToExpiry ?? 0
              return (
                <li key={it.id} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="truncate text-sm font-medium">{it.name}</span>
                  {d <= 0 ? (
                    <span className="shrink-0 rounded-md bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                      منتهية
                    </span>
                  ) : (
                    <span className="num shrink-0 rounded-md bg-wakil-amber/10 px-2 py-0.5 text-xs font-medium text-wakil-amber tabular-nums">
                      باقي {arNum(d)} يوم
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </SectionCard>
      )}
    </motion.div>
  )
}

function CountChip({ count }: { count: number }) {
  return (
    <span className="num rounded-full bg-wakil-amber/15 px-2.5 py-0.5 text-xs font-semibold text-wakil-amber tabular-nums">
      {arNum(count)}
    </span>
  )
}

// ---------------------------------------------------------------------------
// رادار الأمانة — owner-only fraud radar digest (superpower feature).
// Endpoint /api/radar is owned by R14-brain; until it lands we stay silent:
// fetch failure / empty payload / non-owner → the section never renders.
// ---------------------------------------------------------------------------

const RADAR_LEVEL: Record<RadarInsightDTO['level'], { icon: typeof ShieldAlert; circle: string; pulse: boolean }> = {
  danger: { icon: CircleAlert, circle: 'bg-destructive/10 text-destructive', pulse: true },
  warning: { icon: TriangleAlert, circle: 'bg-wakil-amber/15 text-wakil-amber', pulse: false },
  info: { icon: Info, circle: 'bg-wakil-navy/10 text-wakil-navy', pulse: false },
}

function normalizeRadar(raw: RadarInsightDTO): RadarInsightDTO {
  const level = (['info', 'warning', 'danger'] as const).includes(raw.level) ? raw.level : 'info'
  return {
    id: String(raw.id ?? Math.random()),
    level,
    title: typeof raw.title === 'string' ? raw.title : '',
    detail: typeof raw.detail === 'string' ? raw.detail : '',
    evidence: Array.isArray(raw.evidence)
      ? raw.evidence.filter((e) => e && typeof e.label === 'string')
      : [],
  }
}

function RadarDigest({
  businessId,
  userId,
  onNavigate,
}: {
  businessId: string
  userId: string
  onNavigate?: (v: ViewKey) => void
}) {
  // owner gate — role comes from the bootstrap cache (shared with AppShell)
  const { data: bootstrap } = useQuery({
    queryKey: ['bootstrap'],
    queryFn: () => api.bootstrap(),
    staleTime: 60_000,
  })
  const isOwner = useMemo(() => {
    const b = bootstrap?.businesses.find((x) => x.id === businessId)
    return b?.users.find((u) => u.id === userId)?.role === 'owner'
  }, [bootstrap, businessId, userId])

  const { data, isPending } = useQuery({
    queryKey: QUERY_KEYS.radar(businessId),
    queryFn: async (): Promise<RadarInsightDTO[]> => {
      const res = await fetch(`/api/radar?businessId=${businessId}&userId=${userId}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`radar ${res.status}`)
      const body = (await res.json()) as RadarInsightDTO[] | { insights?: RadarInsightDTO[] }
      return Array.isArray(body) ? body : (body.insights ?? [])
    },
    enabled: isOwner,
    retry: false,
    staleTime: 30_000,
  })

  if (!isOwner) return null

  const insights = (data ?? []).map(normalizeRadar)

  if (isPending) {
    return (
      <SectionCard title="رادار الأمانة" icon={ShieldAlert} accent="danger">
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-5/6" />
        </div>
      </SectionCard>
    )
  }

  if (insights.length === 0) return null

  return (
    <SectionCard
      title="رادار الأمانة"
      icon={ShieldAlert}
      subtitle="مراقبة لصالحك — محدش شايفها غيرك"
      accent="danger"
      action={
        <span className="badge-breathe inline-flex items-center gap-1.5 rounded-full border border-destructive/25 bg-destructive/5 px-2.5 py-1 text-[10px] font-semibold text-destructive">
          <span className="size-1.5 rounded-full bg-destructive" aria-hidden />
          مراقبة حية
        </span>
      }
    >
      {/* shield watermark — the exclusive feel */}
      <span
        aria-hidden
        className="pointer-events-none absolute -end-8 -top-8 hidden size-32 text-destructive/5 sm:block dark:text-destructive/10"
      >
        <ShieldAlert className="size-full" strokeWidth={1.5} />
      </span>
      <ul className="space-y-2" aria-label="رصد رادار الأمانة">
        {insights.map((ins, i) => {
          const meta = RADAR_LEVEL[ins.level] ?? RADAR_LEVEL.info
          const Icon = meta.icon
          return (
            <li
              key={ins.id}
              className="list-enter press-deep rounded-xl border p-3.5 transition-colors hover:bg-muted/40"
              style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
            >
              <div className="flex items-start gap-3">
                <span
                  className={cn(
                    'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full',
                    meta.circle,
                    meta.pulse && 'pulse-ring',
                  )}
                >
                  <Icon className="size-4" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{ins.title}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{ins.detail}</p>
                  {ins.evidence.length > 0 && (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {ins.evidence.map((ev, j) => {
                        const view = safeView(ev.view)
                        const chip = (
                          <>
                            {ev.ref && (
                              <span className="num font-mono text-[10px] tabular-nums">{ev.ref}</span>
                            )}
                            <span className="text-[11px]">{ev.label}</span>
                          </>
                        )
                        return view && onNavigate ? (
                          <button
                            key={j}
                            type="button"
                            onClick={() => onNavigate(view)}
                            className="press focus-warm inline-flex min-h-9 items-center gap-1.5 rounded-full border border-border bg-card px-2.5 transition-colors hover:border-wakil-amber/40 hover:bg-accent"
                          >
                            {chip}
                          </button>
                        ) : (
                          <span
                            key={j}
                            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5"
                          >
                            {chip}
                          </span>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </SectionCard>
  )
}
