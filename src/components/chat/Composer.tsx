'use client'

// وكيل — Motion-Graphics Aurora Composer (مربع الكتابة التفاعلي وقوس الإرسال الفيزيائي)
// Features:
// 1. Mouse-Reactive Aurora Border: tracks cursor (x, y) around the composer pill
//    with state-driven color shifts (Royal Navy, Golden Amber, Emerald Research, Acoustic Teal).
// 2. Bow & Arrow Spring Send Button: pulls arrow down against an elastic curved bowstring
//    before launching upward with procedural Web Audio SFX and a rising message projectile.
// 3. 3D Orbital Morphing Model Switcher: rotates in 3D space with distinct per-model states,
//    auras, and speed/depth telemetry badges.
// 4. Built-in Arabic Voice Dictation (ar-EG Web Speech API) with live waveform.

import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { LucideIcon } from 'lucide-react'
import {
  Brain,
  Check,
  ChevronUp,
  Cpu,
  Globe,
  Loader2,
  Mic,
  MicOff,
  Orbit,
  Scale,
  Sparkles,
  Zap,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { ToolIcon } from './QuickCommandsManager'
import type { ModelConfigDTO, QuickCommandDTO, SuggestionDTO } from '@/lib/types'
import { TIER_AR } from '@/lib/labels'
import { sfx } from '@/lib/sound-effects'
import { cn } from '@/lib/utils'

const MAX_HEIGHT = 124
const DEEP_RESEARCH_LABEL = 'بحث عميق وبحث إنترنت حي — وكيل يدور في السجل والويب ويدقق قبل ما يرد'

export interface ModelStateMeta {
  key: string
  label: string
  sub: string
  badgeAr: string
  icon: LucideIcon
  accentHex: string
  bgTint: string
  orbitSpeedSec: number
}

const BUILTIN_MODELS: readonly ModelStateMeta[] = [
  {
    key: 'auto',
    label: 'تلقائي ذكي (Gemini Engine)',
    sub: 'يوازن تلقائياً بين السرعة الفائقة والتحليل العميق والأدوات',
    badgeAr: 'توجيه ذكي',
    icon: Orbit,
    accentHex: '#d97706',
    bgTint: 'rgba(217, 119, 6, 0.14)',
    orbitSpeedSec: 4,
  },
  {
    key: 'gemini-flash',
    label: 'سريع خاطف · Gemini 3 Flash',
    sub: 'استجابة لحظية للشغل اليومي والبيع السريع والبحث الحي',
    badgeAr: 'فائق السرعة',
    icon: Zap,
    accentHex: '#10b981',
    bgTint: 'rgba(16, 185, 129, 0.14)',
    orbitSpeedSec: 2.2,
  },
  {
    key: 'gemini-pro',
    label: 'عميق مفكّر · Gemini 3.1 Pro',
    sub: 'تحليل مالي معقد، بناء أدوات مخصصة، وتخطيط استراتيجي',
    badgeAr: 'تحليل عميق',
    icon: Brain,
    accentHex: '#0d9488',
    bgTint: 'rgba(13, 148, 136, 0.15)',
    orbitSpeedSec: 6,
  },
  {
    key: 'builtin-deep',
    label: 'محرك احتياطي عميق · GLM-4.6',
    sub: 'استنتاج متعدد الخطوات للمهام المركبة (مزود احتياطي)',
    badgeAr: 'استنتاج مركب',
    icon: Brain,
    accentHex: '#6366f1',
    bgTint: 'rgba(99, 102, 241, 0.14)',
    orbitSpeedSec: 5.5,
  },
  {
    key: 'builtin-air',
    label: 'محرك احتياطي خفيف · GLM-4.5-Air',
    sub: 'سريع واقتصادي للعمليات البسيطة (مزود احتياطي)',
    badgeAr: 'خفيف',
    icon: Zap,
    accentHex: '#f59e0b',
    bgTint: 'rgba(245, 158, 11, 0.14)',
    orbitSpeedSec: 3,
  },
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
  modelKey,
  setModel,
  enabledExternal,
  currentLabel,
  onModelToast,
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
  const [deepResearch, setDeepResearch] = useState(false)
  const [focused, setFocused] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [mousePos, setMousePos] = useState({ x: 50, y: 50, pxX: 200, pxY: 40 })

  // Bow & Arrow physics state
  const [bowPhase, setBowPhase] = useState<'idle' | 'drawing' | 'launching'>('idle')
  const [launchedGhostText, setLaunchedGhostText] = useState<string | null>(null)

  // Built-in Arabic Voice Dictation state
  const [listening, setListening] = useState(false)
  const recognitionRef = useRef<{ stop: () => void } | null>(null)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const formRef = useRef<HTMLFormElement>(null)

  const autosize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [])

  useEffect(() => {
    autosize()
  }, [value, autosize])

  // Report draft/focus state so parent never auto-hides a live draft
  const drafting = focused || value.trim().length > 0 || listening
  const lastReported = useRef(false)
  useEffect(() => {
    if (lastReported.current !== drafting) {
      lastReported.current = drafting
      onDraftingChange?.(drafting)
    }
  }, [drafting, onDraftingChange])

  // Mouse-Reactive Aurora tracking
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLFormElement>) => {
    const el = formRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const pxX = e.clientX - rect.left
    const pxY = e.clientY - rect.top
    const x = Math.round((pxX / Math.max(1, rect.width)) * 100)
    const y = Math.round((pxY / Math.max(1, rect.height)) * 100)
    setMousePos({ x, y, pxX, pxY })
  }, [])

  // Execute Bow-and-Arrow launch + message fly-up animation
  const triggerBowAndArrowSend = useCallback(() => {
    const text = value.trim()
    if (!text) return

    // Phase 1: Draw bow downward (if not already drawing)
    setBowPhase('drawing')
    sfx.playBowDraw()

    setTimeout(() => {
      // Phase 2: Release bowstring & shoot arrow + ghost message upward
      setBowPhase('launching')
      sfx.playArrowLaunch()
      setLaunchedGhostText(text.slice(0, 72))

      onSend(text, { deepResearch })
      setValue('')
      setDeepResearch(false)
      textareaRef.current?.focus()

      setTimeout(() => {
        setBowPhase('idle')
      }, 360)
      setTimeout(() => {
        setLaunchedGhostText(null)
      }, 480)
    }, 115)
  }, [value, onSend, deepResearch])

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      triggerBowAndArrowSend()
    }
  }

  // Arabic Speech-to-Text (Web Speech API)
  const toggleVoiceDictation = useCallback(() => {
    if (onVoiceClick) {
      onVoiceClick()
      return
    }
    if (listening && recognitionRef.current) {
      recognitionRef.current.stop()
      setListening(false)
      return
    }
    if (typeof window === 'undefined') return
    const SpeechRec =
      (window as unknown as { SpeechRecognition?: new () => unknown; webkitSpeechRecognition?: new () => unknown })
        .SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: new () => unknown }).webkitSpeechRecognition

    if (!SpeechRec) {
      onModelToast({
        title: 'الميكروفون جاهز في المتصفحات الداعمة',
        description: 'استخدم Chrome أو Edge للإملاء الصوتي المباشر بالعربي المصري',
      })
      return
    }

    try {
      const rec = new SpeechRec() as {
        lang: string
        continuous: boolean
        interimResults: boolean
        onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
        onerror: (() => void) | null
        onend: (() => void) | null
        start: () => void
        stop: () => void
      }
      rec.lang = 'ar-EG'
      rec.continuous = false
      rec.interimResults = true
      rec.onresult = (event) => {
        let transcript = ''
        for (let i = 0; i < event.results.length; i++) {
          transcript += event.results[i][0].transcript
        }
        if (transcript.trim()) {
          setValue(transcript)
        }
      }
      rec.onerror = () => setListening(false)
      rec.onend = () => setListening(false)
      recognitionRef.current = rec
      setListening(true)
      sfx.playPop(620, 0.03)
      rec.start()
    } catch {
      setListening(false)
    }
  }, [listening, onVoiceClick, onModelToast])

  const canSend = value.trim().length > 0
  const topSuggestions = suggestions.slice(0, 4)
  const showSuggestionRow = !disabled && topSuggestions.length > 0

  // Dynamic Aurora color based on Composer state
  const activeModelMeta =
    BUILTIN_MODELS.find((m) => m.key === (modelKey ?? 'auto')) ?? BUILTIN_MODELS[0]

  const auroraPrimary = listening
    ? 'rgba(13, 148, 136, 0.55)'
    : deepResearch
      ? 'rgba(16, 185, 129, 0.55)'
      : canSend
        ? 'rgba(217, 119, 6, 0.55)'
        : focused
          ? 'rgba(217, 119, 6, 0.42)'
          : hovered
            ? activeModelMeta.accentHex + '66'
            : 'rgba(217, 119, 6, 0.18)'

  const auroraSecondary = listening
    ? 'rgba(217, 119, 6, 0.4)'
    : deepResearch
      ? 'rgba(13, 148, 136, 0.4)'
      : 'rgba(19, 35, 58, 0.35)'

  return (
    <div className="relative flex w-full flex-col gap-2">
      {/* Flying Message Projectile Animation when Bow launches */}
      <AnimatePresence>
        {launchedGhostText && (
          <motion.div
            key="projectile-msg"
            initial={{ opacity: 0.95, y: 0, scale: 0.92 }}
            animate={{ opacity: 0, y: -110, scale: 1.02 }}
            exit={{ opacity: 0 }}
            transition={{ type: 'spring', stiffness: 420, damping: 24 }}
            className="pointer-events-none absolute end-4 bottom-16 z-30 max-w-xs truncate rounded-2xl bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground shadow-lg"
          >
            {launchedGhostText}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Instant Quick Commands &Choreographed Recommendations Row */}
      {(commands.length > 0 || showSuggestionRow) && (
        <div
          className="scroll-warm flex gap-1.5 overflow-x-auto overflow-x-clip pb-1"
          role="group"
          aria-label="أوامر واقتراحات سريعة"
        >
          {commands.map((cmd, idx) => (
            <motion.button
              key={cmd.id}
              type="button"
              initial={{ opacity: 0, y: 8, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ type: 'spring', stiffness: 400, damping: 26, delay: idx * 0.035 }}
              whileHover={{ y: -2, scale: 1.02 }}
              whileTap={{ scale: 0.96 }}
              className="press h-8 shrink-0 rounded-xl border border-dashed border-primary/50 bg-primary/5 px-3 text-xs font-medium transition-colors hover:border-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              onClick={() => {
                sfx.playPop(540, 0.025)
                onCommandTap(cmd)
              }}
              aria-label={`شغّل أداة ${cmd.label}`}
              title={cmd.prompt}
            >
              <span className="flex items-center gap-1.5">
                <ToolIcon icon={cmd.icon} className="size-3.5 text-primary" />
                <span className="max-w-36 truncate">{cmd.label}</span>
              </span>
            </motion.button>
          ))}
          {showSuggestionRow &&
            topSuggestions.map((s, idx) => (
              <motion.button
                key={s.id}
                type="button"
                initial={{ opacity: 0, y: 8, scale: 0.94 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{
                  type: 'spring',
                  stiffness: 390,
                  damping: 25,
                  delay: (commands.length + idx) * 0.04,
                }}
                whileHover={{ y: -2, scale: 1.02 }}
                whileTap={{ scale: 0.96 }}
                className={cn(
                  'press h-8 shrink-0 rounded-xl border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  s.tone === 'primary'
                    ? 'border-transparent bg-primary text-primary-foreground hover:bg-primary/90'
                    : 'border-border bg-card/85 hover:border-wakil-amber/50 hover:bg-accent hover:text-accent-foreground',
                )}
                onClick={() => {
                  sfx.playPop(580, 0.025)
                  onSuggestionTap(s)
                }}
                aria-label={s.reasonLabel ? `${s.label} — ${s.reasonLabel}` : s.label}
                title={s.prompt}
              >
                <span className="flex items-center gap-1.5">
                  <ToolIcon icon={s.icon} className="size-3.5 text-wakil-amber" />
                  <span className="max-w-40 truncate">{s.label}</span>
                </span>
              </motion.button>
            ))}
        </div>
      )}

      {/* ===== Mouse-Reactive Aurora Liquid-Glass Input Pill ===== */}
      <motion.form
        ref={formRef}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onMouseMove={handleMouseMove}
        animate={
          bowPhase === 'drawing'
            ? { y: 2.5, scale: 0.996 }
            : bowPhase === 'launching'
              ? { y: [-2, 0], scale: [1.005, 1] }
              : { y: 0, scale: 1 }
        }
        transition={{ type: 'spring', stiffness: 450, damping: 24 }}
        style={{
          backgroundImage:
            hovered || focused || canSend || deepResearch || listening
              ? `radial-gradient(320px circle at ${mousePos.pxX}px ${mousePos.pxY}px, ${auroraPrimary}, transparent 75%), radial-gradient(480px circle at ${100 - mousePos.x}% ${100 - mousePos.y}%, ${auroraSecondary}, transparent 80%)`
              : undefined,
        }}
        className={cn(
          'relative flex flex-col rounded-[1.6rem] p-[1.5px] transition-shadow duration-300',
          focused || canSend
            ? 'shadow-[0_8px_32px_-8px_rgba(217,119,6,0.22)]'
            : hovered
              ? 'shadow-[0_6px_24px_-6px_rgba(19,35,58,0.16)]'
              : 'shadow-sm',
        )}
        onSubmit={(e) => {
          e.preventDefault()
          triggerBowAndArrowSend()
        }}
      >
        <div className="glass-strong relative flex flex-col rounded-[calc(1.6rem-1.5px)] bg-card/92 backdrop-blur-xl">
          {/* Top subtle reactive laser highlight bar */}
          <div
            aria-hidden="true"
            className="pointer-events-none h-[2px] w-full rounded-t-[1.6rem] transition-opacity duration-300"
            style={{
              opacity: hovered || focused || canSend || deepResearch || listening ? 0.95 : 0.25,
              background: `linear-gradient(90deg, transparent 5%, ${auroraPrimary} ${mousePos.x}%, transparent 95%)`,
            }}
          />

          <Textarea
            ref={textareaRef}
            value={value}
            rows={1}
            dir="rtl"
            placeholder={
              listening
                ? '🎙️ اتكلم دلوقتي… وكيل بيسمعك وبيكتب وراك لحظياً'
                : 'اتكلم مع وكيل بطبيعتك… بيع، اشتري، ابحث في السوق، أو قوله يبنيلك أداة تتابع أي حاجة'
            }
            aria-label="رسالة إلى وكيل"
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            className="min-h-[44px] max-h-30 flex-1 resize-none rounded-none rounded-t-[1.6rem] border-0 bg-transparent px-4 pt-3 pb-0.5 text-[15px] leading-6 shadow-none placeholder:text-muted-foreground/70 focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
          />

          {/* Action Row: 3D Orbital Model Switcher (start) · Voice / Live Web Research / Bow-Arrow Send (end) */}
          <div className="flex items-center justify-between gap-1.5 px-2.5 pb-2 pt-1.5">
            <ModelPicker
              modelKey={modelKey}
              setModel={setModel}
              enabledExternal={enabledExternal ?? []}
              currentLabel={currentLabel}
              onToast={onModelToast}
            />

            <div className="flex items-center gap-1.5">
              {/* Live Arabic Voice Dictation Button */}
              <Button
                type="button"
                variant="ghost"
                className={cn(
                  'press-apple icon-seat relative size-9 transition-colors',
                  listening
                    ? 'bg-teal-500/15 text-teal-600 dark:text-teal-400 ring-2 ring-teal-500/30'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                aria-label={listening ? 'إيقاف التسجيل الصوتي' : 'تحدث بالصوت مع وكيل'}
                title={listening ? 'إيقاف الاستماع الصوتي' : 'تحدث بالصوت (عربي مصري)'}
                onClick={toggleVoiceDictation}
              >
                {listening ? (
                  <motion.span
                    animate={{ scale: [1, 1.2, 1] }}
                    transition={{ duration: 0.8, repeat: Infinity }}
                    className="flex"
                  >
                    <MicOff className="size-4.5" aria-hidden="true" />
                  </motion.span>
                ) : (
                  <Mic className="size-4.5" aria-hidden="true" />
                )}
              </Button>

              {/* «بحث عميق + بحث الإنترنت الحي» Toggle */}
              <Button
                type="button"
                variant="ghost"
                className={cn(
                  'press-apple icon-seat size-9 transition-all',
                  deepResearch
                    ? 'bg-[var(--wakil-amber)]/15 text-[var(--wakil-amber)] ring-1 ring-[var(--wakil-amber)]/40 hover:bg-[var(--wakil-amber)]/25'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                aria-pressed={deepResearch}
                aria-label={DEEP_RESEARCH_LABEL}
                title={DEEP_RESEARCH_LABEL}
                onClick={() => {
                  sfx.playPop(deepResearch ? 420 : 660, 0.03)
                  setDeepResearch((v) => !v)
                }}
              >
                <motion.span
                  animate={
                    deepResearch
                      ? { rotate: [0, -15, 15, 0], scale: [1, 1.18, 1.1] }
                      : { rotate: 0, scale: 1 }
                  }
                  transition={{ duration: 0.45, ease: 'easeOut' }}
                  className="flex items-center justify-center"
                >
                  {deepResearch ? (
                    <Globe className="size-4.5" aria-hidden="true" />
                  ) : (
                    <Sparkles className="size-4.5" aria-hidden="true" />
                  )}
                </motion.span>
              </Button>

              {/* ===== Bow & Arrow Spring Send Button ===== */}
              <motion.button
                type="submit"
                disabled={!canSend && bowPhase === 'idle'}
                onMouseDown={() => {
                  if (canSend) {
                    setBowPhase('drawing')
                    sfx.playBowDraw()
                  }
                }}
                onMouseUp={() => {
                  if (bowPhase === 'drawing' && !canSend) {
                    setBowPhase('idle')
                  }
                }}
                whileHover={canSend ? { scale: 1.06 } : undefined}
                aria-label="إرسال الرسالة"
                title="إرسال (اسحب أو اضغط لإطلاق السهم)"
                className={cn(
                  'relative flex size-10 items-center justify-center overflow-hidden rounded-full transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  canSend || bowPhase !== 'idle'
                    ? 'bg-primary text-primary-foreground shadow-md shadow-primary/25 cursor-pointer'
                    : 'bg-muted text-muted-foreground/50 cursor-not-allowed',
                )}
              >
                {disabled && bowPhase === 'idle' ? (
                  queuedCount > 0 ? (
                    <span className="num flex items-center gap-0.5">
                      <span className="tabular-nums text-[11px] font-bold">{queuedCount}</span>
                      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                    </span>
                  ) : (
                    <Loader2 className="size-4.5 animate-spin" aria-hidden="true" />
                  )
                ) : (
                  <svg
                    viewBox="0 0 28 28"
                    className="size-6 overflow-visible"
                    aria-hidden="true"
                  >
                    {/* Elastic Bow Arc & String */}
                    <motion.path
                      d={
                        bowPhase === 'drawing'
                          ? 'M 5 16 Q 14 25 23 16'
                          : bowPhase === 'launching'
                            ? 'M 5 16 Q 14 9 23 16'
                            : 'M 6 17 Q 14 17 22 17'
                      }
                      fill="none"
                      stroke="currentColor"
                      strokeOpacity={canSend || bowPhase !== 'idle' ? 0.55 : 0.2}
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      transition={{ type: 'spring', stiffness: 520, damping: 18 }}
                    />

                    {/* Arrow Shaft + Head */}
                    <motion.g
                      animate={
                        bowPhase === 'drawing'
                          ? { y: 5.5, scaleY: 0.9 }
                          : bowPhase === 'launching'
                            ? { y: [-2, -22, 0], opacity: [1, 0, 1], scaleY: [1.15, 1, 1] }
                            : { y: 0, opacity: 1, scaleY: 1 }
                      }
                      transition={
                        bowPhase === 'launching'
                          ? { duration: 0.34, ease: [0.22, 1, 0.36, 1] }
                          : { type: 'spring', stiffness: 480, damping: 20 }
                      }
                    >
                      {/* Arrow shaft */}
                      <line
                        x1="14"
                        y1="20"
                        x2="14"
                        y2="7.5"
                        stroke="currentColor"
                        strokeWidth="2.3"
                        strokeLinecap="round"
                      />
                      {/* Arrow head */}
                      <path
                        d="M 9 12.5 L 14 7 L 19 12.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      {/* Arrow fletching feathers */}
                      <path
                        d="M 11.5 20.5 L 14 18.5 L 16.5 20.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        opacity="0.75"
                      />
                    </motion.g>
                  </svg>
                )}
              </motion.button>
            </div>
          </div>
        </div>
      </motion.form>

      {/* Deep-research & Live Web Search armed indicator */}
      {deepResearch && (
        <motion.p
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className="flex items-center justify-center gap-1.5 px-2 text-[11px] font-medium text-[var(--wakil-amber)]"
          role="status"
        >
          <Globe className="size-3 shrink-0" aria-hidden="true" />
          <span>وضع البحث العميق وبحث الإنترنت الحي (Google Search) مفعّل للرسالة دي</span>
        </motion.p>
      )}

      {/* Storm-safe queue indicator */}
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
// 3D Orbital Morphing Model Switcher
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
  const [spinCount, setSpinCount] = useState(0)

  const activeMeta =
    BUILTIN_MODELS.find((m) => m.key === (modelKey ?? 'auto')) ?? BUILTIN_MODELS[0]
  const ActiveIcon = activeMeta.icon

  const select = (key: string, label: string) => {
    sfx.playModelSwitch()
    setSpinCount((c) => c + 1)
    setModel(key)
    setOpen(false)
    onToast({ title: 'تم تبديل عقل وكيل', description: label })
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) sfx.playPop(520, 0.02)
        setOpen(next)
      }}
    >
      <PopoverTrigger asChild>
        <motion.button
          type="button"
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.96 }}
          className="press group flex h-9 shrink-0 items-center gap-2 rounded-full border border-border/70 bg-card/80 ps-1.5 pe-3 text-xs font-semibold text-foreground shadow-2xs transition-colors hover:border-wakil-amber/50"
          aria-label={`تبديل الموديل — الحالي ${currentLabel}`}
          title={`العقل النشط: ${currentLabel}`}
        >
          {/* Rotating 3D Orbital Core Badge */}
          <motion.span
            key={`${modelKey}-${spinCount}`}
            initial={{ rotateY: -180, scale: 0.7 }}
            animate={{ rotateY: 0, scale: 1 }}
            transition={{ type: 'spring', stiffness: 360, damping: 20 }}
            style={{ backgroundColor: activeMeta.bgTint, color: activeMeta.accentHex }}
            className="relative flex size-6.5 items-center justify-center rounded-full"
          >
            <ActiveIcon className="size-3.5" aria-hidden="true" />
            <span
              className="pointer-events-none absolute inset-0 rounded-full border border-dashed opacity-60 animate-spin"
              style={{
                borderColor: activeMeta.accentHex,
                animationDuration: `${activeMeta.orbitSpeedSec}s`,
              }}
            />
          </motion.span>

          <motion.span
            key={currentLabel}
            initial={{ y: 6, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 400, damping: 24 }}
            className="max-w-32 truncate text-[11.5px]"
          >
            {currentLabel}
          </motion.span>

          <span
            className="hidden sm:inline-block rounded px-1.5 py-0.5 text-[9.5px] font-bold"
            style={{ backgroundColor: activeMeta.bgTint, color: activeMeta.accentHex }}
          >
            {activeMeta.badgeAr}
          </span>

          <ChevronUp
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform duration-300',
              open && 'rotate-180 text-wakil-amber',
            )}
            aria-hidden="true"
          />
        </motion.button>
      </PopoverTrigger>

      <PopoverContent
        side="top"
        align="start"
        sideOffset={10}
        className="glass max-h-[50vh] w-80 overflow-y-auto scroll-warm rounded-2xl border-border/80 p-0 shadow-xl"
        dir="rtl"
      >
        <motion.div
          initial={{ opacity: 0, rotateX: 14, y: 10, scale: 0.96 }}
          animate={{ opacity: 1, rotateX: 0, y: 0, scale: 1 }}
          transition={{ type: 'spring', stiffness: 380, damping: 24 }}
          className="p-2.5"
        >
          <div className="flex items-center justify-between px-2 pb-1.5 pt-1">
            <p className="text-[11px] font-bold text-muted-foreground">
              اختر عقل وكيل (محرك التفكير والقرار)
            </p>
            <Cpu className="size-3.5 text-wakil-amber" />
          </div>

          <div className="space-y-1">
            {BUILTIN_MODELS.map((m, idx) => (
              <ModelRow
                key={m.key}
                index={idx}
                icon={m.icon}
                label={m.label}
                sub={m.sub}
                badgeAr={m.badgeAr}
                accentHex={m.accentHex}
                bgTint={m.bgTint}
                active={(modelKey ?? 'auto') === m.key}
                onSelect={() => select(m.key, m.label)}
              />
            ))}
          </div>

          {enabledExternal && enabledExternal.length > 0 && (
            <>
              <p className="mt-2 border-t border-border/60 px-2 pb-1 pt-2 text-[11px] font-bold text-muted-foreground">
                مزوّدات خارجية مخصصة
              </p>
              <div className="space-y-1">
                {enabledExternal.map((m, idx) => (
                  <ModelRow
                    key={m.id}
                    index={BUILTIN_MODELS.length + idx}
                    icon={TIER_ICONS[m.tier] ?? Brain}
                    label={m.label}
                    sub={`${TIER_AR[m.tier] ?? m.tier} · ${m.providerName}`}
                    badgeAr={TIER_AR[m.tier] ?? m.tier}
                    accentHex="#d97706"
                    bgTint="rgba(217, 119, 6, 0.14)"
                    active={modelKey === `ext:${m.id}`}
                    onSelect={() => select(`ext:${m.id}`, `${m.label} — ${m.providerName}`)}
                  />
                ))}
              </div>
            </>
          )}

          <p className="mt-2 border-t border-border/60 px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
            كل موديل يغير حالة التفكير وسرعة الاستجابة وتوليد الأدوات تلقائياً
          </p>
        </motion.div>
      </PopoverContent>
    </Popover>
  )
}

