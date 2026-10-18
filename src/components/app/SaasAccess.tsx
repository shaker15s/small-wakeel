'use client'
import { useState, type FormEvent } from 'react'
import { ShieldCheck, ArrowLeft, Loader2, Store } from 'lucide-react'
import { VERTICAL_PRESETS } from '@/lib/verticals'
import { Button } from '@/components/ui/button'
import { authRequest, clearBrowserIdentity } from '@/lib/saas/client'

type Mode = 'login' | 'register' | 'request-reset' | 'reset' | 'verify' | 'invite' | 'login-mfa'
export function SaasAccess({ registrationEnabled = false, action, linkToken }: { registrationEnabled?: boolean; action?: string; linkToken?: string }) {
  const initial: Mode = action === 'reset' || action === 'verify' || action === 'invite' ? action : 'login'
  const [mode, setMode] = useState<Mode>(initial)
  const [email, setEmail] = useState(''), [name, setName] = useState(''), [business, setBusiness] = useState('')
  const [type, setType] = useState('supermarket'), [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState('')
  const [code, setCode] = useState(''), [challenge, setChallenge] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  const labels: Record<Mode, string> = { login: 'أهلًا برجوعك', register: 'مساحة شغل تخصّك', 'request-reset': 'نرجّع لك حسابك', reset: 'كلمة مرور جديدة', verify: 'تأكيد بريدك الإلكتروني', invite: 'انضم لفريقك', 'login-mfa': 'خطوة أمان إضافية' }
  function change(next: Mode) { setMode(next); setError(''); setMessage(''); setPassword(''); setConfirmation('') }
  function enter(clearLink = false) { clearBrowserIdentity(); if (clearLink) window.history.replaceState({}, '', window.location.pathname); window.location.reload() }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('')
    try {
      if ((mode === 'register' || mode === 'reset') && password !== confirmation) throw new Error('كلمتا المرور مش متطابقتين')
      const result = await authRequest<{ mfaRequired?: boolean; challenge?: string; message?: string }>(mode === 'invite' ? 'accept-invite' : mode, {
        email: email || undefined, name: name || undefined, businessName: business || undefined, type,
        password: password || undefined, token: mode === 'login-mfa' ? challenge : mode === 'register' && action !== 'invite' ? undefined : linkToken, code: code || undefined,
      })
      if (result.mfaRequired && result.challenge) { setChallenge(result.challenge); setMode('login-mfa'); setPassword(''); return }
      if (['login', 'register', 'login-mfa', 'invite'].includes(mode)) { enter(mode === 'invite' || (mode === 'register' && action === 'invite')); return }
      setMessage(result.message || 'تمت العملية بنجاح')
      setPassword(''); setConfirmation('')
    } catch (err) { setError(err instanceof Error ? err.message : 'تعذّر إتمام الطلب') }
    finally { setBusy(false) }
  }
  const field = 'min-h-12 w-full rounded-xl border border-border bg-background px-4 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/15'
  return <main dir="rtl" className="grid min-h-screen bg-background lg:grid-cols-[1fr_1.1fr]">
    <aside className="relative hidden overflow-hidden bg-[#143a32] p-14 text-[#fbf7ec] lg:flex lg:flex-col lg:justify-between">
      <div className="flex items-center gap-3 text-2xl font-bold"><Store className="size-8" /> وكيل</div>
      <div className="relative z-10 max-w-md space-y-7"><span className="rounded-full border border-white/25 px-4 py-2 text-sm">شغلك، في مكانه الصح</span><h1 className="text-5xl font-bold leading-[1.4]">وقت أقل في الدفاتر.<br />وضوح أكتر في شغلك.</h1><p className="text-lg leading-9 text-white/70">منشأتك وموظفينك وسجلاتك — في مساحة واحدة بصلاحيات واضحة، وكل حركة مالية باعتماد وسجل مراجعة.</p></div>
      <p className="relative z-10 flex items-center gap-2 text-sm text-white/65"><ShieldCheck className="size-5" /> جلسات آمنة · تحقق بخطوتين · عزل بيانات المنشآت</p>
      <div aria-hidden className="absolute -bottom-48 -left-40 size-[600px] rounded-full border-[80px] border-white/[.035]" />
    </aside>
    <section className="flex items-center justify-center px-6 py-12"><div className="w-full max-w-md space-y-7">
      <div className="flex items-center gap-2 font-bold text-primary lg:hidden"><Store /> وكيل</div>
      <div><p className="mb-2 text-sm font-medium text-primary">مساعد شغلك اليومي</p><h2 className="text-3xl font-bold tracking-tight">{labels[mode]}</h2><p className="mt-3 text-sm leading-7 text-muted-foreground">{mode === 'register' && action === 'invite' ? 'أنشئ حسابك بنفس البريد المدعو؛ تنضم للفريق مباشرة دون منشأة إضافية.' : mode === 'register' ? 'ابدأ بمنشأة فارغة وفترة تجريبية 14 يومًا، حتى 5 أعضاء و50 طلب وكيل في اليوم بتوقيت UTC. لا نطلب بيانات دفع، ولا نضيف مبيعات تجريبية لسجلك.' : mode === 'login' ? 'ادخل بحسابك عشان تكمّل من آخر نقطة.' : mode === 'invite' ? 'ادخل بالحساب صاحب البريد المدعو، ثم اضغط قبول الدعوة. الرابط لا يمنح صلاحية لبريد مختلف.' : 'روابط الأمان صالحة لفترة محدودة ولمرة واحدة فقط.'}</p></div>
      <form onSubmit={submit} className="space-y-4">
        {['login', 'register', 'request-reset'].includes(mode) && <label className="block space-y-2 text-sm font-medium"><span>البريد الإلكتروني</span><input className={field} type="email" dir="ltr" autoComplete="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} /></label>}
        {mode === 'register' && <><label className="block space-y-2 text-sm font-medium"><span>اسمك</span><input className={field} autoComplete="name" required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} /></label>{action !== 'invite' && <><label className="block space-y-2 text-sm font-medium"><span>اسم المنشأة</span><input className={field} required maxLength={80} value={business} onChange={(e) => setBusiness(e.target.value)} /></label><label className="block space-y-2 text-sm font-medium"><span>نوع النشاط</span><select className={field} value={type} onChange={(e) => setType(e.target.value)}>{VERTICAL_PRESETS.map((preset) => <option key={preset.key} value={preset.key}>{preset.label}</option>)}</select></label></>}</>}
        {['login', 'register', 'reset'].includes(mode) && <label className="block space-y-2 text-sm font-medium"><span>كلمة المرور</span><input aria-label="كلمة المرور" aria-describedby={mode !== 'login' ? 'password-policy' : undefined} className={field} type="password" dir="ltr" required minLength={mode === 'login' ? 1 : 12} maxLength={128} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} />{mode !== 'login' && <span id="password-policy" className="text-xs font-normal text-muted-foreground">12 حرفًا على الأقل؛ استخدم عبارة طويلة وغير شائعة.</span>}</label>}
        {['register', 'reset'].includes(mode) && <label className="block space-y-2 text-sm font-medium"><span>تأكيد كلمة المرور</span><input className={field} type="password" dir="ltr" required minLength={12} maxLength={128} autoComplete="new-password" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} /></label>}
        {mode === 'login-mfa' && <label className="block space-y-2 text-sm font-medium"><span>رمز تطبيق المصادقة أو كود استرداد</span><input className={field} dir="ltr" autoComplete="one-time-code" required maxLength={64} value={code} onChange={(e) => setCode(e.target.value)} /></label>}
        {error && <p role="alert" className="rounded-xl bg-destructive/10 p-3 text-sm leading-7 text-destructive">{error}</p>}
        {message && <p role="status" className="rounded-xl bg-emerald-500/10 p-3 text-sm leading-7">{message}</p>}
        <Button type="submit" className="min-h-12 w-full rounded-xl" disabled={busy}>{busy ? <Loader2 className="size-4 animate-spin" /> : mode === 'verify' ? 'تأكيد البريد' : mode === 'invite' ? 'قبول الدعوة' : mode === 'request-reset' ? 'إرسال رابط الاستعادة' : mode === 'register' ? (action === 'invite' ? 'إنشاء حساب والانضمام للفريق' : 'إنشاء حساب ومنشأة') : mode === 'reset' ? 'حفظ كلمة المرور' : 'دخول آمن'}{!busy && <ArrowLeft className="ms-2 size-4" />}</Button>
      </form>
      <div className="flex flex-wrap items-center justify-center gap-4 text-sm">
        {mode === 'login' && <button type="button" onClick={() => change('request-reset')} className="text-muted-foreground underline underline-offset-4">نسيت كلمة المرور؟</button>}
        {mode !== 'login' && <button type="button" onClick={() => change('login')} className="text-primary underline underline-offset-4">الدخول لحساب موجود</button>}
        {registrationEnabled && mode !== 'register' && <button type="button" onClick={() => change('register')} className="font-medium text-primary">إنشاء حساب جديد</button>}
        {(message || action) && <button type="button" onClick={() => { window.history.replaceState({}, '', window.location.pathname); window.location.reload() }} className="text-primary underline underline-offset-4">الرجوع إلى وكيل</button>}
      </div>
      <p className="border-t pt-5 text-center text-xs leading-6 text-muted-foreground">بيانات الدخول لا تُحفظ في الروابط أو تخزين المتصفح. عمليات منشأتك لا تبدأ قبل تأكيد البريد.</p>
    </div></section>
  </main>
}
