// وكيل — Onboarding: cinematic 3-step first run (Duolingo energy).
// Pick your business → meet وكيل → how safety works → straight into the chat.

'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowLeft, BadgeCheck, Dumbbell, Pill, ShieldCheck, ShoppingBasket, Sparkles } from 'lucide-react'
import type { BusinessLite } from '@/lib/types'
import { getVertical } from '@/lib/verticals'
import { AgentAvatar } from '@/components/chat/AgentAvatar'
import { Button } from '@/components/ui/button'

const VERTICAL_ICONS = {
  basket: ShoppingBasket,
  dumbbell: Dumbbell,
  pill: Pill,
  sparkle: Sparkles,
} as const

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

  const next = () => setStep((s) => s + 1)

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

      {/* progress dots */}
      <div className="z-10 flex items-center justify-center gap-1.5 pt-6" aria-label={`خطوة ${step + 1} من 3`}>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={`h-1.5 rounded-full transition-all duration-300 ${i === step ? 'w-6 bg-wakil-amber' : i < step ? 'w-2 bg-wakil-amber/60' : 'w-2 bg-border'}`}
          />
        ))}
      </div>

      <div className="relative z-10 mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-5 py-8">
        {step === 0 && (
            <motion.div
              key="s0"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -16 }}
              transition={{ duration: 280 }}
              className="flex flex-col items-center text-center"
            >
              <AgentAvatar state="idle" size="lg" />
              <h1 className="mt-5 text-2xl font-extrabold leading-tight">
                أهلاً! أنا وكيل — مساعد شغلك اليومي
              </h1>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                قولّي بالعامي: «بعت 3 كرتونة لبن» — وأنا أفهم، وأحسب من الأسعار الحقيقية، وأجهزلك كل حاجة للاعتماد.
              </p>
              <div className="mt-7 w-full space-y-2">
                <p className="text-start text-xs font-semibold text-muted-foreground">اختار شغلك عشان نبدأ:</p>
                {businesses.map((b) => {
                  const v = getVertical(b.type)
                  const Icon = VERTICAL_ICONS[v.icon]
                  return (
                    <button
                      key={b.id}
                      onClick={() => {
                        setPicked(b)
                        next()
                      }}
                      className="press flex w-full items-center gap-3 rounded-2xl border border-border bg-card p-4 text-start shadow-sm transition-all hover:border-wakil-amber hover:shadow-md"
                    >
                      <span className="flex size-11 items-center justify-center rounded-xl bg-accent text-accent-foreground">
                        <Icon className="size-5.5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-bold">{b.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">{v.shortLabel} — {v.description}</span>
                      </span>
                      <ArrowLeft className="size-4 text-muted-foreground" />
                    </button>
                  )
                })}
              </div>
            </motion.div>
        )}

        {step === 1 && picked && (
            <motion.div
              key="s1"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -16 }}
              transition={{ duration: 280 }}
              className="flex flex-col items-center text-center"
            >
              <AgentAvatar state="thinking" size="lg" />
              <h2 className="mt-5 text-xl font-extrabold">كيف بشتغل؟</h2>
              <div className="mt-6 w-full space-y-3 text-start">
                {[
                  { icon: '💭', title: 'بفهم وبسأل', body: 'لو ناقص رقم أو اسم — أسأل سؤال واحد بس، ومش بتتنفذ حاجة بالغلط.' },
                  { icon: '🧮', title: 'بحسب من سجلك', body: 'الأسعار من الكتالوج الحقيقي — الأرقام عمرها ما بتتاخد من دماغي.' },
                  { icon: '✋', title: 'بعتمد عليك', body: 'كل عملية فلوس بتظهرلك في كارت واضح — إنت اللي تعتمد أو تلغي.' },
                  { icon: '🔍', title: 'بتحقق بعد التنفيذ', body: 'بقرا الخزنة والمخزون تاني وأتأكد إن الأرقام مظبوطة — ولو فيه اختلاف بقولك.' },
                ].map((row) => (
                  <div key={row.title} className="flex items-start gap-3 rounded-xl border border-border/70 bg-card/80 p-3.5">
                    <span className="text-xl leading-none">{row.icon}</span>
                    <span>
                      <span className="block text-sm font-bold">{row.title}</span>
                      <span className="block text-xs leading-relaxed text-muted-foreground">{row.body}</span>
                    </span>
                  </div>
                ))}
              </div>
              <Button onClick={next} className="mt-7 h-12 w-full rounded-2xl text-base press">
                تمام، فهمت — يلا بينا
              </Button>
            </motion.div>
        )}

        {step === 2 && picked && (
            <motion.div
              key="s2"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -16 }}
              transition={{ duration: 280 }}
              className="flex flex-col items-center text-center"
            >
              <motion.div
                initial={{ scale: 0.8 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 260, damping: 18, delay: 120 }}
                className="flex size-16 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
              >
                <ShieldCheck className="size-8" />
              </motion.div>
              <h2 className="mt-5 text-xl font-extrabold">كل حاجة موثقة — ومفيش حاجة بتتمسح</h2>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                لو حاجة غلطت، بتتعكس بعملية موثقة جديدة مش بمسح. وتقدر تراجع أي عملية برقمها في السجل.
              </p>
              <div className="mt-6 flex w-full items-center justify-center gap-2 text-xs text-muted-foreground">
                <BadgeCheck className="size-4 text-emerald-600" />
                درجات خطورة واضحة على كل عملية — من قراءة عادية لعمليات حساسة محتاجة سبب
              </div>
              <Button onClick={enter} size="lg" className="mt-8 h-12 w-full rounded-2xl text-base press">
                يلا نبدأ شغل حقيقي
              </Button>
              <button onClick={next === next ? () => setStep(0) : undefined} className="mt-3 text-xs text-muted-foreground underline underline-offset-4">
                رجوع لاختيار شغل تاني
              </button>
            </motion.div>
        )}
      </div>
    </div>
  )
}
