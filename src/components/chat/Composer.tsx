'use client'

// وكيل — Composer (R18 «آبل جلاس»): compact liquid-glass input pill.
// NEW: the MODEL PICKER lives INSIDE the composer (bottom) — the user asked
// «قايمة الموديلات تكون تحت في مربع الكتابة» — it opens UPWARD as a fully
// scrollable glass popover (max-h capped → long provider lists finally
// scroll). Every icon sits in its own circle (mic / deep-research / send),
// the send button springs on press, and the parent auto-hides the whole
// composer while the user reads history (draft-aware: never hides a draft).

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { LucideIcon } from 'lucide-react'
import { ArrowUp, Brain, Check, ChevronUp, Cpu, Loader2, Mic, Scale, Sparkles, Zap } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { ToolIcon } from './QuickCommandsManager'
import type { ModelConfigDTO, QuickCommandDTO, SuggestionDTO } from '@/lib/types'
import { TIER_AR } from '@/lib/labels'
import { cn } from '@/lib/utils'

const MAX_HEIGHT = 120 // 3 rows max — compact by design
const DEEP_RESEARCH_LABEL = 'بحث عميق — وكيل يدور ويدقق قبل ما يرد'

const BUILTIN_MODELS = [
  { key: 'builtin-deep', label: 'عميق مفكّر', sub: 'glm-4.6 · للمهام المعقدة', icon: Brain },
  { key: 'builtin-air', label: 'خفيف سريع', sub: 'glm-4.5-air · سريع ويكفي', icon: Zap },
] as const

const TIER_ICONS: Record<string, LucideIcon> = { air: Zap, balanced: Scale, deep: Brain }

