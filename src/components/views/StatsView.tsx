'use client'

// وكيل — شاشة «الإحصائيات»: رسم بياني يومي + أفضل الأصناف وتوزيع الحركة.

import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { ArrowLeftRight, BarChart3, Package, PiggyBank, ShoppingBag, ShoppingCart, TrendingDown } from 'lucide-react'

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api } from '@/lib/api'
import { egp, egpPlain, qty as fmtQty } from '@/lib/format'
import { QUERY_KEYS } from '@/lib/store'
import { useQuery } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import {
  EmptyState,
  ErrorState,
  KpiCard,
  LoadingKpis,
  SectionCard,
  TYPE_AR,
  ViewHeader,
  ViewProps,
  arNum,
} from './shared'

const chartConfig = {
  sales: { label: 'مبيعات', color: 'var(--wakil-navy)' },
  purchases: { label: 'مشتريات', color: 'var(--wakil-amber)' },
  expenses: { label: 'مصروفات', color: 'var(--muted-foreground)' },
} satisfies ChartConfig

const compactAr = new Intl.NumberFormat('ar-EG', {
  notation: 'compact',
  maximumFractionDigits: 1,
})
const weekdayShort = new Intl.DateTimeFormat('ar-EG', { weekday: 'short' })
const dayNum = new Intl.DateTimeFormat('ar-EG', { day: 'numeric' })

