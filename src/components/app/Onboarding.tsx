// وكيل — Onboarding: cinematic 3-step first run.
//   1) pick your business  →  2) how the agent works (with a live demo plane)
//   →  3) the superpowers recap + trust line  →  straight into the chat.
//
// R28 fixes and upgrades:
//   • BUG: step 3 was invisible for anyone with «تقليل الحركة» enabled, because
//     the reduced-motion guard in globals.css applied `opacity: 0 !important`
//     to `.rise-in` (the class only this screen used). Reduced motion means «no
//     movement», never «no content» — the guard is fixed, and this screen no
//     longer depends on a single animation class to be visible.
//   • The root is scroll-safe (`overflow-y-auto` + `min-h-dvh`): on a short
//     phone the third step used to be clipped with no way to reach the button.
//   • Motion is choreographed like an AE comp: a kinetic headline, floating
//     planes with parallax tilt, a light sweep on the demo card, an amber
//     progress RAIL (not three dots), and curtain-style step transitions.
//   • The features are the REAL ones — the tools, the self-critique, the
//     verification — so step 3 shows the agent's actual superpowers.
//
// NOTE: no AnimatePresence anywhere (it froze the UI in this environment) —
// conditional render + enter classes/motion only.

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  ArrowLeft,
  BadgeCheck,
  Calculator,
  Check,
  Dumbbell,
  Eye,
  Languages,
  Layers,
  LineChart,
  Pill,
  Search,
  ShieldCheck,
  ShoppingBasket,
  Sparkles,
  Wrench,
} from 'lucide-react'
import type { BusinessLite } from '@/lib/types'
import { getVertical } from '@/lib/verticals'
import { AgentAvatar } from '@/components/chat/AgentAvatar'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const VERTICAL_ICONS = {
  basket: ShoppingBasket,
  dumbbell: Dumbbell,
  pill: Pill,
  sparkle: Sparkles,
} as const

/** The four superpowers, phrased as things the owner can feel. */
const SUPERPOWERS = [
  { icon: Languages, label: 'بيفهم عاميتك', body: '«بعت ٣ كرتونة لبن لأم حسن» = بيع بالآجل، بضغطة' },
  { icon: Calculator, label: 'بحسب من سجلك', body: 'مستحيل يقول رقم من دماغه — كله من الكتالوج' },
  { icon: Eye, label: 'بيراجع نفسه', body: 'قبل أي مسودة: يقارن السعر والمخزون ويقول لك شكه' },
  { icon: ShieldCheck, label: 'بيتحقق بعد التنفيذ', body: 'يقرا الخزنة والمخزون تاني ويتأكد إن اللي قاله حصل' },
] as const

/** The tool line in step 2 — REAL tools, not marketing. */
const TOOL_LINES = [
  { icon: LineChart, title: 'توقّع النقص', body: '«هيخلص خلال ٣ أيام» من معدل بيعك الفعلي' },
  { icon: Calculator, title: 'الربح الحقيقي', body: 'إيراد وهامش كل صنف من فواتيرك' },
  { icon: Wrench, title: '٧ أدوات قراءة', body: 'خزنة، مديونيات، صلاحيات، ملف عميل، مقارنة فترات' },
  { icon: Layers, title: 'خطة متعددة الخطوات', body: 'سؤال واحد يجيب ٤ إجابات في خطوة واحدة' },
] as const

