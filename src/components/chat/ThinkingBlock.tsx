'use client'

// وكيل — «تفكير وكيل»: Luxury Apple-style live Thinking & Reasoning visualization
// Features:
// 1. Frosted Glass pill (`glass-strong`) with Apple micro-interactions.
// 2. Pulsating warm amber aura (`animate-pulse` / framer-motion spring transitions).
// 3. Live real-time thought stages during reasoning («عقلي بيقري طلبك وبيقرر الأدوات…», «بتحقق من السجل الحقيقي…»).
// 4. Staggered live equalizer wave bars.
// 5. Smooth spring-animated collapsible trace for full auditability.

import { useEffect, useMemo, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  BadgeCheck,
  Brain,
  Check,
  ChevronDown,
  Circle,
  Compass,
  Lightbulb,
  ListChecks,
  Loader2,
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

const LIVE_STAGES = [
  'عقلي بيقري طلبك وبيقرر الأدوات…',
  'بتحقق من السجل الحقيقي…',
  'بيفكر في العملية…',
  'بيتحقق من المخزن…',
  'بيحسب الأرقام…',
] as const

export function ThinkingBlock({
  steps,
  streaming = false,
}: {
  steps: ThinkingStep[]
  streaming?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [stageIdx, setStageIdx] = useState(0)

  // Rotate thought stages during live reasoning when waiting on steps
  useEffect(() => {
    if (!streaming) return
    const timer = setInterval(() => {
      setStageIdx((prev) => (prev + 1) % LIVE_STAGES.length)
    }, 2200)
    return () => clearInterval(timer)
  }, [streaming])

  // Total measured time of the traced passes
  const totalMs = steps.reduce((sum, s) => sum + (s.ms ?? 0), 0)

  // Find the active step or fallback to live rotating thought stage
  const activeStep = useMemo(() => {
    return [...steps].reverse().find((s) => s.state === 'active') ?? steps[steps.length - 1] ?? null
  }, [steps])

  const stageText = useMemo(() => {
    if (activeStep?.label) {
      return activeStep.label
    }
    return LIVE_STAGES[stageIdx]
  }, [activeStep, stageIdx])

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 420, damping: 28 }}
      className="relative w-full"
    >
      {/* Pulsating warm amber aura when live thinking */}
      {streaming && (
        <motion.div
          animate={{
            opacity: [0.35, 0.75, 0.35],
            scale: [0.995, 1.008, 0.995],
          }}
          transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
          className="pointer-events-none absolute -inset-0.5 rounded-2xl bg-gradient-to-r from-amber-500/25 via-amber-400/15 to-orange-500/20 blur-sm"
          aria-hidden="true"
        />
      )}

      <div
        className={cn(
          'glass-strong relative z-10 w-full overflow-hidden rounded-2xl border transition-all duration-300',
          streaming
            ? 'border-amber-500/35 shadow-lg shadow-amber-500/10'
            : 'border-border/70 hover:border-amber-500/30 hover:bg-accent/40',
        )}
      >
        <Collapsible open={open} onOpenChange={setOpen} className="w-full">
          <CollapsibleTrigger
            className={cn(
              'group flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-start outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
              open && 'border-b border-border/50 bg-muted/20',
            )}
            aria-label={streaming ? `وكيل يفكر: ${stageText}` : 'عرض تفاصيل تفكير وكيل'}
          >
            {/* Start side (RTL): Glowing Brain + Thought Stage or Finalized Summary */}
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              <div className="relative flex size-6 shrink-0 items-center justify-center">
                {streaming && (
                  <motion.span
                    animate={{ scale: [1, 1.35, 1], opacity: [0.35, 0.85, 0.35] }}
                    transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
                    className="absolute inset-0 rounded-full bg-wakil-amber/35 blur-xs"
                    aria-hidden="true"
                  />
                )}
                <Brain className="relative size-4 shrink-0 text-wakil-amber" aria-hidden="true" />
              </div>

              {streaming ? (
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <AnimatePresence mode="wait">
                    <motion.span
                      key={stageText}
                      initial={{ opacity: 0, y: 3 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -3 }}
                      transition={{ duration: 0.2, ease: 'easeOut' }}
                      className="truncate text-xs font-semibold text-foreground/90 sm:text-sm"
                    >
                      {stageText}
                    </motion.span>
                  </AnimatePresence>

                  {/* Staggered Apple amber equalizer wave bars */}
                  <span className="flex items-center gap-[2px] px-1" aria-hidden="true">
                    {[0, 1, 2].map((i) => (
                      <motion.span
                        key={i}
                        className="h-3.5 w-[2px] rounded-full bg-wakil-amber"
                        animate={{ scaleY: [0.35, 1, 0.35], opacity: [0.55, 1, 0.55] }}
                        transition={{
                          duration: 0.85,
                          repeat: Infinity,
                          delay: i * 0.16,
                          ease: 'easeInOut',
                        }}
                      />
                    ))}
                  </span>
                </div>
              ) : (
                <span className="truncate text-xs font-medium text-muted-foreground sm:text-sm">
                  تفكير وكيل · <span className="num">{steps.length}</span> خطوات
                  {totalMs > 0 ? (
                    <>
                      {' · '}
                      <span className="num">{formatMs(totalMs)}</span>
                    </>
                  ) : null}
                </span>
              )}
            </div>

            {/* End side (RTL): Step count badge + Chevron */}
            <div className="flex shrink-0 items-center gap-2">
              {streaming && steps.length > 0 && (
                <span className="num rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-700 dark:text-amber-300">
                  {steps.length}
                </span>
              )}
              <ChevronDown
                className={cn(
                  'size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:text-foreground',
                  open && 'rotate-180',
                )}
                aria-hidden="true"
              />
            </div>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ type: 'spring', stiffness: 380, damping: 28 }}
              className="flex flex-col gap-1.5 px-3.5 pb-3 pt-2 text-start"
            >
              {steps.length === 0 ? (
                <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin text-wakil-amber" aria-hidden="true" />
                  <span>{stageText}</span>
                </div>
              ) : (
                steps.map((step, i) => (
                  <ThinkingRow key={i} step={step} />
                ))
              )}
            </motion.div>
          </CollapsibleContent>
        </Collapsible>
      </div>
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
    <div className="flex items-start gap-2.5 py-0.5">
      <div className="relative mt-1 flex size-4 shrink-0 items-center justify-center">
        {step.state === 'active' ? (
          <Loader2 className="size-3.5 animate-spin text-wakil-amber" aria-hidden="true" />
        ) : step.state === 'done' ? (
          <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
        ) : (
          <Icon className="size-3.5 text-muted-foreground/60" aria-hidden="true" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              'text-xs leading-5 sm:text-sm',
              step.state === 'active' && 'font-medium text-foreground',
              step.state === 'done' && 'text-muted-foreground',
              step.state === 'pending' && 'text-muted-foreground opacity-60',
            )}
          >
            {step.label}
          </span>
          {step.state === 'active' && (
            <span
              className="thinking-dot size-1.5 shrink-0 rounded-full bg-wakil-amber animate-pulse"
              aria-hidden="true"
            />
          )}
          {typeof step.ms === 'number' && step.ms > 0 && (
            <span className="num ms-chip shrink-0 rounded px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground/80">
              {formatMs(step.ms)}
            </span>
          )}
        </div>
        {step.detail ? (
          <p
            className={cn(
              'text-[11px] leading-4 text-muted-foreground/80 sm:text-xs',
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
