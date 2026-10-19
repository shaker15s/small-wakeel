'use client'
// R46 — the setup is an introduction to a REAL employee, not a form.
// Three steps: (١) who he is, (٢) what the first conversation looks like
// (real employee voice, real-record numbers), (٣) the actual saved setup.
// No invented inventory, balances, employees or links — the contract stays.
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { api } from '@/lib/api'
import { useWakil } from '@/lib/store'
import { sfx } from '@/lib/sound-effects'
import { ACCENTS, DEFAULT_WORKSPACE, WORKSPACE_GOALS, type WorkspacePreferences } from '@/lib/workspace-options'
import type { BusinessLite } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { AgentAvatar } from '@/components/chat/AgentAvatar'

// Tiny inline glyphs — this screen intentionally imports no icon library
// (ui-hygiene contract: the onboarding file renders exactly what it inlines).
function Glyph({ d }: { d: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="size-4.5" aria-hidden="true"><path d={d} /></svg>
}
const CAPS = [
  { d: 'M4 4h12l4 4v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z M8 10h8 M8 14h8 M8 18h5', label: 'بيسجل البيع والشراء فورا — مسودة واعتماد، مش تنفيذ في صمت' },
  { d: 'M3 7h18v10H3z M3 11h18 M7 15h4', label: 'بيحسب الخزنة والربح من بياناتك الفعلية — عددته قبل ما يقولها' },
  { d: 'M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6 M10 19a2 2 0 0 0 4 0', label: 'بيتابع الديون والصلاحيات ومواعيد السداد قبل ما تتحول لمشكلة' },
  { d: 'M12 4a4 4 0 0 0-4 4 4 4 0 0 0-2 7 4 4 0 0 0 4 5h4a4 4 0 0 0 4-5 4 4 0 0 0-2-7 4 4 0 0 0-4-4Z M12 4v16', label: 'بيتعلم من تصحيحك مرة واحدة — من غير ما تكررها تاني' },
]

const FIRST_EXCHANGES = [
  {
    user: 'بعت ٢ كرتونة لبن لأم حسن بـ٩٠',
    wakil: 'جاهز — مسودة بيع ٢ كرتونة لبن لأم حسن بـ٩٠ جنيه. راجعها واعتمدها لو تمام.',
  },
  {
    user: 'الخزنة فيها كام؟',
    wakil: 'في الخزنة ٣٬٢٥٠ جنيه — مبيعات النهارده ١٬١٤٠. الأرقام دي من سجلك، مش تقدير.',
  },
  {
    user: 'الباقي هدفعه بكرة',
    wakil: 'تمام — فاكرها: بكرة سداد. هذكرك الصبح قبل ما تفتح المحل.',
  },
]

const SPRING = { type: 'spring', stiffness: 320, damping: 26 } as const

export function Onboarding({ businesses, onFinish, onPick, initial, onDefer }: { businesses: BusinessLite[]; onFinish: () => void; onPick: (businessId: string, userId: string) => void; initial?: WorkspacePreferences; onDefer?: () => void }) {
  const { businessId, userId, setModel } = useWakil()
  const reduced = useReducedMotion()
  const business = businesses.find((b) => b.id === businessId) ?? businesses[0]
  const user = business?.users.find((u) => u.id === userId) ?? business?.users[0]
  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState<WorkspacePreferences>(initial ?? DEFAULT_WORKSPACE)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const client = useQueryClient()
  if (!business || !user) return null
  const save = async () => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const saved = await api.updateWorkspacePreferences(business.id, user.id, { ...draft, onboardingComplete: true })
      client.setQueryData(['workspace-preferences', business.id, user.id], saved)
      onPick(business.id, user.id)
      setModel(saved.responseMode === 'deep' ? 'gemini-pro' : 'gemini-flash')
      onFinish()
    } catch (e) { setError(e instanceof Error ? e.message : 'تعذّر الحفظ؛ لم نعتبر الإعداد مكتملًا') }
    finally { setBusy(false) }
  }
  const go = (to: number) => {
    if (busy) return
    sfx.playPop(520, 0.03)
    setStep(to)
  }
  const stepTitles = [
    { eyebrow: 'خطوة ١ من ٣ • التعارف', title: 'معرفك — أنا «وكيل»' },
    { eyebrow: 'خطوة ٢ من ٣ • الشكل العملي', title: 'أول محادثة هتبقى كده' },
    { eyebrow: 'خطوة ٣ من ٣ • إعداد حقيقي محفوظ لحسابك', title: 'وكيل على مقاس شغلك' },
  ]
  const t = stepTitles[step]
  return <main dir="rtl" className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
    <section className="w-full max-w-2xl space-y-6 rounded-3xl border bg-card p-6 shadow-sm sm:p-9" aria-labelledby="setup-title">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <AgentAvatar state={busy ? 'thinking' : 'idle'} size={step === 0 ? 'lg' : 'md'} />
          <div>
            <p className="text-sm text-muted-foreground">{t.eyebrow}</p>
            <h1 id="setup-title" className="text-2xl font-bold">{t.title}</h1>
          </div>
        </div>
        {/* Progress dots — forward is free, back is free, no traps */}
        <div className="flex items-center gap-1.5" role="tablist" aria-label="خطوات الإعداد">
          {stepTitles.map((_, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={i === step}
              aria-label={`الخطوة ${i + 1}`}
              onClick={() => i < step && go(i)}
              disabled={i > step}
              className={`h-1.5 rounded-full transition-all duration-300 ${i === step ? 'w-7 bg-primary' : i < step ? 'w-3.5 bg-primary/50' : 'w-3.5 bg-muted-foreground/25'}`}
            />
          ))}
        </div>
      </div>

      <AnimatePresence mode="wait">
        {step === 0 && (
          <motion.div
            key="s0"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -10 }}
            transition={SPRING}
            className="space-y-5"
          >
            <p className="text-sm leading-7">
              أهلا {user.name} — أنا جديد في «{business.name}» وهبقى شغال معاكي/معاك كل يوم.
              مش «شات بوت» بيرد بجمل محفوظة: أنا بفتكرك، بحسبلك، وبتابع عنك — وكل رقم أقوله
              لازم يكون من سجلك الحقيقي.
            </p>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {CAPS.map((c, i) => (
                <motion.li
                  key={c.label}
                  initial={reduced ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ ...SPRING, delay: 0.15 + i * 0.12 }}
                  className="flex items-center gap-3 rounded-xl border p-3 text-sm leading-6"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Glyph d={c.d} />
                  </span>
                  {c.label}
                </motion.li>
              ))}
            </ul>
            <p className="rounded-xl bg-muted p-3 text-xs leading-6">
              مفيش بضاعة أو فلوس أو عملاء هيتضافوا تلقائيًا — بياناتك الفعلية هتدخلها أو تستوردها
              بعد البداية، وأي ربط خارجي لازم يتأكد قبل ما نقول إنه متصل.
            </p>
          </motion.div>
        )}

        {step === 1 && (
          <motion.div
            key="s1"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -10 }}
            transition={SPRING}
            className="space-y-5"
          >
            <div className="space-y-4">
              {FIRST_EXCHANGES.map((ex, i) => (
                <motion.div
                  key={i}
                  initial={reduced ? { opacity: 0 } : { opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ ...SPRING, delay: 0.1 + i * 0.45 }}
                  className="space-y-2"
                >
                  <div className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl rounded-tr-sm border bg-muted/40 px-4 py-2.5 text-sm leading-6">{ex.user}</div>
                  </div>
                  <div className="flex items-end gap-2">
                    <AgentAvatar state="idle" size="sm" interactive={false} />
                    <div className="max-w-[85%] rounded-2xl rounded-tl-sm border border-primary/25 bg-primary/5 px-4 py-2.5 text-sm leading-6 text-foreground">{ex.wakil}</div>
                  </div>
                </motion.div>
              ))}
            </div>
            <p className="rounded-xl bg-muted p-3 text-xs leading-6">
              الأرقام في الأمثلة توضيحية بس — في شغلك كل رقم هيجي من سجلك الفعلي.
              لو قولت «بعت» بيسجل مسودة، ولو سألت «الخزنة كام؟» يفتح السجل ويعدّ قبل ما يرد.
            </p>
          </motion.div>
        )}

        {step === 2 && (
          <motion.div
            key="s2"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -10 }}
            transition={SPRING}
            className="space-y-5"
          >
            <fieldset className="space-y-3"><legend className="font-semibold">إيه أهم حاجة نبدأ بيها؟ <span className="text-xs font-normal text-muted-foreground">لحد ٤ أولويات، وممكن تسيبها فاضية</span></legend><div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{Object.entries(WORKSPACE_GOALS).filter(([key]) => key !== 'members' || business.type === 'gym').map(([key, goal]) => {
              const value = key as keyof typeof WORKSPACE_GOALS
              return <label key={key} className="flex cursor-pointer items-center gap-3 rounded-xl border p-3 text-sm transition-colors hover:bg-accent/50"><input type="checkbox" checked={draft.goals.includes(value)} disabled={busy || (!draft.goals.includes(value) && draft.goals.length >= 4)} onChange={(e) => setDraft({ ...draft, goals: e.target.checked ? [...draft.goals, value] : draft.goals.filter((g) => g !== value) })} />{goal.label}</label>
            })}</div></fieldset>
            <fieldset className="space-y-3"><legend className="font-semibold">طريقة الرد الافتراضية</legend><div className="flex flex-wrap gap-2">{(['fast', 'deep'] as const).map((mode) => <Button key={mode} variant={draft.responseMode === mode ? 'default' : 'outline'} aria-pressed={draft.responseMode === mode} disabled={busy} onClick={() => { sfx.playPop(560, 0.02); setDraft({ ...draft, responseMode: mode }) }}>{mode === 'fast' ? 'سريع • للشغل اليومي' : 'تفكير أعمق • للتحليل والتحقق'}</Button>)}</div><p className="text-xs leading-6 text-muted-foreground">الموديل محتاج مزوّد حقيقي متاح. لو مش متاح هنوضح ده؛ الوضع العميق مش ضمان صحة ومش بيكشف تفكير داخلي. تقدر تغيّر الوضع من الشات.</p></fieldset>
            <fieldset className="space-y-3"><legend className="font-semibold">لون الإحصائيات</legend><div className="flex flex-wrap gap-2">{Object.entries(ACCENTS).map(([key, color]) => <button key={key} type="button" disabled={busy} aria-label={`لون ${key}`} aria-pressed={draft.accent === key} onClick={() => { sfx.playPop(600, 0.02); setDraft({ ...draft, accent: key as keyof typeof ACCENTS }) }} className="flex h-11 items-center gap-2 rounded-full border px-4 text-sm transition-shadow hover:shadow-sm aria-pressed:ring-2 aria-pressed:ring-ring"><span className="size-4 rounded-full" style={{ backgroundColor: color }} />{{ amber: 'كهرماني', teal: 'بترولي', indigo: 'نيلي', rose: 'وردي' }[key]}</button>)}</div></fieldset>
            <p className="rounded-xl bg-muted p-3 text-xs leading-6">بعد استخدامك، الطلبات المتكررة هتطلع كاختصارات لحسابك، وممكن نعرض جدولة تقرير قراءة فقط. تقدر تقول: «غيّر لون الإحصائيات للنيلي»؛ تغيير الصلاحيات والكود والقواعد المالية مش جزء من تخصيص الواجهة.</p>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          </motion.div>
        )}
      </AnimatePresence>

      <p className="text-[11px] leading-5 text-muted-foreground">
        الموديل محتاج مزوّد حقيقي متاح — لو مش متاح هنوضح ده. مفيش جدولة تلقائية
        ولا صرف أو تحصيل من غير الموافقات المطلوبة.
      </p>

      <div className="flex items-center gap-2">
        {step > 0 && !busy && (
          <Button variant="ghost" onClick={() => go(step - 1)}>رجوع</Button>
        )}
        {step < 2 ? (
          <>
            <Button className="flex-1" onClick={() => go(step + 1)}>
              {step === 0 ? 'شوفه شغال' : 'تمام، زبطني'}
            </Button>
            <Button variant="ghost" onClick={() => go(2)}>تخطى التعريف</Button>
          </>
        ) : (
          <>
            {onDefer && <Button variant="outline" disabled={busy} onClick={onDefer}>أكمل لاحقًا من غير حفظ</Button>}
            <Button className="flex-1" disabled={busy} onClick={() => void save()}>{busy ? 'بنحفظ إعداداتك…' : 'احفظ وابدأ ببياناتي الحقيقية'}</Button>
          </>
        )}
      </div>
    </section>
  </main>
}
