// وكيل — NotificationBell (R18): the shared alert bell. Extracted from
// AppShell so the chat floating pill and the app header render the exact
// same popover (portal → always on top, instant open).

'use client'

import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Bell, CheckCircle2, ChevronLeft, CircleAlert, Info, TriangleAlert } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { AlertDTO } from '@/lib/types'
import { useWakil, type ViewKey } from '@/lib/store'
import { arNum, safeView } from '@/components/views/shared'
import { cn } from '@/lib/utils'

const LEVEL_ORDER: Record<AlertDTO['level'], number> = { danger: 0, warning: 1, info: 2 }

const NOTIF_META: Record<AlertDTO['level'], { icon: typeof Bell; circle: string; pulse: boolean }> = {
  danger: { icon: CircleAlert, circle: 'bg-destructive/10 text-destructive', pulse: true },
  warning: { icon: TriangleAlert, circle: 'bg-wakil-amber/15 text-wakil-amber', pulse: false },
  info: { icon: Info, circle: 'bg-wakil-navy/10 text-wakil-navy', pulse: false },
}

export function NotificationBell({
  alerts,
  onNavigate,
  className,
}: {
  alerts: AlertDTO[]
  onNavigate: (v: ViewKey) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const { setPluginStudioOpen } = useWakil()
  const alertCount = useMemo(
    () => alerts.filter((a) => a.level === 'danger' || a.level === 'warning').length,
    [alerts],
  )
  const hasDanger = useMemo(() => alerts.some((a) => a.level === 'danger'), [alerts])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn('press-apple icon-seat size-9 text-muted-foreground hover:text-foreground', className)}
          aria-label={
            alertCount > 0 ? `${arNum(alertCount)} تنبيهات محتاجة نظرة` : 'التنبيهات — كل حاجة تمام'
          }
          title="التنبيهات"
        >
          <Bell className="size-4.5" aria-hidden="true" />
          {alertCount > 0 && (
            <span
              className={cn(
                'num absolute -end-0.5 -top-0.5 flex size-4.5 min-w-4.5 items-center justify-center rounded-full bg-destructive text-[9px] font-bold text-white tabular-nums',
                hasDanger && 'pulse-ring',
              )}
            >
              {alertCount > 9 ? '٩+' : arNum(alertCount)}
            </span>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent
        side="bottom"
        align="center"
        sideOffset={10}
        className="glass w-[22rem] max-h-[26rem] overflow-y-auto scroll-warm rounded-2xl p-0"
        dir="rtl"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-border/60 bg-popover/90 px-4 py-3 backdrop-blur-md">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold">التنبيهات</span>
            {alerts.length > 0 && (
              <span className="num rounded-md bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground tabular-nums">
                {arNum(alerts.length)}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              setPluginStudioOpen(true, 'radar')
            }}
            className="rounded-lg bg-primary/10 hover:bg-primary/15 border border-primary/25 px-2.5 py-1 text-[11px] font-semibold text-primary transition-colors"
          >
            رادار المخاطر والفرص
          </button>
        </div>
        <NotificationList
          alerts={alerts}
          onNavigate={(v) => {
            setOpen(false)
            onNavigate(v)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

export function NotificationList({
  alerts,
  onNavigate,
}: {
  alerts: AlertDTO[]
  onNavigate: (v: ViewKey) => void
}) {
  const sorted = useMemo(
    () => [...alerts].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]),
    [alerts],
  )

  if (sorted.length === 0) {
    return (
      <div className="list-enter flex flex-col items-center gap-2 px-6 py-10 text-center">
        <span className="icon-seat size-12 bg-wakil-teal/10 text-wakil-teal">
          <CheckCircle2 className="size-6" aria-hidden />
        </span>
        <p className="text-sm font-semibold">كل حاجة تمام</p>
        <p className="text-xs leading-relaxed text-muted-foreground">هنا هلاقي أي حاجة محتاجة انتباهك</p>
      </div>
    )
  }

  return (
    <ul className="space-y-1 p-2" aria-label="قائمة التنبيهات">
      {sorted.map((a, i) => {
        const meta = NOTIF_META[a.level] ?? NOTIF_META.info
        const Icon = meta.icon
        const view = safeView(a.action?.view)
        return (
          <motion.li
            key={`${a.level}-${a.text}`}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22, delay: Math.min(i, 8) * 0.04, ease: 'easeOut' }}
            className="rounded-xl transition-colors hover:bg-muted/50"
          >
            <div className="flex items-start gap-3 px-3 py-2.5">
              <span
                className={cn(
                  'icon-seat mt-0.5 size-8 shrink-0',
                  meta.circle,
                  meta.pulse && 'pulse-ring',
                )}
              >
                <Icon className="size-4" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs leading-5">{a.text}</p>
                {view && (
                  <button
                    type="button"
                    onClick={() => onNavigate(view)}
                    className="press focus-warm mt-1.5 inline-flex h-7 items-center gap-1 rounded-full border border-border px-2.5 text-[11px] font-medium transition-colors hover:bg-accent"
                  >
                    {a.action?.label}
                    <ChevronLeft className="size-3" aria-hidden />
                  </button>
                )}
              </div>
            </div>
          </motion.li>
        )
      })}
    </ul>
  )
}
