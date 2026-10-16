'use client'

// وكيل — «تفكير وكيل»: collapsible visible-reasoning trace.
// Open by default while any step is active, collapsed when all are done.

import { useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { motion } from 'framer-motion'
import {
  BadgeCheck,
  Brain,
  Check,
  ChevronDown,
  Circle,
  Lightbulb,
  ListChecks,
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
}

export function ThinkingBlock({ steps }: { steps: ThinkingStep[] }) {
  const hasActive = steps.some((s) => s.state === 'active')
  // `userOpen === null` means the user hasn't touched it yet: the block then
  // simply follows the spec — open while any step is active, closed when all
  // are done. Once the user toggles it, their choice wins.
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = userOpen ?? hasActive

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className="w-full"
    >
      <Collapsible open={open} onOpenChange={setUserOpen} className="rounded-lg border bg-muted/50">
        <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start outline-none transition-colors hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/50">
          <Brain className="size-4 shrink-0 text-[var(--wakil-amber)]" aria-hidden="true" />
          <span className="text-sm font-medium text-muted-foreground">تفكير وكيل</span>
          <ChevronDown
            className="ms-auto size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180"
            aria-hidden="true"
          />
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="flex flex-col gap-1 px-3 pb-2.5">
            {steps.map((step, i) => (
              <ThinkingRow key={i} step={step} />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </motion.div>
  )
}

function ThinkingRow({ step }: { step: ThinkingStep }) {
  const Icon = step.icon ? STEP_ICONS[step.icon] : Circle

  return (
    <div className="flex items-start gap-2">
      <Icon
        className={cn(
          'mt-1 size-4 shrink-0',
          step.state === 'active' ? 'text-[var(--wakil-amber)]' : 'text-muted-foreground',
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
              className="thinking-dot size-1.5 shrink-0 rounded-full bg-[var(--wakil-amber)]"
              aria-hidden="true"
            />
          )}
          {step.state === 'done' && (
            <Check className="size-3.5 shrink-0 text-[var(--success)]" aria-hidden="true" />
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
