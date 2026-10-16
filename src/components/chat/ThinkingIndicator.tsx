'use client'

// وكيل — ThinkingIndicator: the live «pre-reply» moment (ChatGPT/Claude style).
// THREE animation modes that rotate every ~2.8s (bounce → fade → wave) so the
// wait never feels static, plus a rotating Egyptian status line every ~2.2s and
// the latest live thinking step with its spinner→check lifecycle.
// Pure framer-motion (no globals.css dependency — that file is shared).

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Check, Loader2 } from 'lucide-react'

import { AgentAvatar } from './AgentAvatar'
import type { ThinkingStep } from '@/lib/types'

const MODES = ['bounce', 'fade', 'wave'] as const
type Mode = (typeof MODES)[number]

const STATUSES = [
  'وكيل بيفكر…',
  'بحلل طلبك…',
  'بدوّر في سجلك…',
  'بحسب الأرقام…',
  'بجهّز الرد…',
]

const MODE_MS = 2800
const STATUS_MS = 2200

export function ThinkingIndicator({
  steps,
  waiting = false,
  showAvatar = true,
}: {
  steps?: ThinkingStep[] | null
  /** true until the first `thinking` SSE event lands (nothing to show yet) */
  waiting?: boolean
  /** false when the parent bubble already renders the avatar */
  showAvatar?: boolean
}) {
  // randomize per turn (this mounts fresh for every live turn — client only)
  const [modeIdx, setModeIdx] = useState(() => Math.floor(Math.random() * MODES.length))
  const [statusIdx, setStatusIdx] = useState(() => Math.floor(Math.random() * STATUSES.length))

  useEffect(() => {
    const t = window.setInterval(() => setModeIdx((i) => (i + 1) % MODES.length), MODE_MS)
    return () => window.clearInterval(t)
  }, [])

  useEffect(() => {
    const t = window.setInterval(() => setStatusIdx((i) => (i + 1) % STATUSES.length), STATUS_MS)
    return () => window.clearInterval(t)
  }, [])

  const mode = MODES[modeIdx]
  const latest = [...(steps ?? [])].reverse().find((s) => s.state !== 'pending') ?? null
  const shownStep = latest ?? (waiting && (steps?.length ?? 0) === 0
    ? { label: 'بفهم طلبك', detail: '', state: 'active' as const }
    : null)

  return (
    <div className="flex items-center gap-3" role="status" aria-label="وكيل بيفكر">
      {showAvatar && <AgentAvatar state="thinking" size="sm" />}

      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex items-center gap-3">
          {/* the animation of the moment — swaps with a soft fade */}
          <motion.span
            key={mode}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.22 }}
            className="flex h-4 items-center"
            aria-hidden="true"
          >
            {mode === 'bounce' && <BounceDots />}
            {mode === 'fade' && <FadeDots />}
            {mode === 'wave' && <WaveBars />}
          </motion.span>

          {/* rotating status text — swaps with a tiny fade */}
          <motion.span
            key={statusIdx}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.2 }}
            className="truncate text-sm text-muted-foreground"
          >
            {STATUSES[statusIdx]}
          </motion.span>
        </div>

        {/* latest live step: spinner while active, emerald check when done */}
        {shownStep && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground/80">
            {shownStep.state === 'done' ? (
              <Check className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
            ) : (
              <Loader2 className="size-3 shrink-0 animate-spin text-wakil-amber" aria-hidden="true" />
            )}
            <span className="truncate">{shownStep.label}</span>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Mode «bounce» — 3 dots, iMessage-style staggered hop
// ---------------------------------------------------------------------------
function BounceDots() {
  return (
    <span className="flex items-center gap-1">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="size-2 rounded-full bg-wakil-amber"
          animate={{ y: [0, -5, 0], opacity: [0.7, 1, 0.7] }}
          transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.14, ease: 'easeInOut' }}
        />
      ))}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Mode «fade» — dots appear/disappear in a scale+opacity cycle
// ---------------------------------------------------------------------------
function FadeDots() {
  return (
    <span className="flex items-center gap-1">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="size-2 rounded-full bg-wakil-amber"
          animate={{ scale: [0.35, 1, 0.35], opacity: [0.25, 1, 0.25] }}
          transition={{ duration: 1.3, repeat: Infinity, delay: i * 0.22, ease: 'easeInOut' }}
        />
      ))}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Mode «wave» — 5 thin equalizer bars, staggered scaleY
// ---------------------------------------------------------------------------
function WaveBars() {
  return (
    <span className="flex items-center gap-[3px]">
      {[0, 1, 2, 3, 4].map((i) => (
        <motion.span
          key={i}
          className="h-4 w-1 rounded-full bg-wakil-amber/80"
          animate={{ scaleY: [0.35, 1, 0.35] }}
          transition={{ duration: 0.85, repeat: Infinity, delay: i * 0.11, ease: 'easeInOut' }}
        />
      ))}
    </span>
  )
}
