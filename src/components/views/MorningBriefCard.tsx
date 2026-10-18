'use client'
import { useQuery } from '@tanstack/react-query'
import { Boxes, CalendarClock, CheckCircle2, ChevronLeft, Sparkles, TriangleAlert, Wallet } from 'lucide-react'
import { api } from '@/lib/api'
import { QUERY_KEYS, useWakil } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { safeView, type ViewProps } from './shared'

/**
 * «ابدأ يومك» — the agent's opening move.
 *
 * The owner said «مش مساعد كفايه»: the app waited to be asked. This card is the
 * first thing on اليوم — three actions computed from the ledger (no model call,
 * so it is instant and free), prioritizing known promises and personal shortages in manual shops. Each button sends
 * the exact sentence that fixes the item, so «recommendation» and «doing» are
 * one tap apart.
 */
export default function MorningBriefCard({ businessId, userId, onNavigate }: ViewProps) {
  const queuePrompt = useWakil((s) => s.queuePrompt)
  const { data, isError } = useQuery({
    queryKey: QUERY_KEYS.morningBrief(businessId, userId),
    queryFn: () => api.morningBrief(businessId, userId),
    refetchInterval: 60_000,
  })
  // the KPI block already apologies for a dead API — never stack two errors
  if (isError) return null
  // fixed-height skeleton: the brief must not push the KPIs down after load
  if (!data) return <Skeleton className="h-[5.5rem] w-full rounded-xl" />

  const run = (item: (typeof data.items)[number]) => {
    if (item.cta.prompt) queuePrompt(item.cta.prompt)
    onNavigate?.(safeView(item.cta.view) ?? 'chat')
  }

  if (data.items.length === 0) {
    return (
      <div className="flex items-center gap-3 rounded-xl border bg-card px-4 py-3 text-sm shadow-sm">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600">
          <CheckCircle2 className="size-4" aria-hidden />
        </span>
        <p className="min-w-0 text-muted-foreground">{data.headline}</p>
      </div>
    )
  }

  return (
    <section
      className="card-enter card-sheen relative overflow-hidden rounded-xl border bg-card shadow-sm"
      aria-label="ابدأ يومك"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-l from-transparent via-wakil-amber/60 to-transparent"
      />
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <Sparkles className="size-4 shrink-0 text-wakil-amber" aria-hidden />
        <h2 className="text-sm font-semibold">ابدأ يومك</h2>
        <span className="w-full text-xs text-muted-foreground sm:ms-auto sm:w-auto">{data.headline}</span>
      </div>
      <ul className="divide-y">
        {data.items.map((item) => {
          const Icon = item.tone === 'money' ? Wallet : item.tone === 'time' ? CalendarClock : item.tone === 'stock' ? Boxes : TriangleAlert
          const toneClass =
            item.tone === 'money'
              ? 'bg-emerald-500/10 text-emerald-600'
              : item.tone === 'time'
                ? 'bg-wakil-amber/15 text-wakil-amber'
                : item.tone === 'stock' ? 'bg-sky-500/10 text-sky-600' : 'bg-destructive/10 text-destructive'
          return (
            <li key={item.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
              <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-full', toneClass)}>
                <Icon className="size-4" aria-hidden />
              </span>
              <div className="min-w-0 flex-1 basis-40">
                <p className="text-sm font-medium leading-snug">{item.title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{item.why}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="ms-auto min-h-10 shrink-0 gap-1"
                onClick={() => run(item)}
              >
                {item.cta.label}
                <ChevronLeft className="size-3.5" aria-hidden />
              </Button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

