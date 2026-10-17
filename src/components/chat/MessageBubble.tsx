'use client'

// وكيل — MessageBubble: one chat turn in ChatGPT/Claude geometry, pure RTL.
// User turns hug the physical LEFT edge (the natural RTL mirror — own messages
// on the left like WhatsApp-ARABIC); assistant turns start from the physical
// RIGHT with the mascot avatar, content flowing leftward.
//
// Live + finalized turns share this exact DOM structure (no flicker on
// finalize). While streaming: only the caret-text + a compact step line —
// card/cards/actions render AFTER the stream completes (ChatGPT order: text
// first, visuals below, staggered reveal).

import { useState } from 'react'
import { motion, type Transition } from 'framer-motion'
import { AlertCircle, BadgeCheck, Check, Compass, Copy, Cpu, Loader2, NotebookPen, RotateCcw, TriangleAlert } from 'lucide-react'

import { ActionCard } from './ActionCard'
import { AgentAvatar, type AgentState } from './AgentAvatar'
import { ChatActions } from './ChatActions'
import { ResultCards, SourcesCard } from './ResultCards'
import { SubagentsCoordinatorCard } from './SubagentsCoordinatorCard'
import { ThinkingBlock } from './ThinkingBlock'
import { ThinkingIndicator } from './ThinkingIndicator'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ChatTurnWithMeta } from '@/lib/api'
import type { ViewKey } from '@/lib/store'
import type { ActionCardDTO, ThinkingStep } from '@/lib/types'

const arNum = (n: number): string => new Intl.NumberFormat('ar-EG').format(n)

/** Wrap every digit-run in a .num span so numbers stay LTR inside RTL text.
 *  Bracketed runs like the [١] [٢] research citations match as a WHOLE
 *  (brackets included) — otherwise the RTL bidi mirroring would flip them
 *  into ]١[ on screen. */
function withNums(text: string): React.ReactNode {
  if (!text) return text
  const parts = text.split(
    /(\[[\u0660-\u0669\u066B\u066C\u06F0-\u06F9\d.,]+\]|[\u0660-\u0669\u066B\u066C\u06F0-\u06F9][\u0660-\u0669\u066B\u066C\u06F0-\u06F9.,]*|\d[\d.,]*)/g,
  )
  if (parts.length === 1) return text
  return parts.map((p, i) =>
    i % 2 === 1 && p ? <span key={i} className="num">{p}</span> : p,
  )
}

/** Research reports arrive with lightweight markdown headers (## الخلاصة …).
 *  Render those as styled section headers instead of raw hashes; everything
 *  else flows through withNums as usual. */
function renderRichText(text: string): React.ReactNode {
  if (!text || !/^#{1,3}\s/m.test(text)) return withNums(text)
  const lines = text.split('\n')
  return lines.map((line, i) => {
    const header = line.match(/^(#{1,3})\s+(.*)$/)
    if (header) {
      const depth = header[1].length
      return (
        <span
          key={i}
          className={
            depth === 1
              ? 'mt-2 mb-1 inline-block text-base font-bold text-[var(--wakil-navy)] dark:text-[var(--wakil-amber)]'
              : 'mt-1.5 mb-0.5 inline-block text-sm font-bold'
          }
        >
          {withNums(header[2])}
        </span>
      )
    }
    return (
      <span key={i}>
        {withNums(line)}
        {i < lines.length - 1 ? '\n' : ''}
      </span>
    )
  })
}

/** HH:mm in Arabic (Arabic-Indic digits), kept LTR via .num by the caller. */
function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

/** The latest non-pending thinking step (drives the compact live step line). */
function latestStep(steps: ThinkingStep[] | null | undefined): ThinkingStep | null {
  if (!steps || steps.length === 0) return null
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].state !== 'pending') return steps[i]
  }
  return null
}