/** Eyebrow line above every headline — the AE «slate». */
function Slate({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  return (
    <span
      style={{ animationDelay: `${delay}s` }}
      className="blur-in mb-2 inline-flex items-center gap-1.5 rounded-full border border-wakil-amber/40 bg-wakil-amber/10 px-2.5 py-1 text-[11px] font-bold tracking-wide text-wakil-amber-700"
    >
      <Sparkles className="size-3" aria-hidden="true" />
      {children}
    </span>
  )
}

/** Kinetic headline: every word rises 55ms after the one before it. */
function Kinetic({ text, className, delay = 0 }: { text: string; className?: string; delay?: number }) {
  const words = useMemo(() => text.split(' '), [text])
  return (
    <h2 className={className}>
      {words.map((w, i) => (
        <span key={`${w}-${i}`} style={{ ['--word-i' as string]: i, ['--stagger' as string]: delay }} className="kinetic-word">
          {w}
          {i < words.length - 1 ? '\u00A0' : ''}
        </span>
      ))}
    </h2>
  )
}

export function Onboarding({
  businesses,
  onFinish,
  onPick,
}: {
  businesses: BusinessLite[]
  onFinish: () => void
  onPick: (businessId: string, userId: string) => void
}) {
  const [step, setStep] = useState(0)
  const [picked, setPicked] = useState<BusinessLite | null>(null)
  const pickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (pickTimerRef.current) clearTimeout(pickTimerRef.current)
    },
    [],
  )

  /** step index → forward (1) or backward (-1): drives the curtain direction */
  const [dir, setDir] = useState<1 | -1>(1)

  const go = (next: number) => {
    setDir(next >= step ? 1 : -1)
    setStep(next)
  }

  // tap a business → feel the selection (amber ring + check) → auto-advance
  const pick = (b: BusinessLite) => {
    setPicked(b)
    if (pickTimerRef.current) clearTimeout(pickTimerRef.current)
    pickTimerRef.current = setTimeout(() => go(1), 360)
  }

  const enter = () => {
    if (picked) onPick(picked.id, picked.users[0].id)
    onFinish()
  }

  const pct = ((step + 1) / 3) * 100

  return (
    <div className="relative flex min-h-dvh flex-col overflow-x-hidden bg-gradient-to-b from-background via-background to-accent/40">
      {/* ambient planes — depth, never interactive */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="ae-float absolute -top-24 -start-24 size-72 rounded-full bg-[var(--wakil-amber-soft)] opacity-60 blur-3xl" style={{ ['--tilt' as string]: '-4deg' }} />
        <div
          className="ae-float absolute -bottom-32 -end-24 size-96 rounded-full bg-primary/10 blur-3xl"
          style={{ ['--tilt' as string]: '6deg', animationDelay: '1.2s' }}
        />
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-wakil-amber/50 to-transparent" />
      </div>

      {/* progress RAIL (a timeline, not three dots) */}
      <div className="relative z-10 mx-auto w-full max-w-md px-5 pt-6">
        <div className="ae-rail" aria-label={`خطوة ${step + 1} من ٣`}>
          <span style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-2 flex items-center justify-between text-[10px] font-semibold text-muted-foreground">
          <span className="num">{Math.round(pct)}%</span>
          <span>{step === 0 ? 'اختار شغلك' : step === 1 ? 'شوف بيشتغل إزاي' : 'سوبر باورز'}</span>
        </div>
      </div>

      <div className="relative z-10 mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-5 py-8">
        {/* ---------------- STEP 1: pick the business ---------------- */}
        {step === 0 && (
          <div
            style={{ ['--enter-x' as string]: `${dir * 24}px` }}
            className="ae-curtain flex flex-col items-center text-center"
          >
            <AgentAvatar state="idle" size="lg" />
            <Slate delay={0.1}>أول خطوة</Slate>
            <Kinetic text="أهلاً! أنا وكيل — مساعد شغلك اليومي" className="mt-1 text-2xl font-extrabold leading-tight" delay={0.15} />
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              قولّي بالعامي: «بعت ٣ كرتونة لبن» — وأنا أفهم، وأحسب من الأسعار الحقيقية، وأجهّزلك كل حاجة للاعتماد.
            </p>
            <div className="mt-7 w-full space-y-2">
              <p className="text-start text-xs font-semibold text-muted-foreground">اختار شغلك عشان نبدأ:</p>
              {businesses.map((b, i) => {
                const v = getVertical(b.type)
                const Icon = VERTICAL_ICONS[v.icon]
                const isPicked = picked?.id === b.id
                return (
                  <button
                    key={b.id}
                    onClick={() => pick(b)}
                    style={{ ['--stagger' as string]: i + 2 }}
                    className={cn(
                      'focus-warm ae-riser tap flex w-full items-center gap-3 rounded-2xl border bg-card p-4 text-start shadow-sm',
                      isPicked
                        ? 'border-wakil-amber ring-2 ring-wakil-amber/25'
                        : 'border-border hover:border-wakil-amber/60',
                    )}
                  >
                    <span className="flex size-11 items-center justify-center rounded-xl bg-accent text-accent-foreground">
                      <Icon className="size-5.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-bold">{b.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {v.shortLabel} — {v.description}
                      </span>
                    </span>
                    {isPicked ? (
                      <motion.span
                        initial={{ scale: 0.4, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ type: 'spring', stiffness: 500, damping: 22 }}
                        className="flex size-6 shrink-0 items-center justify-center rounded-full bg-wakil-amber text-white"
                      >
                        <Check className="size-3.5" aria-hidden />
                      </motion.span>
                    ) : (
                      <ArrowLeft className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* ---------------- STEP 2: how it works (live demo plane) -------- */}
        {step === 1 && picked && (
          <div
            style={{ ['--enter-x' as string]: `${dir * 24}px` }}
            className="ae-curtain flex flex-col items-center text-center"
          >
            <Slate>شوف بنفسك</Slate>
            <Kinetic text="كيف بشتغل؟" className="text-2xl font-extrabold" delay={0.05} />

            {/* the demo plane: a message going in, a verified card coming out */}
            <div className="mt-5 w-full space-y-2.5 text-start">
              <div className="ae-riser ms-auto max-w-[85%] rounded-2xl rounded-ee-sm bg-primary px-3.5 py-2.5 text-sm text-primary-foreground" style={{ ['--stagger' as string]: 0 }}>
                بعت ٥٠ جرام عنبر بـ٣٤٠٠ جنيه لأم حسن
              </div>
              <div className="ae-riser me-auto w-full max-w-[92%] rounded-2xl rounded-es-sm border border-border/70 bg-card p-3" style={{ ['--stagger' as string]: 1 }}>
                <div className="flex items-center gap-2 text-[11px] font-semibold text-wakil-amber-700">
                  <Eye className="size-3.5" aria-hidden /> راجعت المسودة من سجلك — ١ ملاحظة
                </div>
                <div className="mt-1.5 flex items-baseline justify-between text-sm">
                  <span className="text-muted-foreground">الإجمالي</span>
                  <span className="odometer font-bold" style={{ ['--stagger' as string]: 3 }}>٣٬٤٠٠ ج.م</span>
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-[11px] text-emerald-700 dark:text-emerald-400">
                  <ShieldCheck className="size-3.5" aria-hidden /> الخزنة +٣٬٤٠٠ · مخزون عنبر −٥٠ جرام
                </div>
                <div className="ae-sweep ae-sweep-loop mt-2 overflow-hidden rounded-lg border border-wakil-amber/40 bg-wakil-amber/10 px-2.5 py-1.5 text-[11px]">
                  محتاجة اعتمادك — مفيش حاجة بتتنفذ لوحدها
                </div>
              </div>
              <div className="ae-riser flex items-start gap-2 rounded-xl border border-border/70 bg-card/70 p-3" style={{ ['--stagger' as string]: 2 }}>
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
                <span className="text-xs leading-relaxed text-muted-foreground">
                  إنت المعتمد الوحيد: كل حركة فلوس توقف عند كارت تستنى «اعتماد». ولو حاجة ناقصة، بأسأل سؤال واحد بس.
                </span>
              </div>
            </div>

            <Button onClick={() => go(2)} size="lg" className="magnetic mt-6 h-12 w-full rounded-2xl text-base font-bold">
              تمام، فهمت — يلا بينا
            </Button>
          </div>
        )}

        {/* ---------------- STEP 3: superpowers + trust ------------------ */}
        {step === 2 && picked && (
          <div
            style={{ ['--enter-x' as string]: `${dir * 24}px` }}
            className="ae-curtain flex flex-col items-center text-center"
          >
            <motion.div
              initial={{ scale: 0.75, y: 12, opacity: 0 }}
              animate={{ scale: 1, y: 0, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 280, damping: 20 }}
            >
              <AgentAvatar state="success" size="lg" />
            </motion.div>
            <Slate delay={0.08}>آخر خطوة</Slate>
            <Kinetic text="أنا وكيل — موظفك الجديد" className="text-2xl font-extrabold" delay={0.12} />
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              من النهارده الشغل بيتكتب لوحده — وإنت بس تعتمد.
            </p>

            {/* the four superpowers */}
            <div className="mt-5 grid w-full grid-cols-1 gap-2">
              {SUPERPOWERS.map((s, i) => {
                const Icon = s.icon
                return (
                  <div
                    key={s.label}
                    style={{ ['--stagger' as string]: i + 2 }}
                    className="ae-riser flex items-start gap-2.5 rounded-xl border border-border/70 bg-card/80 p-3 text-start shadow-sm"
                  >
                    <span className="icon-wiggle flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-wakil-amber">
                      <Icon className="size-4" aria-hidden />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-xs font-bold">{s.label}</span>
                      <span className="block text-[11px] leading-relaxed text-muted-foreground">{s.body}</span>
                    </span>
                  </div>
                )
              })}
            </div>

            {/* the tool line — real capabilities, small print honest */}
            <div className="mt-4 grid w-full grid-cols-2 gap-2">
              {TOOL_LINES.map((t, i) => {
                const Icon = t.icon
                return (
                  <div
                    key={t.title}
                    style={{ ['--stagger' as string]: i + 6 }}
                    className="ae-riser rounded-xl border border-border/60 bg-card/60 p-2.5 text-start"
                  >
                    <Icon className="mb-1 size-3.5 text-wakil-amber" aria-hidden />
                    <span className="block text-[11px] font-bold">{t.title}</span>
                    <span className="block text-[10px] leading-relaxed text-muted-foreground">{t.body}</span>
                  </div>
                )
              })}
            </div>

            {/* trust line — the two promises that make money safe */}
            <div className="mt-4 flex w-full flex-col gap-1.5">
              <div className="flex items-center justify-center gap-2 text-[11px] text-muted-foreground">
                <BadgeCheck className="size-3.5 shrink-0 text-emerald-600" aria-hidden />
                كل حاجة موثقة — ومفيش حاجة بتتمسح
              </div>
              <div className="flex items-center justify-center gap-2 text-[11px] text-muted-foreground">
                <Search className="size-3.5 shrink-0 text-wakil-amber" aria-hidden />
                وكل رقم أقوله بيتقابل بالسجل قبل ما توصلك
              </div>
            </div>

            <Button onClick={enter} size="lg" className="magnetic ae-sweep mt-5 h-12 w-full rounded-2xl text-base font-bold">
              يلا نبدأ شغل حقيقي
            </Button>
            <button
              onClick={() => go(0)}
              className="focus-warm mt-3 rounded-sm text-xs text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground"
            >
              رجوع لاختيار شغل تاني
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
