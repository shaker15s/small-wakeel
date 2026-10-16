'use client'

// وكيل — MessageBubble: one chat turn. User turns sit on the physical right
// (amber bubble, tail corner top-right); assistant turns sit on the physical
// left with the mascot avatar, thinking trace, streamed text, action card,
// result cards and the model badge. (The transcript keeps LTR geometry while
// every text inside stays RTL — hence the explicit dir switches.)

import { motion } from 'framer-motion'
import { Cpu } from 'lucide-react'

import { ActionCard } from './ActionCard'
import { AgentAvatar } from './AgentAvatar'
import { ResultCards } from './ResultCards'
import { ThinkingBlock } from './ThinkingBlock'
import { cn } from '@/lib/utils'
import type { ActionCardDTO, ChatTurn } from '@/lib/types'

/** Wrap every digit-run in a .num span so numbers stay LTR inside RTL text. */
function withNums(text: string): React.ReactNode {
  if (!text) return text
  const parts = text.split(
    /([\u0660-\u0669\u066B\u066C\u06F0-\u06F9][\u0660-\u0669\u066B\u066C\u06F0-\u06F9.,]*|\d[\d.,]*)/g,
  )
  if (parts.length === 1) return text
  return parts.map((p, i) =>
    i % 2 === 1 && p ? <span key={i} className="num">{p}</span> : p,
  )
}

export function MessageBubble({
  turn,
  onApprove,
  onReject,
  busyOpId,
}: {
  turn: ChatTurn
  onApprove?: (card: ActionCardDTO, reason?: string) => void
  onReject?: (card: ActionCardDTO) => void
  busyOpId?: string | null
}) {
  if (turn.role === 'user') {
    return (
      <div dir="ltr" className="flex w-full justify-end">
        <motion.div
          dir="rtl"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-tr-sm bg-[var(--wakil-amber-soft)] px-4 py-2.5 text-[15px] leading-7 text-accent-foreground"
        >
          {withNums(turn.text)}
        </motion.div>
      </div>
    )
  }

  // assistant turn ---------------------------------------------------------
  const { card, cards, thinking, modelLabel } = turn
  const hasText = turn.text.length > 0

  return (
    <div dir="ltr" className="flex w-full items-start justify-start gap-2">
      <AgentAvatar state="idle" size="sm" />

      <div dir="rtl" className="flex min-w-0 flex-1 flex-col gap-2">
        {thinking && thinking.length > 0 ? <ThinkingBlock steps={thinking} /> : null}

        {hasText ? (
          <div
            className={cn(
              'whitespace-pre-wrap break-words text-[15px] leading-7',
              turn.streaming && 'stream-caret',
            )}
          >
            {withNums(turn.text)}
          </div>
        ) : null}

        {card ? (
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
        ) : null}

        {cards && cards.length > 0 ? <ResultCards cards={cards} /> : null}

        {modelLabel ? (
          <div className="flex items-center gap-1 self-start text-[11px] text-muted-foreground">
            <Cpu className="size-3" aria-hidden="true" />
            <span>{modelLabel}</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}
