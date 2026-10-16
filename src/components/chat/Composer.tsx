'use client'

// وكيل — Composer: ChatGPT-style unified input pill. Above the input runs ONE
// horizontally-scrollable row of instant-fire chips: the user's OWN quick
// commands first («أدواتك السريعة» — dashed, primary-tinted, always visible),
// then the top dynamic suggestions (compact, hidden while streaming). Every
// chip SENDS its prompt on tap — no filling the box.
// R15: a «بحث عميق» toggle (Compass) sits next to the send button — forces the
// plan-and-execute research pipeline for the NEXT message, then resets.

import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowUp, ArrowUpToLine, Compass, Loader2, Mic } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ToolIcon } from './QuickCommandsManager'
import type { QuickCommandDTO, SuggestionDTO } from '@/lib/types'
import { cn } from '@/lib/utils'

const MAX_HEIGHT = 128 // 4 rows max (max-h-32)

const DEEP_RESEARCH_LABEL = 'بحث عميق — وكيل يدور ويدقق قبل ما يرد'

export function Composer({
  commands,
  suggestions,
  onSend,
  onCommandTap,
  onSuggestionTap,
  disabled,
  queuedCount = 0,
  onVoiceClick,
}: {
  /** the user's own tools — always visible above the input */
  commands: QuickCommandDTO[]
  /** dynamic suggestions (top 3-4 are rendered) */
  suggestions: SuggestionDTO[]
  onSend: (text: string, opts?: { deepResearch?: boolean }) => void
  onCommandTap: (command: QuickCommandDTO) => void
  onSuggestionTap: (suggestion: SuggestionDTO) => void
  disabled?: boolean
  /** messages queued behind the live turn — shown as a waiting pill */
  queuedCount?: number
  /** voice input hook — optional; the mic stays a disabled teaser without it */
  onVoiceClick?: () => void
}) {
  const [value, setValue] = useState('')
  /** «بحث عميق» — lives per-message: ON until the next send, then resets */
  const [deepResearch, setDeepResearch] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const autosize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [])

  useEffect(() => {
    autosize()
  }, [value, autosize])

  const send = useCallback(() => {
    const text = value.trim()
    // STORM-SAFE (R15-5 CEO fix): a live turn NO LONGER blocks submission —
    // the parent ChatView QUEUES mid-stream sends and flushes them on done.
    // Blocking here was the silent-loss bug (text kept getting overwritten by
    // the next fill while the message never left the composer).
    if (!text) return
    // the flag rides WITH this message only — then resets for the next one
    onSend(text, { deepResearch })
    setValue('')
    setDeepResearch(false)
    textareaRef.current?.focus()
  }, [value, onSend, deepResearch])

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  const canSend = value.trim().length > 0

  const topSuggestions = suggestions.slice(0, 4)
  // the suggestion row hides while the agent is replying; the user's own
  // tools stay visible at all times
  const showSuggestionRow = !disabled && topSuggestions.length > 0

  return (
    <div className="flex w-full flex-col gap-2">
      {/* instant chips: user tools first, then top dynamic suggestions */}
      {(commands.length > 0 || showSuggestionRow) && (
        <div
          className="scroll-warm flex gap-1.5 overflow-x-auto pb-1"
          role="group"
          aria-label="أوامر واقتراحات سريعة"
        >
          {commands.map((cmd) => (
            <button
              key={cmd.id}
              type="button"
              className="press h-8 shrink-0 rounded-full border border-dashed border-primary/60 bg-primary/5 px-3.5 text-xs transition-all hover:-translate-y-0.5 hover:border-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              onClick={() => onCommandTap(cmd)}
              aria-label={`شغّل أداة ${cmd.label}`}
              title={cmd.prompt}
            >
              <span className="flex items-center gap-1.5">
                <ToolIcon icon={cmd.icon} className="size-3.5 text-primary" />
                <span className="max-w-36 truncate">{cmd.label}</span>
              </span>
            </button>
          ))}
          {showSuggestionRow &&
            topSuggestions.map((s) => (
              <button
                key={s.id}
                type="button"
                className={cn(
                  'press h-8 shrink-0 rounded-full border px-3.5 text-xs transition-all hover:-translate-y-0.5 hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  s.tone === 'primary'
                    ? 'border-transparent bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground'
                    : 'border-border bg-card',
                )}
                onClick={() => onSuggestionTap(s)}
                aria-label={s.reasonLabel ? `${s.label} — ${s.reasonLabel}` : s.label}
                title={s.prompt}
              >
                <span className="flex items-center gap-1.5">
                  <ToolIcon icon={s.icon} className="size-3.5 text-wakil-amber" />
                  <span className="max-w-36 truncate">{s.label}</span>
                </span>
              </button>
            ))}
        </div>
      )}

      {/* the unified input pill */}
      <form
        className="flex flex-col rounded-3xl border border-border bg-card shadow-xs transition-[box-shadow,border-color] focus-within:border-wakil-amber/50 focus-within:ring-2 focus-within:ring-wakil-amber/40"
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
      >
        <Textarea
          ref={textareaRef}
          value={value}
          rows={1}
          dir="rtl"
          placeholder="رسالة إلى وكيل…"
          aria-label="رسالة إلى وكيل"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          className="min-h-[52px] max-h-32 flex-1 resize-none rounded-none rounded-t-3xl border-0 bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-6 shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
        />

        <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-1">
          <Button
            type="button"
            variant="ghost"
            className="size-9 shrink-0 rounded-full text-muted-foreground"
            aria-label="تسجيل صوتي لرسالتك"
            title={onVoiceClick ? undefined : 'الصوت جاي قريب'}
            disabled={!onVoiceClick}
            onClick={() => onVoiceClick?.()}
          >
            <Mic className="size-4.5" aria-hidden="true" />
          </Button>

          <div className="flex items-center gap-1.5">
            {/* «بحث عميق» toggle — amber when armed, resets after each send */}
            <Button
              type="button"
              variant="ghost"
              className={cn(
                'press size-11 shrink-0 rounded-full',
                deepResearch
                  ? 'bg-[var(--wakil-amber)]/15 text-[var(--wakil-amber)] hover:bg-[var(--wakil-amber)]/25 hover:text-[var(--wakil-amber)]'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              aria-pressed={deepResearch}
              aria-label={DEEP_RESEARCH_LABEL}
              title={DEEP_RESEARCH_LABEL}
              onClick={() => setDeepResearch((v) => !v)}
            >
              <Compass
                className={cn(
                  'size-5 transition-transform duration-200',
                  deepResearch && 'scale-110',
                )}
                aria-hidden="true"
              />
            </Button>

            <Button
              type="submit"
              className="press size-11 shrink-0 rounded-full"
              aria-label="إرسال الرسالة"
              disabled={!canSend}
            >
              {disabled ? (
                queuedCount > 0 ? (
                  <ArrowUpToLine className="size-5" aria-hidden="true" />
                ) : (
                  <Loader2 className="size-5 animate-spin" aria-hidden="true" />
                )
              ) : (
                <ArrowUp className="size-5" aria-hidden="true" />
              )}
            </Button>
          </div>
        </div>
      </form>

      {/* deep-research hint — only while the mode is armed */}
      {deepResearch && (
        <motion.p
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className="flex items-center justify-center gap-1.5 px-2 text-[11px] font-medium text-[var(--wakil-amber)]/90"
          role="status"
        >
          <Compass className="size-3 shrink-0" aria-hidden="true" />
          <span>وضع البحث العميق شغّال — هياخد وقت أطول ويرجع بمصادر</span>
        </motion.p>
      )}

      {/* storm-safe queue — messages waiting for the live turn to finish */}
      {queuedCount > 0 && (
        <motion.p
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className="flex items-center justify-center gap-1.5 px-2 text-[11px] font-medium text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden="true" />
          <span>
            رسالتك في الطابور — هتبعت أول ما يخلص الرد الجاري
            {queuedCount > 1 ? ` (${queuedCount})` : ''}
          </span>
        </motion.p>
      )}
    </div>
  )
}
