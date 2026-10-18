'use client'
// Real, actor-scoped setup. No invented inventory, balances, employees or links.
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useWakil } from '@/lib/store'
import { ACCENTS, DEFAULT_WORKSPACE, WORKSPACE_GOALS, type WorkspacePreferences } from '@/lib/workspace-options'
import type { BusinessLite } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { AgentAvatar } from '@/components/chat/AgentAvatar'
export function Onboarding({ businesses, onFinish, onPick, initial, onDefer }: { businesses: BusinessLite[]; onFinish: () => void; onPick: (businessId: string, userId: string) => void; initial?: WorkspacePreferences; onDefer?: () => void }) {
  const { businessId, userId, setModel } = useWakil()
  const business = businesses.find((b) => b.id === businessId) ?? businesses[0]
  const user = business?.users.find((u) => u.id === userId) ?? business?.users[0]
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
  return <main dir="rtl" className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
    <section className="w-full max-w-2xl space-y-6 rounded-3xl border bg-card p-6 shadow-sm sm:p-9" aria-labelledby="setup-title">
      <div className="flex items-center gap-4"><AgentAvatar state={busy ? 'thinking' : 'idle'} size="md" /><div><p className="text-sm text-muted-foreground">خطوة واحدة • إعداد حقيقي محفوظ لحسابك</p><h1 id="setup-title" className="text-2xl font-bold">وكيل على مقاس شغلك</h1></div></div>
      <p className="text-sm leading-7">أهلًا {user.name}، إنت داخل «{business.name}». مفيش بضاعة أو فلوس أو عملاء هيتضافوا تلقائي. بياناتك الفعلية بتدخلها أو تستوردها بعد البداية، وأي ربط خارجي لازم يتأكد قبل ما نقول إنه متصل.</p>
      <fieldset className="space-y-3"><legend className="font-semibold">إيه أهم حاجة نبدأ بيها؟ <span className="text-xs font-normal text-muted-foreground">لحد ٤ أولويات، وممكن تسيبها فاضية</span></legend><div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{Object.entries(WORKSPACE_GOALS).filter(([key]) => key !== 'members' || business.type === 'gym').map(([key, goal]) => {
        const value = key as keyof typeof WORKSPACE_GOALS
        return <label key={key} className="flex cursor-pointer items-center gap-3 rounded-xl border p-3 text-sm"><input type="checkbox" checked={draft.goals.includes(value)} disabled={busy || (!draft.goals.includes(value) && draft.goals.length >= 4)} onChange={(e) => setDraft({ ...draft, goals: e.target.checked ? [...draft.goals, value] : draft.goals.filter((g) => g !== value) })} />{goal.label}</label>
      })}</div></fieldset>
      <fieldset className="space-y-3"><legend className="font-semibold">طريقة الرد الافتراضية</legend><div className="flex flex-wrap gap-2">{(['fast', 'deep'] as const).map((mode) => <Button key={mode} variant={draft.responseMode === mode ? 'default' : 'outline'} aria-pressed={draft.responseMode === mode} disabled={busy} onClick={() => setDraft({ ...draft, responseMode: mode })}>{mode === 'fast' ? 'سريع • للشغل اليومي' : 'تفكير أعمق • للتحليل والتحقق'}</Button>)}</div><p className="text-xs leading-6 text-muted-foreground">الموديل محتاج مزوّد حقيقي متاح. لو مش متاح هنوضح ده؛ الوضع العميق مش ضمان صحة ومش بيكشف تفكير داخلي. تقدر تغيّر الوضع من الشات.</p></fieldset>
      <fieldset className="space-y-3"><legend className="font-semibold">لون الإحصائيات</legend><div className="flex flex-wrap gap-2">{Object.entries(ACCENTS).map(([key, color]) => <button key={key} type="button" disabled={busy} aria-label={`لون ${key}`} aria-pressed={draft.accent === key} onClick={() => setDraft({ ...draft, accent: key as keyof typeof ACCENTS })} className="flex h-11 items-center gap-2 rounded-full border px-4 text-sm aria-pressed:ring-2 aria-pressed:ring-ring"><span className="size-4 rounded-full" style={{ backgroundColor: color }} />{{ amber: 'كهرماني', teal: 'بترولي', indigo: 'نيلي', rose: 'وردي' }[key]}</button>)}</div></fieldset>
      <p className="rounded-xl bg-muted p-3 text-xs leading-6">بعد استخدامك، الطلبات المتكررة هتطلع كاختصارات لحسابك، وممكن نعرض جدولة تقرير قراءة فقط. مفيش جدولة تلقائية ولا صرف أو تحصيل من غير الموافقات المطلوبة. تقدر تقول: «غيّر لون الإحصائيات للنيلي»؛ تغيير الصلاحيات والكود والقواعد المالية مش جزء من تخصيص الواجهة.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {onDefer && <Button variant="outline" className="w-full" disabled={busy} onClick={onDefer}>إعدادات الحساب / أكمل الإعداد لاحقًا من غير حفظ</Button>}
      <Button className="w-full" disabled={busy} onClick={() => void save()}>{busy ? 'بنحفظ إعداداتك…' : 'احفظ وابدأ ببياناتي الحقيقية'}</Button>
    </section>
  </main>
}
