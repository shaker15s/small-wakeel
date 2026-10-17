'use client'

// وكيل — «تفكير وكيل»: collapsible visible-reasoning trace for FINALIZED
// turns. Collapsed by default (like ChatGPT's «Thought for Xs» row) — the
// live/pre-text phase is handled by ThinkingIndicator instead. Pure component:
// open state lives here, no setState-in-effect.

import { useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { motion } from 'framer-motion'
import {
  BadgeCheck,
  Brain,
  Check,
  ChevronDown,
  Circle,
  Compass,
  Lightbulb,
  ListChecks,
  NotebookPen,
  Search,
  Zap,
} from 'lucide-react'

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import type { ThinkingStep } from '@/lib/types'

const STEP_ICONS: Record<NonNullable<ThinkingStep['icon']>, LucideIcon> = {
  understand: Lightbulb,
  search: Search,
  verify: BadgeCheck,
  plan: ListChecks,
  execute: Zap,
  research: Compass,
  note: NotebookPen,
}

export function ThinkingBlock({ steps }: { steps: ThinkingStep[] }) {
  const [open, setOpen] = useState(false)
  // Total measured time of the traced passes — the honest «سرعة» number the
  // owner can compare between two questions (ms, not vibes).
  const totalMs = steps.reduce((sum, s) => sum + (s.ms ?? 0), 0)

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className="w-full"
    >
      <Collapsible open={open} onOpenChange={setOpen} className="w-full">
        <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-lg border border-border/70 bg-muted/40 px-3 py-2 text-start outline-none transition-colors hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:rounded-b-none data-[state=open]:border-b-transparent">
          <Brain className="size-4 shrink-0 text-wakil-amber" aria-hidden="true" />
          <span className="text-sm font-medium text-muted-foreground">
            تفكير وكيل · <span className="num">{steps.length}</span> خطوات
            {totalMs > 0 ? (
              <>
                {' · '}
                <span className="num">{formatMs(totalMs)}</span>
              </>
            ) : null}
          </span>
          <ChevronDown
            className="ms-auto size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180"
            aria-hidden="true"
          />
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="flex flex-col gap-1 rounded-b-lg border border-border/70 bg-muted/30 px-3 pb-2.5 pt-2">
            {steps.map((step, i) => (
              <ThinkingRow key={i} step={step} />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </motion.div>
  )
}

/** «٤٢٠ مللي» / «١٫٦ث» — Arabic-friendly duration. */
export function formatMs(ms: number): string {
  const ar = (n: string) => n.replace(/[0-9]/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)])
  if (ms < 1000) return `${ar(String(Math.round(ms)))} مللي`
  return `${ar((ms / 1000).toFixed(ms < 10_000 ? 1 : 0))}ث`
}

function ThinkingRow({ step }: { step: ThinkingStep }) {
  const Icon = step.icon ? STEP_ICONS[step.icon] : Circle

  return (
    <div className="flex items-start gap-2">
      <Icon
        className={cn(
          'mt-1 size-4 shrink-0',
          step.state === 'active' ? 'text-wakil-amber' : 'text-muted-foreground',
        )}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              'text-sm leading-6',
              step.state === 'active' && 'font-medium text-foreground',
              step.state === 'done' && 'text-muted-foreground',
              step.state === 'pending' && 'text-muted-foreground opacity-60',
            )}
          >
            {step.label}
          </span>
          {step.state === 'active' && (
            <span
              className="thinking-dot size-1.5 shrink-0 rounded-full bg-wakil-amber"
              aria-hidden="true"
            />
          )}
          {step.state === 'done' && (
            <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
          )}
          {typeof step.ms === 'number' && step.ms > 0 && (
            <span className="num ms-chip shrink-0 rounded px-1 py-0.5 text-[10px] tabular-nums text-muted-foreground/80">
              {formatMs(step.ms)}
            </span>
          )}
        </div>
        {step.detail ? (
          <p
            className={cn(
              'text-xs leading-5 text-muted-foreground',
              step.state === 'pending' && 'opacity-60',
            )}
          >
            {step.detail}
          </p>
        ) : null}
      </div>
    </div>
  )
}