export default function StatsView({ businessId }: ViewProps) {
  const [range, setRange] = useState<'7d' | '30d'>('7d')

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: QUERY_KEYS.reports(businessId, range),
    queryFn: () => api.reports(businessId, range),
  })

  const chartData = useMemo(
    () =>
      (data?.daily ?? []).map((d) => ({
        label: range === '7d' ? weekdayShort.format(new Date(d.date)) : dayNum.format(new Date(d.date)),
        sales: Math.round(d.sales / 100),
        purchases: Math.round(d.purchases / 100),
        expenses: Math.round(d.expenses / 100),
      })),
    [data, range],
  )

  const maxCount = useMemo(() => {
    const counts = (data?.byType ?? []).map((t) => t.count)
    return Math.max(1, ...counts)
  }, [data])

  const totals = data?.totals
  const isEmpty =
    !isPending &&
    totals != null &&
    totals.sales + totals.purchases + totals.expenses + totals.collections + totals.payments === 0

  if (isError) {
    return (
      <div className="mx-auto w-full max-w-5xl px-4 pb-8 pt-2 sm:px-6">
        <ViewHeader title="الإحصائيات" />
        <div className="mt-4">
          <ErrorState message={error.message} onRetry={() => refetch()} />
        </div>
      </div>
    )
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="mx-auto w-full max-w-5xl space-y-4 px-4 pb-8 pt-2 sm:px-6"
    >
      <ViewHeader
        title="الإحصائيات"
        action={
          <Tabs value={range} onValueChange={(v) => setRange(v as '7d' | '30d')} dir="rtl">
            <TabsList className="h-11">
              <TabsTrigger value="7d" className="min-h-9 px-4">
                آخر ٧ أيام
              </TabsTrigger>
              <TabsTrigger value="30d" className="min-h-9 px-4">
                آخر ٣٠ يوم
              </TabsTrigger>
            </TabsList>
          </Tabs>
        }
      />

      {isPending || !totals ? (
        <LoadingKpis />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
          <KpiCard index={0} label="المبيعات" value={egp(totals.sales)} icon={ShoppingCart} tone="navy" />
          <KpiCard index={1} label="المشتريات" value={egp(totals.purchases)} icon={ShoppingBag} tone="amber" />
          <KpiCard index={2} label="المصروفات" value={egp(totals.expenses)} icon={TrendingDown} tone="muted" />
          <KpiCard
            index={3}
            label="الصافي"
            value={egp(totals.net)}
            icon={totals.net >= 0 ? PiggyBank : TrendingDown}
            tone={totals.net >= 0 ? 'teal' : 'red'}
            title="بيع وتحصيل − شرا ومصروفات وسداد"
          />
        </div>
      )}

      {/* الرسم اليومي */}
      <SectionCard
        title="الحركة اليومية (ج.م)"
        icon={BarChart3}
        className="transition-colors hover:border-wakil-amber/40"
      >
        {isPending ? (
          <Skeleton className="h-[260px] w-full" aria-busy="true" />
        ) : isEmpty ? (
          <EmptyState
            icon={BarChart3}
            title="مفيش حركة في الفترة دي"
            hint="أول ما تتصالح عمليات، الرسم هيتعبّى تلقائيّاً يوم بيوم"
          />
        ) : (
          <ChartContainer config={chartConfig} className="aspect-auto h-[260px] w-full">
            <BarChart data={chartData} margin={{ top: 4, left: 0, right: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                interval={range === '30d' ? 4 : 0}
                minTickGap={4}
              />
              <YAxis
                width={44}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => compactAr.format(v)}
              />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    formatter={(value, name) => (
                      <span className="flex w-full items-center justify-between gap-4 leading-none">
                        <span className="text-muted-foreground">
                          {chartConfig[name as keyof typeof chartConfig]?.label ?? name}
                        </span>
                        <span className="num font-medium tabular-nums">
                          {egpPlain(Number(value) * 100)} ج.م
                        </span>
                      </span>
                    )}
                  />
                }
              />
              <Bar dataKey="sales" fill="var(--color-sales)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="purchases" fill="var(--color-purchases)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="expenses" fill="var(--color-expenses)" radius={[4, 4, 0, 0]} />
              <ChartLegend content={<ChartLegendContent />} />
            </BarChart>
          </ChartContainer>
        )}
      </SectionCard>

      {/* أفضل الأصناف + توزيع الحركة */}
      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="أفضل الأصناف" icon={Package}>
          {isPending ? (
            <div className="space-y-2" aria-busy="true">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-5/6" />
              <Skeleton className="h-10 w-2/3" />
            </div>
          ) : (data?.topItems?.length ?? 0) === 0 ? (
            <EmptyState
              icon={Package}
              title="لسه مفيش أصناف مبيعة في الفترة دي"
              hint="سجّل عمليات بيع من المحادثة وهنشوف هنا أكثر الأصناف طلباً"
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-start">الصنف</TableHead>
                  <TableHead className="text-start">الكمية</TableHead>
                  <TableHead className="text-start">الإيراد</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data?.topItems ?? []).map((it, i) => (
                  <TableRow key={`${it.name}-${i}`} className="hover:bg-muted/40">
                    <TableCell className="max-w-[180px] truncate py-2.5 font-medium">
                      {it.name}
                    </TableCell>
                    <TableCell className="num py-2.5 font-semibold tabular-nums">
                      {fmtQty(it.qty)}
                    </TableCell>
                    <TableCell className="num py-2.5 tabular-nums">
                      {egp(it.revenue)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </SectionCard>

        <SectionCard title="توزيع الحركة حسب النوع" icon={ArrowLeftRight}>
          {isPending ? (
            <div className="space-y-3" aria-busy="true">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-4/5" />
              <Skeleton className="h-9 w-3/5" />
            </div>
          ) : (data?.byType?.length ?? 0) === 0 ? (
            <EmptyState
              icon={ArrowLeftRight}
              title="مفيش حركة مسجّلة في الفترة دي"
              hint="كل عملياتك هتتصنّف هنا تلقائيّاً حسب نوعها"
            />
          ) : (
            <ul className="space-y-3">
              {(data?.byType ?? []).map((t, i) => (
                <li key={`${t.type}-${i}`} className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="font-medium">{TYPE_AR[t.type] ?? t.type}</span>
                    <span className="flex items-baseline gap-2 text-xs text-muted-foreground">
                      <span className="num tabular-nums">{arNum(t.count)} عملية</span>
                      <span className="num font-semibold tabular-nums">{egp(t.amount)}</span>
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn(
                        'h-full rounded-full',
                        t.type === 'sale'
                          ? 'bg-wakil-navy'
                          : t.type === 'purchase'
                            ? 'bg-wakil-amber'
                            : 'bg-muted-foreground/50',
                      )}
                      style={{ width: `${Math.max(4, Math.round((t.count / maxCount) * 100))}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </motion.div>
  )
}
