'use client'

// وكيل — Apple-Grade Autonomous Sub-Agent Coordinator Card
// (كارت منسق الوكلاء الفرعيين والمهام المتوازية)
// Displays decomposed tasks, specialized assigned sub-agents, live execution status,
// and progress bars with Apple-style frosted glass aesthetics and micro-interactions.

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  AlertCircle,
  Boxes,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Cpu,
  Search,
  Sparkles,
  Wallet,
  XCircle,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { SubagentRole, SubtaskDTO, SubtaskStatus } from '@/lib/types'

interface SubagentsCoordinatorCardProps {
  tasks: SubtaskDTO[]
  streaming?: boolean
}

const ROLE_META: Record<
  SubagentRole,
  { label: string; icon: typeof Boxes; colorClass: string; badgeClass: string }
> = {
  inventory_sentinel: {
    label: 'حارس المخزون والنواقص',
    icon: Boxes,
    colorClass: 'text-amber-500 dark:text-amber-400',
    badgeClass: 'bg-amber-500/10 text-amber-600 dark:text-amber-300 border-amber-500/20',
  },
  cash_collector: {
    label: 'محصل الخزنة والديون',
    icon: Wallet,
    colorClass: 'text-emerald-500 dark:text-emerald-400',
    badgeClass: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 border-emerald-500/20',
  },
  market_researcher: {
    label: 'باحث الأسعار والسوق',
    icon: Search,
    colorClass: 'text-sky-500 dark:text-sky-400',
    badgeClass: 'bg-sky-500/10 text-sky-600 dark:text-sky-300 border-sky-500/20',
  },
  desktop_specialist: {
    label: 'خبير أنظمة الديسكتوب (CLI-Anything)',
    icon: Cpu,
    colorClass: 'text-purple-500 dark:text-purple-400',
    badgeClass: 'bg-purple-500/10 text-purple-600 dark:text-purple-300 border-purple-500/20',
  },
  growth_advisor: {
    label: 'مستشار النمو والأرباح',
    icon: Sparkles,
    colorClass: 'text-amber-500 dark:text-amber-400',
    badgeClass: 'bg-amber-500/10 text-amber-600 dark:text-amber-300 border-amber-500/20',
  },
  general_worker: {
    label: 'المساعد التنفيذي',
    icon: Cpu,
    colorClass: 'text-muted-foreground',
    badgeClass: 'bg-muted text-muted-foreground border-border',
  },
}

const STATUS_META: Record<
  SubtaskStatus,
  { label: string; icon: typeof CheckCircle2; className: string }
> = {
  completed: {
    label: 'اكتملت بنجاح',
    icon: CheckCircle2,
    className: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/25',
  },
  in_progress: {
    label: 'قيد التنفيذ',
    icon: Clock,
    className: 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/25 animate-pulse',
  },
  pending_approval: {
    label: 'مستنية اعتمادك',
    icon: AlertCircle,
    className: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/25',
  },
  paused: {
    label: 'متوقفة مؤقتاً',
    icon: Clock,
    className: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/25',
  },
  failed: {
    label: 'تعذّر التنفيذ',
    icon: XCircle,
    className: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/25',
  },
}

