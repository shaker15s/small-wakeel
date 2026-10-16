'use client'

// وكيل — شاشة «التقارير»: تقرير فترة نظيف قابل للطباعة + تصدير البيانات.

import { useState } from 'react'
import { motion } from 'framer-motion'
import { Download, FileSpreadsheet, FileText, Printer, Sparkles, TrendingUp } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { arDate, arDateTime, egp, qty as fmtQty } from '@/lib/format'
import { QUERY_KEYS } from '@/lib/store'
import { useQuery } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import {
  EmptyState,
  ErrorState,
  Money,
  TYPE_AR,
  ViewHeader,
  ViewProps,
  arNum,
} from './shared'

export interface ReportsViewProps extends ViewProps {
  /** اسم النشاط للطباعة — لو مش موجود بنستخدم placeholder. */
  businessName?: string
}

export default function ReportsView({ businessId, businessName }: ReportsViewProps) {
  const [range, setRange] = useState<'7d' | '30d'>('7d')

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: QUERY_KEYS.reports(businessId, range),
    queryFn: () => api.reports(businessId, range),
  })

  const totals = data?.totals
  const profit = totals != null ? totals.sales - totals.purchases - totals.expenses : 0

  if (isError) {
    return (
      <div className="mx-auto w-full max-w-5xl px-4 pb-8 pt-2 sm:px-6">
        <ViewHeader title="التقارير" />
        <div className="mt-4">
          <ErrorState message={error.message} onRetry={() => refetch()} />
        </div>
      </div>
    )
  }

  const summaryRows: { label: string; value: number; tone?: string }[] = [
    { label: 'المبيعات', value: totals?.sales ?? 0, tone: 'text-wakil-navy' },
    { label: 'المشتريات', value: totals?.purchases ?? 0, tone: 'text-wakil-amber' },
    { label: 'المصروفات', value: totals?.expenses ?? 0, tone: 'text-muted-foreground' },
    { label: 'التحصيلات', value: totals?.collections ?? 0, tone: 'text-wakil-teal' },
    { label: 'السداد للموردين', value: totals?.payments ?? 0, tone: 'text-wakil-amber' },
    {
      label: 'صافي الفترة',
      value: totals?.net ?? 0,
      tone: (totals?.net ?? 0) >= 0 ? 'text-wakil-teal' : 'text-destructive',
    },
  ]

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="mx-auto w-full max-w-4xl space-y-4 px-4 pb-8 pt-2 sm:px-6"
    >
      <ViewHeader
        title="التقارير"
        subtitle="تقرير موثّق من سجل العمليات — اطبعه أو صدّر البيانات الخام"
        action={
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <Tabs value={range} onValueChange={(v) => setRange(v as '7d' | '30d')} dir="rtl">
              <TabsList className="h-11">
                <TabsTrigger value="7d" className="min-h-9 px-4">
                  ٧ أيام
                </TabsTrigger>
                <TabsTrigger value="30d" className="min-h-9 px-4">
                  ٣٠ يوم
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <Button asChild variant="outline" className="chip-lift min-h-11">
              <a
                href={`/api/export?businessId=${encodeURIComponent(businessId)}`}
                target="_blank"
                rel="noopener"
                aria-label="تصدير البيانات"
              >
                <Download aria-hidden /> تصدير البيانات
              </a>
            </Button>
            <Button
              variant="secondary"
              className="chip-lift group min-h-11"
              onClick={() => window.print()}
              aria-label="اطبع التقرير"
            >
              <Printer
                className="transition-transform duration-150 group-active:scale-90 group-active:-rotate-6"
                aria-hidden
              />
              اطبع
            </Button>
          </div>
        }
      />

      <Card className="card-enter print:border-0 print:shadow-none">
        {/* رأس التقرير */}
        <CardHeader className="border-b gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <FileText className="size-4 text-wakil-amber" aria-hidden />
            تقرير وكيل — {businessName ?? 'النشاط التجاري'}
          </CardTitle>
          <dl className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
            <div className="flex gap-1.5">
              <dt className="font-medium">الفترة:</dt>
              <dd>{range === '7d' ? 'آخر ٧ أيام' : 'آخر ٣٠ يوم'}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="font-medium">تاريخ الإنشاء:</dt>
              <dd className="num">{arDateTime(new Date())}</dd>
            </div>
            <div className="flex gap-1.5 sm:col-span-2">
              <dt className="font-medium">مصدر البيانات:</dt>
              <dd>سجل العمليات الموثقة</dd>
            </div>
          </dl>
        </CardHeader>

        <CardContent className="space-y-6">
          {/* ملخص الفترة */}
          <section aria-labelledby="report-summary">
            <h3 id="report-summary" className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <FileSpreadsheet className="size-4 text-wakil-amber" aria-hidden />
              ملخص الفترة
            </h3>
            {isPending ? (
              <div className="grid gap-2 sm:grid-cols-2" aria-busy="true">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : (
              <dl className="grid gap-2 sm:grid-cols-2">
                {summaryRows.map((r) => (
                  <div
                    key={r.label}
                    className="flex items-center justify-between gap-2 rounded-lg border bg-muted/30 px-3 py-2"
                  >
                    <dt className="text-sm text-muted-foreground">{r.label}</dt>
                    <dd className={cn('text-sm font-bold tabular-nums', r.tone)}>
                      <span className="num">{egp(r.value)}</span>
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </section>

          {/* أرباح تقديرية */}
          <section aria-labelledby="report-profit" className="rounded-xl border border-wakil-teal/25 bg-accent/40 p-4 text-center">
            <h3 id="report-profit" className="flex items-center justify-center gap-2 text-sm font-semibold">
              <TrendingUp className="size-4 text-wakil-amber" aria-hidden />
              أرباح تقديرية
            </h3>
            {isPending ? (
              <Skeleton className="mx-auto mt-2 h-10 w-40" aria-busy="true" />
            ) : (
              <>
                <p
                  className={cn(
                    'num mt-2 text-3xl font-bold tabular-nums',
                    profit >= 0 ? 'text-wakil-teal' : 'text-destructive',
                  )}
                >
                  {egp(profit)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  المبيعات − المشتريات − المصروفات (تقديرية، مش بديل عن محاسبة رسمية)
                </p>
              </>
            )}
          </section>

          {/* حركة حسب النوع */}
          <section aria-labelledby="report-bytype">
            <h3 id="report-bytype" className="mb-3 text-sm font-semibold">
              حركة حسب النوع
            </h3>
            {isPending ? (
              <Skeleton className="h-28 w-full" aria-busy="true" />
            ) : (data?.byType?.length ?? 0) === 0 ? (
              <EmptyState
                icon={FileText}
                title="مفيش حركة في الفترة دي"
                hint="العمليات المسجّلة هتظهر هنا مصنّفة بالنوع والعدد والمبلغ"
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="text-start">النوع</TableHead>
                    <TableHead className="text-start">العدد</TableHead>
                    <TableHead className="text-start">الإجمالي</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(data?.byType ?? []).map((t, i) => (
                    <TableRow key={`${t.type}-${i}`} className="hover:bg-muted/40">
                      <TableCell className="py-2.5 font-medium">
                        {TYPE_AR[t.type] ?? t.type}
                      </TableCell>
                      <TableCell className="num py-2.5 tabular-nums">
                        {arNum(t.count)}
                      </TableCell>
                      <TableCell className="py-2.5">
                        <Money value={t.amount} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>

          {/* أفضل الأصناف */}
          <section aria-labelledby="report-topitems">
            <h3 id="report-topitems" className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <Sparkles className="size-4 text-wakil-amber" aria-hidden />
              أفضل الأصناف
            </h3>
            {isPending ? (
              <Skeleton className="h-28 w-full" aria-busy="true" />
            ) : (data?.topItems?.length ?? 0) === 0 ? (
              <EmptyState
                icon={Sparkles}
                title="مفيش أصناف مبيعة في الفترة دي"
                hint="أكثر الأصناف طلباً هتظهر هنا بالكمية والإيراد"
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
                    <TableRow key={`${it.name}-${i}`}>
                      <TableCell className="py-2.5 font-medium">{it.name}</TableCell>
                      <TableCell className="num py-2.5 font-semibold tabular-nums">
                        {fmtQty(it.qty)}
                      </TableCell>
                      <TableCell className="py-2.5">
                        <Money value={it.revenue} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>

          <p className="border-t pt-3 text-center text-[11px] text-muted-foreground">
            اتولّد بواسطة وكيل بتاريخ <span className="num">{arDate(new Date())}</span> — الأرقام بالجنيه المصري من سجل العمليات الموثقة
          </p>
        </CardContent>
      </Card>
    </motion.div>
  )
}
