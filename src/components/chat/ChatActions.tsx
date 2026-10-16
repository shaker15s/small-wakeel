'use client'

// وكيل — ChatActions: the deep-link buttons the agent attaches under a reply
// («افتح الإحصائيات» → stats view, «شوف المخزون» → inventory …).
// Server-generated deterministic links — never model-hallucinated.

import { motion } from 'framer-motion'
import {
  BarChart3,
  BookOpen,
  Boxes,
  FileText,
  LayoutGrid,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import type { ViewKey } from '@/lib/store'
import type { ChatActionDTO } from '@/lib/types'

const ICONS: Record<NonNullable<ChatActionDTO['icon']>, LucideIcon> = {
  chart: BarChart3,
  boxes: Boxes,
  users: Users,
  wallet: Wallet,
  today: LayoutGrid,
  journal: BookOpen,
  book: FileText,
}

const FALLBACK_ICON: LucideIcon = LayoutGrid

export function ChatActions({
  actions,
  onNavigate,
}: {
  actions: ChatActionDTO[]
  onNavigate?: (view: ViewKey) => void
}) {
  if (actions.length === 0) return null

  return (
    <div className="flex flex-wrap gap-2">
      {actions.map((a, i) => {
        const Icon = a.icon ? (ICONS[a.icon] ?? FALLBACK_ICON) : FALLBACK_ICON
        const primary = a.tone === 'primary'
        return (
          <motion.button
            key={a.id}
            type="button"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.06, duration: 0.2, ease: 'easeOut' }}
            onClick={() => onNavigate?.(a.view)}
            aria-label={a.label}
            title={a.label}
            className={cn(
              'press inline-flex h-10 items-center gap-1.5 rounded-full px-4 text-xs font-semibold outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
              primary
                ? 'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90'
                : 'border border-border bg-card text-foreground hover:border-wakil-amber/50 hover:bg-accent hover:text-accent-foreground',
            )}
          >
            <Icon className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{a.label}</span>
          </motion.button>
        )
      })}
    </div>
  )
}