export function MessageBubble({
  turn,
  onApprove,
  onReject,
  busyOpId,
  onNavigate,
  onRetry,
  reveal = false,
  error = false,
}: {
  turn: ChatTurnWithMeta
  onApprove?: (card: ActionCardDTO, reason?: string) => void
  onReject?: (card: ActionCardDTO) => void
  busyOpId?: string | null
  /** deep-link navigation for ChatAction buttons */
  onNavigate?: (view: ViewKey) => void
  /** retry the previous user text after a failed turn */
  onRetry?: () => void
  /** true only while the just-finalized turn reveals its visuals (stagger) */
  reveal?: boolean
  /** failed turn → error styling + retry button */
  error?: boolean
}) {
  // ---- user turn: bubble hugs the physical LEFT (justify-end in RTL) -------
  if (turn.role === 'user') {
    const optimistic = turn.id.startsWith('local-')
    return (
      <div className="settle-in flex w-full justify-end">
        <motion.div
          initial={optimistic ? { opacity: 0, y: 24, scale: 0.92 } : false}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: 'spring', stiffness: 440, damping: 24 }}
          className="max-w-[85%] whitespace-pre-wrap break-words rounded-[1.25rem] rounded-tl-md bg-[var(--wakil-amber-soft)] px-4 py-2.5 text-[15px] leading-7 text-accent-foreground shadow-sm"
        >
          {withNums(turn.text)}
        </motion.div>
      </div>
    )
  }

  // ---- assistant turn ------------------------------------------------------
  const { card, cards, actions, thinking, modelLabel, plan } = turn
  const streaming = turn.streaming === true
  const hasText = turn.text.length > 0
  const step = latestStep(thinking)

  // Dynamically derive the rich AgentState from the active thinking step & streaming state
  const avatarState: AgentState = (() => {
    if (error) return 'error'
    if (!streaming) return 'idle'
    if (hasText) return 'replying'
    if (step) {
      const lbl = `${step.label} ${step.detail}`
      if (/أداة|بلاجن|نظام|قدرة|ينفذ|تفعيل/.test(lbl) || step.icon === 'execute') {
        return 'analyzing_tools'
      }
      if (/أرقام|حساب|ربح|خزنة|تكلفة|يتحقق/.test(lbl) || step.icon === 'verify') {
        return 'calculating'
      }
      if (/بحث|ويب|سجل|سوق/.test(lbl) || step.icon === 'search' || step.icon === 'research') {
        return 'searching'
      }
    }
    return 'thinking'
  })()
  const canCopy = !streaming && !error && hasText

  // ---- R15: deep-research metadata + self-verification (land on done) ------
  const research = turn.research ?? null
  const verified = turn.verified ?? null
  const showVerified = !streaming && !!verified && verified.status !== 'skipped'
  const corrected = verified?.status === 'corrected'
  const checksCount = verified?.checks.length ?? 0
  const verifyTitle =
    verified?.note?.trim() ||
    (verified && checksCount > 0
      ? verified.checks.map((c) => `${c.claim}: ${c.expected} → ${c.actual}`).join(' · ')
      : undefined)
  const researchTitle = research
    ? `خطة بحث من ${arNum(research.stepsCount)} خطوة مع ${arNum(research.sources.length)} مصدر`
    : undefined

  // staggered reveal order for the buffered visuals (ChatGPT order: text
  // first, then verify-chip → card → cards → sources → actions, 80ms apart)
  const hasVerifyChip = showVerified
  const hasCard = !!card
  const hasCards = !!cards && cards.length > 0
  // sources render here ONLY when the cards stream didn't already carry one
  const hasSources =
    !streaming && !!research && research.sources.length > 0 && !cards?.some((c) => c.kind === 'sources')
  const hasActions = !!actions && actions.length > 0
  let ordinal = 0
  const verifyDelay = hasVerifyChip ? ordinal++ * 0.08 : 0
  const cardDelay = hasCard ? ordinal++ * 0.08 : 0
  const cardsDelay = hasCards ? ordinal++ * 0.08 : 0
  const sourcesDelay = hasSources ? ordinal++ * 0.08 : 0
  const actionsDelay = hasActions ? ordinal++ * 0.08 : 0

  const revealProps = (delay: number) => {
    const transition: Transition = reveal
      ? { type: 'spring', stiffness: 380, damping: 26, delay }
      : { duration: 0 }
    return {
      initial: reveal ? { opacity: 0, y: 16, scale: 0.97 } : false,
      animate: { opacity: 1, y: 0, scale: 1 },
      transition,
    }
  }

  return (
    <div className="settle-in flex w-full items-start justify-start gap-2.5">
      <AgentAvatar state={avatarState} size="sm" />

      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        {/* name row: وكيل · time · … · model chip */}
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold">وكيل</span>
          <span className="num text-[10px] text-muted-foreground">{formatTime(turn.createdAt)}</span>
          <span className="flex-1" />
          {!streaming && research ? (
            <span
              className="flex shrink-0 items-center gap-1 rounded-full border border-[var(--wakil-amber)]/40 bg-[var(--wakil-amber)]/5 px-2 py-0.5 text-[10px] font-medium text-[var(--wakil-amber)]"
              title={researchTitle}
            >
              <Compass className="size-3 shrink-0" aria-hidden="true" />
              وضع البحث
            </span>
          ) : null}
          {!streaming && modelLabel ? (
            <span
              className="flex min-w-0 items-center gap-1 rounded-full border border-border/80 px-2 py-0.5 text-[10px] text-muted-foreground"
              title={modelLabel}
            >
              <Cpu className="size-2.5 shrink-0 text-wakil-amber" aria-hidden="true" />
              <span className="max-w-36 truncate">{modelLabel}</span>
            </span>
          ) : null}
        </div>

        {/* pre-text phase: the varied thinking animation when waiting for first steps */}
        {streaming && !hasText && (!thinking || thinking.length === 0) ? (
          <ThinkingIndicator steps={thinking} waiting={true} showAvatar={false} />
        ) : null}

        {/* Live Apple-style Thinking & Reasoning pill while streaming or finalized trace */}
        {thinking && thinking.length > 0 ? (
          <ThinkingBlock steps={thinking} streaming={streaming} />
        ) : null}

        {/* compact current-step line while text streams if no thinking steps block */}
        {streaming && hasText && (!thinking || thinking.length === 0) ? (
          <div
            className={cn(
              'flex items-center gap-1.5 text-[11px] text-muted-foreground',
              (step?.icon === 'research' || step?.icon === 'note') &&
                'border-s-2 border-[var(--wakil-amber)]/40 ps-1.5',
            )}
          >
            {step ? (
              <>
                {step.state === 'done' ? (
                  <Check className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                ) : step.icon === 'research' ? (
                  <Compass className="size-3.5 shrink-0 animate-pulse text-[var(--wakil-amber)]" aria-hidden="true" />
                ) : step.icon === 'note' ? (
                  <NotebookPen className="size-3.5 shrink-0 animate-pulse text-[var(--wakil-amber)]" aria-hidden="true" />
                ) : (
                  <Loader2 className="size-3 shrink-0 animate-spin text-wakil-amber" aria-hidden="true" />
                )}
                <span className="truncate">{step.label}</span>
              </>
            ) : (
              <>
                <Loader2 className="size-3 shrink-0 animate-spin text-wakil-amber" aria-hidden="true" />
                <span>بجهّز الرد…</span>
              </>
            )}
          </div>
        ) : null}

        {/* the streamed reply text (with caret while live) */}
        {hasText ? (
          <div
            className={cn(
              'group relative whitespace-pre-wrap break-words text-[15px] leading-7',
              streaming && 'stream-caret',
              canCopy && 'sm:pe-9',
            )}
          >
            {renderRichText(turn.text)}
            {canCopy ? <CopyButton text={turn.text} /> : null}
          </div>
        ) : null}

        {/* R15 self-verification chip — right under the reply text */}
        {hasVerifyChip ? (
          <motion.span
            {...revealProps(verifyDelay)}
            className={cn(
              'inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium',
              corrected
                ? 'bg-[var(--wakil-amber)]/12 text-[var(--wakil-amber)]'
                : 'bg-[var(--wakil-teal)]/10 text-[var(--wakil-teal)]',
            )}
            title={verifyTitle}
          >
            {corrected ? (
              <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <BadgeCheck className="size-3.5 shrink-0" aria-hidden="true" />
            )}
            {corrected ? (
              <span>اتصححت أرقام في الرد</span>
            ) : checksCount > 0 ? (
              <span>
                اتأكدت الأرقام (<span className="num">{arNum(checksCount)}</span> فحص)
              </span>
            ) : (
              <span>اتأكد الرد من المصادر</span>
            )}
          </motion.span>
        ) : null}

        {/* failed turn → error state + retry */}
        {error ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">{hasText ? 'الرد اتقطع في النص' : 'حصل خطأ في الرد'}</span>
            {onRetry ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="press h-8 shrink-0 gap-1.5 rounded-full border-destructive/40 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={onRetry}
              >
                <RotateCcw className="size-3.5" aria-hidden="true" />
                جرّب تاني
              </Button>
            ) : null}
          </div>
        ) : null}

        {/* visuals — revealed BELOW the text only after the stream finishes */}
        {card ? (
          <motion.div {...revealProps(cardDelay)} className="w-full">
            <ActionCard
              card={card}
              busy={busyOpId != null && busyOpId === card.opId}
              outcome={turn.outcome}
              onApprove={
                onApprove
                  ? (reason?: string) => onApprove(card, reason)
                  : undefined
              }
              onReject={onReject ? () => onReject(card) : undefined}
            />
          </motion.div>
        ) : null}

        {turn.tasks && turn.tasks.length > 0 ? (
          <motion.div {...revealProps(cardDelay)} className="w-full">
            <SubagentsCoordinatorCard tasks={turn.tasks} streaming={streaming} />
          </motion.div>
        ) : null}

        {plan && plan.length > 0 && !streaming ? (
          <PlanStrip steps={plan} delay={ordinal++ * 0.06} />
        ) : null}

        {cards && cards.length > 0 ? (
          <motion.div {...revealProps(cardsDelay)} className="w-full">
            <ResultCards cards={cards} />
          </motion.div>
        ) : null}

        {/* deep-research cited sources — only when no sources card already came
            in the cards stream (back-compat for turns persisted without one) */}
        {hasSources && research ? (
          <motion.div {...revealProps(sourcesDelay)} className="w-full">
            <SourcesCard card={{ kind: 'sources', title: 'المصادر', sources: research.sources }} />
          </motion.div>
        ) : null}

        {actions && actions.length > 0 ? (
          <motion.div {...revealProps(actionsDelay)} className="w-full">
            <ChatActions actions={actions} onNavigate={onNavigate} />
          </motion.div>
        ) : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hover copy button (desktop) — Copy → emerald Check for 1.5s
// ---------------------------------------------------------------------------
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const onCopy = async () => {
    if (copied) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard unavailable (permissions) — silent no-op
    }
  }

  return (
    <button
      type="button"
      onClick={() => void onCopy()}
      aria-label={copied ? 'اتنسخ' : 'انسخ الرد'}
      className={cn(
        'absolute end-0 top-0 z-10 hidden size-7 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm transition-all sm:flex',
        'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-foreground',
        copied && 'border-emerald-300 text-emerald-600 dark:border-emerald-500/40 dark:text-emerald-400',
      )}
    >
      {copied ? (
        <motion.span
          key="check"
          initial={{ scale: 0.5, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 400, damping: 22 }}
          className="flex"
        >
          <Check className="size-3.5" aria-hidden="true" />
        </motion.span>
      ) : (
        <Copy className="size-3.5" aria-hidden="true" />
      )}
    </button>
  )
}

/**
 * «الخطّة» — the steps the agent is running when it decides to work in one shot.
 *
 * Shown as a compact numbered strip (After-Effects style stagger: each step
 * rises 40ms after the previous). It exists because a multi-step answer used to
 * look like a long silence: the owner now sees the machine working.
 */
function PlanStrip({ steps, delay = 0 }: { steps: string[]; delay?: number }) {
  return (
    <div className="enter-rise ms-12 flex flex-col gap-1.5" style={{ animationDelay: `${delay}s` }}>
      <span className="text-[11px] font-semibold text-muted-foreground">
        خطّة الشغل · <span className="num">{steps.length}</span> خطوات
      </span>
      <ol className="flex flex-wrap items-center gap-1.5">
        {steps.map((label, i) => (
          <li
            key={`${label}-${i}`}
            style={{ ['--stagger' as string]: i }}
            className="ae-riser flex items-center gap-1.5 rounded-full border border-border/70 bg-card/70 px-2.5 py-1 text-[11px]"
          >
            <span className="num flex size-4 items-center justify-center rounded-full bg-accent text-[9px] font-bold text-accent-foreground">
              {i + 1}
            </span>
            {label}
            <Check className="size-3 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
          </li>
        ))}
      </ol>
    </div>
  )
}
