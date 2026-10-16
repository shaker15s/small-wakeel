'use client'

// وكيل — شاشة «السجل»: يومية العمليات الموثقة بفلاتر للحالة والنوع.

import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Link2, Receipt, ScrollText, User } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api } from '@/lib/api'
import { arDateTime } from '@/lib/format'
import { QUERY_KEYS } from '@/lib/store'
import { useQuery } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import type { OpStatus, OpType } from '@/lib/types'
import {
  EmptyState,
  ErrorState,
  RiskBadge,
  StatusBadge,
  TYPE_AR,
  TypeBadge,
  ViewHeader,
  ViewProps,
  arNum,
} from './shared'

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: 'ALL', label: 'الكل' },
  { value: 'AWAITING_APPROVAL', label: 'مستنية اعتماد' },
  { value: 'SUCCEEDED', label: 'تم' },
  { value: 'FAILED_SAFE', label: 'فشلت' },
  { value: 'CANCELLED', label: 'ملغاة' },
]

const CHIP_TONE: Record<string, string> = {
  ALL: 'bg-primary text-primary-foreground',
  SUCCEEDED: 'bg-wakil-teal/15 text-wakil-teal',
  AWAITING_APPROVAL: 'bg-wakil-amber/15 text-wakil-amber',
  FAILED_SAFE: 'bg-destructive/10 text-destructive',
  CANCELLED: 'bg-muted text-muted-foreground',
}

export default function JournalView({ businessId }: ViewProps) {
  const [status, setStatus] = useState<string>('ALL')
  const [type, setType] = useState<string>('ALL')

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: QUERY_KEYS.operations(businessId),
    queryFn: () => api.operations(businessId),
  })

  const ops = useMemo(() => {
    const list = data ?? []
    const sorted = [...list].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    return sorted.filter((op) => {
      if (status !== 'ALL' && op.status !== status) return false
      if (type !== 'ALL' && op.type !== type) return false
      return true
    })
  }, [data, status, type])

  const counts = useMemo(() => {
    const c: Record<string, number> = { ALL: data?.length ?? 0 }
    for (const op of data ?? []) c[op.status] = (c[op.status] ?? 0) + 1
    return c
  }, [data])

  if (isError) {
    return (
      <div className="mx-auto w-full max-w-5xl px-4 pb-8 pt-2 sm:px-6">
        <ViewHeader title="السجل" />
        <div className="mt-4">
          <ErrorState message={error.message} onRetry={() => refetch()} />
        </div>
      </div>
    )
  }

  const hasAnyOp = (data?.length ?? 0) > 0

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="mx-auto w-full max-w-5xl space-y-4 px-4 pb-8 pt-2 sm:px-6"
    >
      <ViewHeader
        title="السجل"
        subtitle="كل عملية بمرجعها ورقمها وحالتها — سجل موثق مش بنمسح منه حاجة"
      />

      {/* فلاتر */}
      <div className="space-y-3">
        <div
          className="flex gap-2 overflow-x-auto scroll-warm pb-1"
          role="group"
          aria-label="فلتر الحالة"
        >
          {STATUS_FILTERS.map((f) => (
            <Button
              key={f.value}
              variant="secondary"
              size="sm"
              onClick={() => setStatus(f.value)}
              aria-pressed={status === f.value}
              className={cn(
                'h-10 shrink-0 rounded-full font-medium',
                status === f.value && (CHIP_TONE[f.value] ?? 'bg-primary text-primary-foreground'),
                status !== f.value && 'bg-muted text-muted-foreground',
              )}
            >
              {f.label}
              <span className="num text-xs opacity-70 tabular-nums">
                {arNum(counts[f.value] ?? 0)}
              </span>
            </Button>
          ))}
        </div>

        <Select value={type} onValueChange={setType} dir="rtl">
          <SelectTrigger className="h-11 w-full sm:max-w-xs" aria-label="فلتر النوع">
            <SelectValue placeholder="كل الأنواع" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL" className="min-h-10">
              كل الأنواع
            </SelectItem>
            {(Object.keys(TYPE_AR) as OpType[]).map((t) => (
              <SelectItem key={t} value={t} className="min-h-10">
                {TYPE_AR[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* العمليات */}
      {isPending ? (
        <div className="space-y-3" aria-busy="true">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-xl" />
          ))}
        </div>
      ) : !hasAnyOp ? (
        <EmptyState
          icon={ScrollText}
          title="السجل فاضي لسه"
          hint="أول ما تسجّل عملية — بيع أو شرا أو مصروف — هتلاقيها هنا موثقة بمرجعها"
        />
      ) : ops.length === 0 ? (
        <EmptyState
          icon={Receipt}
          title="مفيش عمليات بالفيلتر ده"
          hint="جرّب تشيل الفلاتر أو تختار حالة أو نوع تاني"
        />
      ) : (
        <ol className="card-enter max-h-[560px] space-y-3 overflow-y-auto scroll-warm pe-1">
          {ops.map((op) => (
            <li
              key={op.id}
              className="rounded-xl border bg-card p-4 shadow-sm transition-colors hover:bg-muted/40"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="num font-mono text-xs font-bold tracking-wide text-wakil-navy">
                  {op.ref}
                </span>
                <TypeBadge type={op.type} />
                <StatusBadge status={op.status as OpStatus} />
                <RiskBadge risk={op.risk} />
                {op.reversalOfRef && (
                  <span className="flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                    <Link2 className="size-3" aria-hidden />
                    عكس <span className="num font-mono">{op.reversalOfRef}</span>
                  </span>
                )}
              </div>

              <p className="mt-2.5 text-sm leading-relaxed">{op.summary}</p>

              {op.failReason && (
                <p className="mt-1.5 text-xs text-destructive">سبب الفشل: {op.failReason}</p>
              )}
              {op.reason && (
                <p className="mt-1.5 text-xs text-muted-foreground">السبب الموثق: {op.reason}</p>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <User className="size-3.5" aria-hidden />
                  {op.userName ?? '—'}
                </span>
                <span aria-hidden>·</span>
                <span className="num">{arDateTime(op.createdAt)}</span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </motion.div>
  )
}
