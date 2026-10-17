'use client'

// وكيل — BusinessMenu (R18): the business/user switcher, rebuilt as an
// instant shadcn Popover. The old custom dropdown was (a) slow to appear
// (inline motion + no portal → painted under later DOM) and (b) visually
// «covered» by the scroll container below the header. A Radix portal popover
// is one frame, always on top, focus-managed, and closes on outside-click —
// used by BOTH the chat floating pill and the app header.

import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { motion } from 'framer-motion'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { AgentAvatar } from '@/components/chat/AgentAvatar'
import { getVertical } from '@/lib/verticals'
import type { BusinessLite } from '@/lib/types'
import { cn } from '@/lib/utils'

export function BusinessMenu({
  businesses,
  active,
  onPick,
  compact = false,
}: {
  businesses: BusinessLite[]
  active: BusinessLite
  onPick: (businessId: string, userId: string) => void
  /** compact → hides the description line (for the slim floating pill) */
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          className="press h-10 gap-2 rounded-full ps-1.5 pe-3 font-bold transition-transform active:scale-95"
          aria-expanded={open}
          aria-label={`تبديل المنشأة — الحالي ${active.name}`}
          title="بدّل المنشأة"
        >
          <AgentAvatar state="idle" size="sm" />
          <span className={cn('truncate text-sm', compact ? 'max-w-24' : 'max-w-32')}>{active.name}</span>
          <ChevronDown
            className={cn('size-3.5 text-muted-foreground transition-transform duration-200', open && 'rotate-180')}
            aria-hidden="true"
          />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={10}
        className="glass w-[19rem] max-h-[65vh] overflow-y-auto scroll-warm rounded-2xl p-2"
        dir="rtl"
      >
        <p className="px-2.5 pb-1.5 pt-1 text-[11px] font-semibold text-muted-foreground">منشآتك</p>
        {businesses.map((b, i) => {
          const v = getVertical(b.type)
          const isActive = b.id === active.id
          return (
            <motion.div
              key={b.id}
              initial={{ opacity: 0, x: 6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: Math.min(i, 6) * 0.035, duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className={cn(
                'mb-1 rounded-xl transition-colors',
                isActive ? 'bg-accent/70' : 'hover:bg-accent/50',
              )}
            >
              <button
                onClick={() => {
                  onPick(b.id, b.users[0].id)
                  setOpen(false)
                }}
                className="focus-warm flex w-full items-center gap-2.5 px-2.5 py-2 text-start"
              >
                <AgentAvatar state="idle" size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{b.name}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {v.shortLabel}
                    {!compact ? ` · ${v.description}` : ''}
                  </span>
                </span>
                {isActive && <Check className="size-4 shrink-0 text-wakil-amber" aria-hidden />}
              </button>
              <div className="flex flex-wrap gap-1 px-3 pb-2">
                {b.users.map((u) => (
                  <button
                    key={u.id}
                    onClick={() => {
                      onPick(b.id, u.id)
                      setOpen(false)
                    }}
                    className="press focus-warm rounded-full border border-border bg-card/70 px-2.5 py-1 text-[10px] hover:bg-accent"
                  >
                    {u.name} — {u.role === 'owner' ? 'صاحب المنشأة' : u.title ?? u.role}
                  </button>
                ))}
              </div>
            </motion.div>
          )
        })}
        <div className="mt-1 border-t border-border/60 pt-1.5">
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              import('@/lib/store').then(({ useWakil }) => useWakil.getState().setBusinessBuilderOpen(true))
            }}
            className="press focus-warm flex w-full items-center justify-between rounded-xl px-3 py-2 text-xs font-semibold text-primary hover:bg-primary/10"
          >
            <span>+ إنشاء نشاط تجاري جديد...</span>
            <span className="text-[10px] text-muted-foreground">أي مجال</span>
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