export function Composer({
  commands,
  suggestions,
  onSend,
  onCommandTap,
  onSuggestionTap,
  disabled,
  queuedCount = 0,
  onVoiceClick,
  // ---- model picker (moved INSIDE the composer — R18) ----
  modelKey,
  setModel,
  enabledExternal,
  currentLabel,
  onModelToast,
  // ---- auto-hide protection: the parent hides the composer while the user
  // scrolls history — but NEVER while there's a live draft or focus ----
  onDraftingChange,
}: {
  commands: QuickCommandDTO[]
  suggestions: SuggestionDTO[]
  onSend: (text: string, opts?: { deepResearch?: boolean }) => void
  onCommandTap: (command: QuickCommandDTO) => void
  onSuggestionTap: (suggestion: SuggestionDTO) => void
  disabled?: boolean
  queuedCount?: number
  onVoiceClick?: () => void
  modelKey: string | null
  setModel: (key: string) => void
  enabledExternal?: Array<ModelConfigDTO & { providerName: string }>
  currentLabel: string
  onModelToast: (t: { title: string; description?: string }) => void
  onDraftingChange?: (drafting: boolean) => void
}) {
  const [value, setValue] = useState('')
  /** «بحث عميق» — lives per-message: ON until the next send, then resets */
  const [deepResearch, setDeepResearch] = useState(false)
  const [focused, setFocused] = useState(false)
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

  // report draft/focus state so the parent never auto-hides a live draft
  const drafting = focused || value.trim().length > 0
  const lastReported = useRef(false)
  useEffect(() => {
    if (lastReported.current !== drafting) {
      lastReported.current = drafting
      onDraftingChange?.(drafting)
    }
  }, [drafting, onDraftingChange])

  const send = useCallback(() => {
    const text = value.trim()
    // STORM-SAFE: a live turn does NOT block submission — the parent QUEUES
    // mid-stream sends and flushes them on done (silent-loss fix, R15).
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
          className="scroll-warm flex gap-1.5 overflow-x-auto overflow-x-clip pb-1"
          role="group"
          aria-label="أوامر واقتراحات سريعة"
        >
          {commands.map((cmd) => (
            <button
              key={cmd.id}
              type="button"
              className="press chip-lift h-8 shrink-0 rounded-full border border-dashed border-primary/60 bg-primary/5 px-3.5 text-xs transition-all hover:border-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
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
                  'press chip-lift h-8 shrink-0 rounded-full border px-3.5 text-xs transition-all hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  s.tone === 'primary'
                    ? 'border-transparent bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground'
                    : 'border-border bg-card/70 backdrop-blur-sm',
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

      {/* ===== the liquid-glass input pill ===== */}
      <form
        className="glass-strong flex flex-col rounded-[1.6rem] transition-[box-shadow,border-color] focus-within:border-wakil-amber/50"
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
          placeholder="اكتب لوكيل…"
          aria-label="رسالة إلى وكيل"
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          className="min-h-[44px] max-h-30 flex-1 resize-none rounded-none rounded-t-[1.6rem] border-0 bg-transparent px-4 pt-3 pb-0.5 text-[15px] leading-6 shadow-none placeholder:text-muted-foreground/70 focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
        />

        {/* action row: model selector (start) · mic / compass / send (end) */}
        <div className="flex items-center justify-between gap-1.5 px-2 pb-2 pt-1.5">
          {/* model picker — INSIDE the composer, opens upward */}
          <ModelPicker
            modelKey={modelKey}
            setModel={setModel}
            enabledExternal={enabledExternal ?? []}
            currentLabel={currentLabel}
            onToast={onModelToast}
          />

          <div className="flex items-center gap-1">
            {/* voice — teaser seat in its own circle */}
            <Button
              type="button"
              variant="ghost"
              className="press-apple icon-seat size-9 text-muted-foreground"
              aria-label="تسجيل صوتي لرسالتك"
              title={onVoiceClick ? undefined : 'الصوت جاي قريب'}
              disabled={!onVoiceClick}
              onClick={() => onVoiceClick?.()}
            >
              <Mic className="size-4.5" aria-hidden="true" />
            </Button>

            {/* «بحث عميق» toggle — amber when armed, resets after each send */}
            <Button
              type="button"
              variant="ghost"
              className={cn(
                'press-apple icon-seat size-9',
                deepResearch
                  ? 'bg-[var(--wakil-amber)]/15 text-[var(--wakil-amber)] hover:bg-[var(--wakil-amber)]/25'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              aria-pressed={deepResearch}
              aria-label={DEEP_RESEARCH_LABEL}
              title={DEEP_RESEARCH_LABEL}
              onClick={() => setDeepResearch((v) => !v)}
            >
              <motion.span
                animate={deepResearch ? { rotate: [0, -12, 12, 0], scale: 1.15 } : { rotate: 0, scale: 1 }}
                transition={{ duration: 0.45, ease: 'easeOut' }}
                className="flex"
              >
                <Sparkles className="size-4.5" aria-hidden="true" />
              </motion.span>
            </Button>

            <Button
              type="submit"
              className="press-apple icon-seat size-10 shadow-md shadow-primary/20"
              aria-label="إرسال الرسالة"
              disabled={!canSend}
            >
              {disabled ? (
                queuedCount > 0 ? (
                  <span className="num flex items-center gap-1">
                    <span className="tabular-nums text-xs font-bold">{queuedCount}</span>
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  </span>
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
          <Sparkles className="size-3 shrink-0" aria-hidden="true" />
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

// ---------------------------------------------------------------------------
// Model picker — INSIDE the composer, opens UPWARD, fully scrollable
// (R18 fix: «القايمة مش بتفتح كاملة ومبقدرش اسطرول» — capped + scrollable)
// ---------------------------------------------------------------------------
function ModelPicker({
  modelKey,
  setModel,
  enabledExternal,
  currentLabel,
  onToast,
}: {
  modelKey: string | null
  setModel: (key: string) => void
  enabledExternal: Array<ModelConfigDTO & { providerName: string }>
  currentLabel: string
  onToast: (t: { title: string; description?: string }) => void
}) {
  const [open, setOpen] = useState(false)

  const select = (key: string, label: string) => {
    setModel(key)
    setOpen(false)
    onToast({ title: 'تم تبديل الموديل', description: label })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          className="press h-9 shrink-0 gap-1.5 rounded-full ps-2 pe-2.5 text-xs font-medium text-muted-foreground hover:text-foreground"
          aria-label={`تبديل الموديل — الحالي ${currentLabel}`}
          title={`الموديل الحالي: ${currentLabel}`}
        >
          <span className="icon-seat size-7 bg-muted/80">
            <Cpu className="size-3.5 text-wakil-amber" aria-hidden="true" />
          </span>
          <span className="max-w-28 truncate">{currentLabel}</span>
          <ChevronUp
            className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180"
            aria-hidden="true"
          />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        side="top"
        align="start"
        sideOffset={10}
        // R17 fix kept + hardened: cap the height and make the list itself
        // scrollable — works even with many external providers.
        className="glass max-h-[45vh] w-72 overflow-y-auto scroll-warm rounded-2xl p-0"
        dir="rtl"
      >
        <div className="p-2">
          <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold text-muted-foreground">
            الموديلات الداخلية
          </p>
          {BUILTIN_MODELS.map((m) => (
            <ModelRow
              key={m.key}
              icon={m.icon}
              label={m.label}
              sub={m.sub}
              active={modelKey === m.key}
              onSelect={() => select(m.key, m.label)}
            />
          ))}

          {enabledExternal && enabledExternal.length > 0 && (
            <>
              <p className="mt-1.5 border-t border-border/60 px-2.5 pb-1 pt-2 text-[11px] font-semibold text-muted-foreground">
                مزوّدين خارجيين
              </p>
              {enabledExternal.map((m) => {
                // «الموديلات» honesty: a model that failed its last live probe,
                // or cannot call tools (the agent needs tool calling for every
                // write), must SAY so in the picker — not look identical to a
                // healthy one and then fail on the first message.
                const h = m.health
                const warn = !h
                  ? null
                  : !h.ok
                    ? `آخر فحص فشل${h.note ? ` — ${h.note.slice(0, 40)}` : ''}`
                    : !h.supportsTools
                      ? 'مش بيدعم الأدوات — مش هيعرف يسجّل عمليات'
                      : null
                return (
                  <ModelRow
                    key={m.id}
                    icon={TIER_ICONS[m.tier] ?? Brain}
                    label={m.label}
                    sub={`${TIER_AR[m.tier] ?? m.tier} · ${m.providerName}`}
                    warn={warn}
                    healthy={h ? h.ok && h.supportsTools : undefined}
                    active={modelKey === `ext:${m.id}`}
                    onSelect={() => select(`ext:${m.id}`, `${m.label} — ${m.providerName}`)}
                  />
                )
              })}
            </>
          )}

          <p className="mt-1.5 border-t border-border/60 px-2.5 py-2 text-[10px] leading-relaxed text-muted-foreground">
            تضيف مزوّدين من الإعدادات ↗
          </p>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function ModelRow({
  icon: Icon,
  label,
  sub,
  warn,
  healthy,
  active,
  onSelect,
}: {
  icon: LucideIcon
  label: string
  sub: string
  /** shown in amber under the sub-line (probe failure / no tool support) */
  warn?: string | null
  /** green/red status dot — undefined means «لسه مااتفحصش» */
  healthy?: boolean
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'press flex min-h-11 w-full items-center gap-2.5 rounded-xl px-2 py-2 text-start transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
        active && 'bg-accent/70',
      )}
    >
      <span className="icon-seat size-7 bg-muted">
        <Icon className="size-3.5 text-wakil-amber" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-xs font-semibold">{label}</span>
          {healthy != null && (
            <span
              className={cn('size-1.5 shrink-0 rounded-full', healthy ? 'bg-emerald-500' : 'bg-red-500')}
              aria-label={healthy ? 'الموديل شغّال' : 'الموديل مش شغّال'}
            />
          )}
        </span>
        <span className="block truncate text-[10px] text-muted-foreground">{sub}</span>
        {warn && <span className="mt-0.5 block truncate text-[10px] font-medium text-wakil-amber">{warn}</span>}
      </span>
      <AnimatePresence>
        {active && (
          <motion.span
            initial={{ scale: 0.4, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.4, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 420, damping: 22 }}
            className="flex shrink-0"
          >
            <Check className="size-4 text-wakil-amber" aria-hidden="true" />
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  )
}
