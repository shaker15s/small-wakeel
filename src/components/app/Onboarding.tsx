// وكيل — Onboarding: cinematic 3-step first run (Duolingo energy).
// Pick your business → meet وكيل → how safety works → straight into the chat.
// NOTE: no AnimatePresence anywhere (it froze the UI in this environment) —
// conditional render + enter classes/motion only.

'use client'

import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowLeft, BadgeCheck, Check, Dumbbell, GraduationCap, Languages, Pill, ShoppingBasket, Sparkles, Wallet } from 'lucide-react'
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

// وكيل's 3 superpowers — the final-step recap chips
const SUPERPOWERS = [
  { icon: GraduationCap, label: 'بيقعد يتعلم' },
  { icon: Languages, label: 'بيفهم عاميتك' },
  { icon: Wallet, label: 'يسجل كل قرش' },
] as const

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

  const next = () => setStep((s) => (s === 1 ? 2 : s))

  // tap a business → feel the selection (amber border + check) → auto-advance
  const pick = (b: BusinessLite) => {
    setPicked(b)
    if (pickTimerRef.current) clearTimeout(pickTimerRef.current)
    pickTimerRef.current = setTimeout(() => {
      setStep((s) => (s === 0 ? 1 : s))
    }, 360)
  }

  const enter = () => {
    if (picked) {
      onPick(picked.id, picked.users[0].id)
    }
    onFinish()
  }

  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden bg-gradient-to-b from-background via-background to-accent/40">
      {/* ambient orbs */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -top-24 -start-24 size-72 rounded-full bg-[var(--wakil-amber-soft)] opacity-60 blur-3xl" />
        <div className="absolute -bottom-32 -end-24 size-96 rounded-full bg-primary/10 blur-3xl" />
      </div>

      {/* progress dots — active dot pulses amber */}
      <div className="z-10 flex items-center justify-center gap-1.5 pt-6" aria-label={`خطوة ${step + 1} من 3`}>
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            animate={
              i === step
                ? { scale: [1, 1.25, 1], opacity: 1 }
                : { scale: 1, opacity: i < step ? 1 : 0.55 }
            }
            transition={{ duration: 0.5, ease: 'easeInOut' }}
            className={cn(
              'h-1.5 rounded-full',
              i === step ? 'w-6 bg-wakil-amber' : i < step ? 'w-2 bg-wakil-amber/60' : 'w-2 bg-border',
            )}
          />
        ))}
      </div>

      <div className="relative z-10 mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-5 py-8">
        {step === 0 && (
          <div className="list-enter flex flex-col items-center text-center">
            <AgentAvatar state="idle" size="lg" />
            <h1 className="mt-5 text-2xl font-extrabold leading-tight">
              أهلاً! أنا وكيل — مساعد شغلك اليومي
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              قولّي بالعامي: «بعت 3 كرتونة لبن» — وأنا أفهم، وأحسب من الأسعار الحقيقية، وأجهزلك كل حاجة للاعتماد.
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
                    style={{ animationDelay: `${i * 40}ms` }}
                    className={cn(
                      'focus-warm chip-lift list-enter flex w-full items-center gap-3 rounded-2xl border bg-card p-4 text-start shadow-sm',
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
                      <span className="block truncate text-xs text-muted-foreground">{v.shortLabel} — {v.description}</span>
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

        {step === 1 && picked && (
          <div className="list-enter flex flex-col items-center text-center">
            <AgentAvatar state="thinking" size="lg" />
            <h2 className="mt-5 text-xl font-extrabold">كيف بشتغل؟</h2>
            <div className="mt-6 w-full space-y-3 text-start">
              {[
                { icon: '💭', title: 'بفهم وبسأل', body: 'لو ناقص رقم أو اسم — أسأل سؤال واحد بس، ومش بتتنفذ حاجة بالغلط.' },
                { icon: '🧮', title: 'بحسب من سجلك', body: 'الأسعار من الكتالوج الحقيقي — الأرقام عمرها ما بتتاخد من دماغي.' },
                { icon: '✋', title: 'بعتمد عليك', body: 'كل عملية فلوس بتظهرلك في كارت واضح — إنت اللي تعتمد أو تلغي.' },
                { icon: '🔍', title: 'بتحقق بعد التنفيذ', body: 'بقرا الخزنة والمخزون تاني وأتأكد إن الأرقام مظبوطة — ولو فيه اختلاف بقولك.' },
              ].map((row, i) => (
                <div
                  key={row.title}
                  style={{ animationDelay: `${i * 40}ms` }}
                  className="list-enter flex items-start gap-3 rounded-xl border border-border/70 bg-card/80 p-3.5"
                >
                  <span className="text-xl leading-none">{row.icon}</span>
                  <span>
                    <span className="block text-sm font-bold">{row.title}</span>
                    <span className="block text-xs leading-relaxed text-muted-foreground">{row.body}</span>
                  </span>
                </div>
              ))}
            </div>
            <Button
              onClick={next}
              className="mt-7 h-12 w-full rounded-2xl text-base font-bold transition-transform duration-150 hover:scale-[1.02] active:scale-95"
            >
              تمام، فهمت — يلا بينا
            </Button>
          </div>
        )}

        {step === 2 && picked && (
          <div className="rise-in flex flex-col items-center text-center">
            <motion.div
              initial={{ scale: 0.7, y: 10 }}
              animate={{ scale: 1, y: 0 }}
              transition={{ type: 'spring', stiffness: 280, damping: 20 }}
            >
              <AgentAvatar state="success" size="lg" />
            </motion.div>
            <h2 className="mt-4 text-xl font-extrabold">أنا وكيل — موظفك الجديد</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              من النهارده ربنا يسهل، كل حاجة بتتكتب لوحدها 😄
            </p>

            {/* superpowers recap */}
            <div className="mt-5 grid w-full grid-cols-1 gap-2 sm:grid-cols-3">
              {SUPERPOWERS.map((s, i) => {
                const Icon = s.icon
                return (
                  <div
                    key={s.label}
                    style={{ animationDelay: `${120 + i * 60}ms` }}
                    className="list-enter flex items-center gap-2.5 rounded-xl border border-border/70 bg-card/80 p-3 text-start shadow-sm"
                  >
                    <span className="icon-wiggle flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-wakil-amber">
                      <Icon className="size-4" aria-hidden />
                    </span>
                    <span className="text-xs font-bold">{s.label}</span>
                  </div>
                )
              })}
            </div>

            {/* trust line — the immutability promise */}
            <div className="mt-5 flex w-full items-center justify-center gap-2 text-xs text-muted-foreground">
              <BadgeCheck className="size-4 shrink-0 text-emerald-600" aria-hidden />
              كل حاجة موثقة — ومفيش حاجة بتتمسح
            </div>
            <Button
              onClick={enter}
              size="lg"
              className="mt-6 h-12 w-full rounded-2xl text-base font-bold transition-transform duration-150 hover:scale-[1.02] active:scale-95"
            >
              يلا نبدأ شغل حقيقي
            </Button>
            <button
              onClick={() => setStep(0)}
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
