'use client'

// وكيل — شاشة «اليوم»: لمحة سريعة عن الخزنة والمبيعات والتنبيهات والاعتمادات.

import { motion } from 'framer-motion'
import {
  Activity,
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  Clock,
  Info,
  MessageSquare,
  PackageCheck,
  PackageSearch,
  ShieldCheck,
  ShoppingCart,
  TriangleAlert,
  Wallet,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { arDate, egp, qty as fmtQty } from '@/lib/format'
import { arUnit } from '@/lib/verticals'
import { QUERY_KEYS } from '@/lib/store'
import { useQuery } from '@tanstack/react-query'
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
    iconClass: 'text-destructive',
    rowClass: 'border-destructive/40 bg-destructive/5',
  },
  warning: {
    icon: TriangleAlert,
    iconClass: 'text-wakil-amber',
    rowClass: 'border-wakil-amber/35 bg-accent/60',
  },
  info: {
    icon: Info,
    iconClass: 'text-wakil-navy',
    rowClass: 'border-wakil-navy/25 bg-muted/40',
  },
} as const

export default function TodayView({ businessId, userId, onNavigate }: ViewProps) {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: QUERY_KEYS.overview(businessId, userId),
    queryFn: () => api.overview(businessId, userId),
  })

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
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiCard
            label="رصيد الخزنة"
            value={egp(data.cash.net)}
            icon={Wallet}
            tone={data.cash.net >= 0 ? 'teal' : 'red'}
            title={`افتتاحي ${egp(data.cash.opening)} — داخل ${egp(data.cash.in)} — خارج ${egp(data.cash.out)}`}
          />
          <KpiCard label="مبيعات اليوم" value={egp(data.today.sales)} icon={ShoppingCart} tone="navy" />
          <KpiCard
            label="عمليات اليوم"
            value={arNum(data.today.opsCount)}
            icon={Activity}
            tone="navy"
          />
          <KpiCard
            label="مستنيات اعتماد"
            value={arNum(pendingOps.length)}
            icon={Clock}
            tone={pendingOps.length > 0 ? 'amber' : 'muted'}
          />
        </div>
      )}

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
                  <Icon className={cn('size-4 shrink-0', style.iconClass)} aria-hidden />
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
                <li key={i}>
                  {view ? (
                    <button
                      type="button"
                      onClick={() => onNavigate?.(view)}
                      className={cn(
                        'press flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-start',
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
            {pendingOps.map((op) => (
              <li
                key={op.id}
                className="card-enter rounded-xl border border-wakil-amber/30 bg-accent/50 p-3.5"
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
                  {onNavigate && (
                    <Button
                      size="sm"
                      className="min-h-10"
                      onClick={() => onNavigate('chat')}
                    >
                      <MessageSquare aria-hidden /> راجعها في المحادثة
                    </Button>
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
