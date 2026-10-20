'use client'
// R75 / PR-007 — the onboarding state machine, UI side.
//
// ONE question at a time, answered straight from the server's `pending`
// list — a question the owner already answered is never shown again (the
// state, not a step counter, drives the interview; a refresh never loses
// progress). Financial facts are owner-stated only: the skip button exists
// precisely so «مش عارف» stays UNKNOWN in the record, not 0.
import { useEffect, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { api, type OnboardingProfileState } from '@/lib/api'
import { PROFILE_CONSENTS } from '@/lib/onboarding-constants'
import type { BusinessLite } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { AgentAvatar } from '@/components/chat/AgentAvatar'
import { sfx } from '@/lib/sound-effects'

const SPRING = { type: 'spring', stiffness: 320, damping: 26 } as const

export function OnboardingProfileStep({ business, userId, onDone }: { business: BusinessLite; userId: string; onDone: () => void }) {
  const reduced = useReducedMotion()
  const [state, setState] = useState<OnboardingProfileState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [freeText, setFreeText] = useState('')
  const [picked, setPicked] = useState<string[]>([])

  useEffect(() => {
    let alive = true
    api.onboardingProfile(business.id, userId)
      .then((s) => { if (alive) setState(s) })
      .catch(() => { if (alive) setError('تعذّر تحميل ملف النشاط — جرب تاني') })
    return () => { alive = false }
  }, [business.id, userId])

  if (error && !state) return <p role="alert" className="text-sm text-destructive">{error}</p>
  if (!state) return <p className="text-sm text-muted-foreground">بتجهز ملف النشاط…</p>

  const pendingKey = state.pending[0]
  const q = state.questions.find((x) => x.key === pendingKey)

  const act = async (fn: () => Promise<OnboardingProfileState>) => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const s = await fn()
      setState(s)
      setFreeText('')
      setPicked([])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'تعذّر الحفظ — الإجابة مش اتسجلت')
    } finally {
      setBusy(false)
    }
  }

  const toggle = (c: string) => {
    sfx.playPop(540, 0.02)
    setPicked((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]))
  }

  /** re-ask an answered question from the summary (a correction, allowed). */
  const reask = (key: string) => setState((s) => (s ? { ...s, pending: [key, ...s.pending.filter((k) => k !== key)] } : s))

  const answer = (value: string | number | null, skip = false) =>
    act(() => api.answerOnboardingProfile(business.id, userId, q!.key, value, skip))

  const showSummary = !q || state.stage === 'confirmed'

  const answerLabel = (key: string) => {
    const a = state.answers[key]
    const question = state.questions.find((x) => x.key === key)
    if (!a) return null
    if (a.skipped || a.value == null) return question?.financial ? 'غير مسجل (مش صفر)' : '—'
    if (question?.financial) return `${a.value} ج.م`
    return String(a.value)
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="rounded-full border px-2 py-0.5">
          {state.stage === 'not_started' && 'مفيش إجابة محفوظة لسه'}
          {state.stage === 'interviewing' && `مسجل — باقي ${state.pending.length} سؤال`}
          {state.stage === 'proposed' && 'الملف جاهز للمراجعة'}
          {state.stage === 'confirmed' && 'الملف مؤكد ✅'}
        </span>
        <span>كل إجابة بتتحفظ فورًا — تروح وترجع، مفيش سؤال بيتسأل تاني.</span>
      </div>

      {showSummary ? (
        <div className="space-y-4">
          <ul className="divide-y rounded-2xl border">
            {state.questions.map((qq) => (
              <li key={qq.key} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <span className="text-muted-foreground">{qq.label.replace('؟', '').replace(/\(.*\)/, '')}</span>
                <span className="font-medium">
                  {state.answers[qq.key]
                    ? <span className={state.answers[qq.key].skipped && qq.financial ? 'text-amber-600 dark:text-amber-400' : ''}>{answerLabel(qq.key)}</span>
                    : <button type="button" disabled={busy} onClick={() => reask(qq.key)} className="text-primary underline">جاوب دلوقتي</button>}
                </span>
              </li>
            ))}
          </ul>
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold">موافقات الاستيراد (مفيش استيراد من غير واحدة منها)</legend>
            {PROFILE_CONSENTS.map((c) => (
              <label key={c.key} className="flex cursor-pointer items-center gap-3 rounded-xl border p-3 text-sm">
                <input
                  type="checkbox"
                  checked={state.consents[c.key]?.granted === true}
                  disabled={busy}
                  onChange={(e) => void act(() => api.setOnboardingConsent(business.id, userId, c.key, e.target.checked))}
                />
                {c.label}
              </label>
            ))}
          </fieldset>
          {state.stage !== 'confirmed' ? (
            <Button className="w-full" disabled={busy} onClick={() => void act(() => api.confirmOnboardingProfile(business.id, userId))}>
              {busy ? 'بتتأكد…' : 'راجعت الملف — أكد وأكمل'}
            </Button>
          ) : (
            <Button className="w-full" disabled={busy} onClick={onDone}>كمل للإعدادات</Button>
          )}
        </div>
      ) : (
        <motion.div
          key={q.key}
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={SPRING}
          className="space-y-4"
        >
          <div className="flex items-start gap-3">
            <AgentAvatar state="idle" size="sm" interactive={false} />
            <div>
              <p className="font-semibold leading-6">{q.label}</p>
              {q.help && <p className="mt-1 text-xs leading-5 text-muted-foreground">{q.help}</p>}
            </div>
          </div>

          {q.choices ? (
            <div className="flex flex-wrap gap-2">
              {q.choices.map((c) => (
                <Button
                  key={c}
                  type="button"
                  variant={picked.includes(c) ? 'default' : 'outline'}
                  aria-pressed={picked.includes(c)}
                  disabled={busy}
                  onClick={() => {
                    if (q.key === 'units') {
                      toggle(c)
                    } else {
                      void answer(c)
                    }
                  }}
                >
                  {c}
                </Button>
              ))}
              {q.key === 'units' && (
                <Button type="button" disabled={busy || picked.length === 0} onClick={() => void answer(picked.join('، '))}>
                  تأكيد الاختيار ({picked.length})
                </Button>
              )}
            </div>
          ) : q.financial ? (
            <div className="flex gap-2">
              <input
                value={freeText}
                onChange={(e) => setFreeText(e.target.value.replace(/[^0-9]/g, ''))}
                inputMode="numeric"
                placeholder="المبلغ بالجنيه"
                className="w-full rounded-xl border bg-background px-3 py-2.5 text-sm"
                aria-label="المبلغ بالجنيه"
              />
              <Button type="button" disabled={busy || freeText.length === 0} onClick={() => void answer(Number(freeText))}>سجل الرقم</Button>
            </div>
          ) : (
            <div className="flex gap-2">
              <input
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                placeholder="اكتب إجابتك…"
                className="w-full rounded-xl border bg-background px-3 py-2.5 text-sm"
                aria-label="إجابتك"
              />
              <Button type="button" disabled={busy || freeText.trim().length === 0} onClick={() => void answer(freeText.trim())}>سجل</Button>
            </div>
          )}

          {q.skipAllowed && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void answer(null, true)}
              className="text-xs text-muted-foreground underline hover:text-foreground"
            >
              {q.financial ? 'تخطي — هتفضل «غير مسجلة» مش صفر' : 'تخطي السؤال'}
            </button>
          )}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </motion.div>
      )}
    </div>
  )
}