export function SubagentsCoordinatorCard({ tasks, streaming }: SubagentsCoordinatorCardProps) {
  const [expanded, setExpanded] = useState(true)

  if (!tasks || tasks.length === 0) return null

  const allCompleted = tasks.every((t) => t.status === 'completed')
  const completedCount = tasks.filter((t) => t.status === 'completed').length
  const avgProgress = Math.round(tasks.reduce((s, t) => s + (t.progress || 0), 0) / tasks.length)

  return (
    <Card className="w-full overflow-hidden border border-border/50 bg-gradient-to-b from-card/90 to-card/60 shadow-lg backdrop-blur-xl">
      {/* Header */}
      <div
        onClick={() => setExpanded((prev) => !prev)}
        className="flex cursor-pointer items-center justify-between border-b border-border/40 bg-muted/20 px-4 py-3 transition-colors hover:bg-muted/40"
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[var(--wakil-amber-soft)] text-[var(--wakil-amber)] shadow-sm">
            <Sparkles className="size-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold tracking-tight">منسق الوكلاء الفرعيين والمهام</span>
              <span
                className={cn(
                  'rounded-full border px-2 py-0.5 text-[10px] font-semibold transition-all',
                  allCompleted
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                    : 'border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400 animate-pulse',
                )}
              >
                {allCompleted ? 'اكتملت المهام' : `قيد التشغيل (${completedCount}/${tasks.length})`}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground truncate">
              تفكيك استراتيجي وتنفيذ متوازي عبر متخصصين حقيقيين
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 text-muted-foreground">
          <span className="text-xs font-medium num">{avgProgress}%</span>
          {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </div>
      </div>

      {/* Body with Collapsible Task List */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 350, damping: 28 }}
          >
            <CardContent className="flex flex-col gap-2.5 p-3.5">
              {tasks.map((task, idx) => {
                const role = ROLE_META[task.agentRole] || ROLE_META.general_worker
                const status = STATUS_META[task.status] || STATUS_META.in_progress
                const RoleIcon = role.icon
                const StatusIcon = status.icon
                const isRunning = task.status === 'in_progress'

                return (
                  <motion.div
                    key={task.id || idx}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{
                      opacity: 1,
                      y: 0,
                      scale: isRunning ? [1, 1.006, 1] : 1,
                    }}
                    transition={{
                      delay: idx * 0.05,
                      scale: isRunning ? { duration: 2.8, repeat: Infinity, ease: 'easeInOut' } : undefined,
                    }}
                    className={cn(
                      'group relative flex flex-col gap-2 rounded-xl border p-3 shadow-xs transition-all duration-300',
                      isRunning
                        ? 'border-sky-500/40 bg-sky-500/[0.04] ring-1 ring-sky-500/30 shadow-[0_0_16px_rgba(56,189,248,0.18)]'
                        : task.status === 'completed'
                        ? 'border-emerald-500/30 bg-emerald-500/[0.03] hover:border-emerald-500/50'
                        : 'border-border/40 bg-card/50 hover:border-border/80 hover:bg-card/80',
                      'hover:-translate-y-0.5',
                    )}
                  >
                    {/* Top Row: Sub-Agent Badge + Status Pill */}
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <div
                          className={cn(
                            'relative flex size-5.5 shrink-0 items-center justify-center rounded-md border transition-all',
                            role.badgeClass,
                            isRunning && 'shadow-[0_0_10px_rgba(56,189,248,0.4)]',
                          )}
                        >
                          {isRunning && (
                            <span className="absolute -inset-0.5 rounded-md border border-sky-400/50 animate-ping opacity-35" />
                          )}
                          <RoleIcon className="size-3" />
                        </div>
                        <span className="text-xs font-semibold text-foreground truncate">
                          {task.agentLabel || role.label}
                        </span>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {task.progress != null && isRunning && (
                          <span className="text-[10px] font-bold num text-sky-500/90">{task.progress}%</span>
                        )}
                        <div
                          className={cn(
                            'flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium shrink-0 transition-all',
                            status.className,
                          )}
                        >
                          <StatusIcon className="size-2.5" />
                          <span>{status.label}</span>
                        </div>
                      </div>
                    </div>

                    {/* Task Title & Summary */}
                    <div className="flex flex-col gap-0.5">
                      <p className="text-xs font-medium text-foreground leading-snug">{task.title}</p>
                      {task.summary ? (
                        <p className="text-[11px] text-muted-foreground leading-relaxed">
                          {task.summary}
                        </p>
                      ) : null}
                    </div>

                    {/* Animated Progress Bar with Light-Sweep */}
                    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted/60">
                      <motion.div
                        className={cn(
                          'relative h-full rounded-full transition-all duration-500',
                          task.status === 'completed'
                            ? 'bg-emerald-500'
                            : task.status === 'failed'
                            ? 'bg-rose-500'
                            : 'bg-gradient-to-r from-sky-500 via-sky-400 to-amber-500 ae-sweep-loop',
                        )}
                        initial={{ width: 0 }}
                        animate={{ width: `${task.progress || (task.status === 'completed' ? 100 : 35)}%` }}
                        transition={{ type: 'spring', stiffness: 200, damping: 20 }}
                      />
                    </div>
                  </motion.div>
                )
              })}
            </CardContent>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  )
}