function ModelRow({
  index,
  icon: Icon,
  label,
  sub,
  badgeAr,
  accentHex,
  bgTint,
  active,
  onSelect,
}: {
  index: number
  icon: LucideIcon
  label: string
  sub: string
  badgeAr: string
  accentHex: string
  bgTint: string
  active: boolean
  onSelect: () => void
}) {
  return (
    <motion.button
      type="button"
      initial={{ opacity: 0, x: 10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.035, type: 'spring', stiffness: 400, damping: 26 }}
      whileHover={{ x: -3 }}
      onClick={onSelect}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'press flex min-h-12 w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-start transition-colors hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
        active && 'bg-accent ring-1 ring-wakil-amber/35',
      )}
    >
      <motion.span
        animate={active ? { rotate: [0, 12, -12, 0], scale: [1, 1.1, 1] } : undefined}
        transition={{ duration: 0.5 }}
        style={{ backgroundColor: bgTint, color: accentHex }}
        className="flex size-8 shrink-0 items-center justify-center rounded-xl"
      >
        <Icon className="size-4" aria-hidden="true" />
      </motion.span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-xs font-bold">{label}</span>
          <span
            className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold"
            style={{ backgroundColor: bgTint, color: accentHex }}
          >
            {badgeAr}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{sub}</span>
      </span>
      <AnimatePresence>
        {active && (
          <motion.span
            initial={{ scale: 0.3, rotate: -90, opacity: 0 }}
            animate={{ scale: 1, rotate: 0, opacity: 1 }}
            exit={{ scale: 0.3, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 440, damping: 20 }}
            className="flex shrink-0"
          >
            <Check className="size-4 text-wakil-amber" aria-hidden="true" />
          </motion.span>
        )}
      </AnimatePresence>
    </motion.button>
  )
}
