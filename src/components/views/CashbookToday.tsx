'use client'
import MorningBriefCard from './MorningBriefCard'
import { ActionCard } from '@/components/chat/ActionCard'
import type { OperationDTO, ActionCardDTO } from '@/lib/types'
import { useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { ArrowDownLeft, ArrowUpRight, BellRing, BookOpen, Check, Coins, Loader2, Plus, ShieldCheck, Wallet } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { QUERY_KEYS, useWakil } from '@/lib/store'
import { arDate, egp } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'
import { ViewHeader, ErrorState, PAGE, type ViewProps } from './shared'

const kindLabels: Record<string, string> = { cash_purchase: 'شراء بضاعة كاش', cash_count: 'عدّ الخزنة', credit_sale: 'بضاعة للعميل على الحساب', credit_purchase: 'بضاعة من المورد على الحساب', lend: 'سلفة خرجت', borrow: 'سلفة دخلت', receive: 'تحصيل', pay: 'سداد', expense: 'مصروف', withdrawal: 'سحب شخصي', deposit: 'إيداع من جيبك' }
export default function CashbookToday({ businessId, userId, onNavigate }: ViewProps) {
  const reduced = useReducedMotion()
  const [count, setCount] = useState('')
  const [pendingBusy, setPendingBusy] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { toast } = useToast()
  const client = useQueryClient()
  const ask = (text: string) => { useWakil.getState().askAgent(text); onNavigate?.('chat') }
  const { data, isPending, error, refetch } = useQuery({ queryKey: ['cashbook', businessId, userId], queryFn: () => api.cashbook(businessId, userId), refetchOnMount: 'always', refetchOnWindowFocus: true, refetchInterval: 60_000 })
  const decide = async (op: OperationDTO, action: 'approve' | 'reject', reason?: string) => {
    if (pendingBusy) return
    setPendingBusy(op.id)
    try {
      const result = await api.confirmOperation(op.id, action, userId, reason)
      toast({ title: action === 'reject' ? 'اتلغت المسودة بدون أثر' : result.outcome?.ok ? 'تم التسجيل والتحقق' : 'فشلت بأمان', description: result.outcome?.failReason ?? op.ref })
      await client.invalidateQueries()
    } catch (e) { toast({ title: 'ما قدرتش أعتمد العملية', description: e instanceof Error ? e.message : 'جرّب تاني' }) }
    finally { setPendingBusy(null) }
  }
  const pendingCard = (op: OperationDTO): ActionCardDTO => {
    const p = op.payload
    if (op.type === 'debt_promise') return { kind: 'draft', opId: op.id, ref: op.ref, type: op.type, risk: op.risk, status: op.status, title: 'تعديل وعد السداد', summary: op.summary, fields: [{ label: 'الحساب', value: String(p.partyName) }, { label: 'أصل الدين', value: String(p.debtRef) }, { label: 'ميعاده السابق', value: String(p.previousDueOn ?? 'مش متحدد') }, { label: 'ميعاده الجديد', value: String(p.dueOn) }], effects: [], dangerNote: 'ميعاد بس؛ مش تحصيل أو سداد ولا تغيير في الخزنة.' }
    return { kind: 'draft', opId: op.id, ref: op.ref, type: op.type, risk: op.risk, status: op.status, title: kindLabels[String(p.kind)] ?? op.summary, summary: op.summary,
      fields: [{ label: 'المبلغ', value: egp(Number(p.amount ?? p.total ?? 0)) }, ...(p.partyName ? [{ label: 'صاحب الحساب', value: String(p.partyName) }] : []), ...(p.occurredOn ? [{ label: 'يوم الحركة', value: String(p.occurredOn), hint: p.dateSource === 'assumed_today' ? 'اليوم مفترض وقت الطلب؛ راجعه قبل الاعتماد' : undefined }] : []), ...(p.dueOn ? [{ label: 'ميعاد السداد', value: String(p.dueOn) }] : []), ...(p.reason ? [{ label: 'بند المصروف', value: String(p.reason) }] : []), ...(p.note ? [{ label: 'الوصف', value: String(p.note) }] : [])], effects: [],
      ...(p.kind === 'cash_count' ? { dangerNote: p.expectedCashKnown === false
        ? `ده أول عدّ فعلي. عند الاعتماد هيحدد الرصيد الحالي ${egp(Number(p.amount))}؛ مش مبيعات أو قبض.`
        : `فرق العد ${egp(Number(p.amount) - Number(p.expectedCash))} غير مصنف؛ مش مبيعات أو أرباح. الرصيد قبل العد ${egp(Number(p.expectedCash))}.` } : {}) }
  }
  if (error) return <div className={PAGE}><ErrorState message={error.message} onRetry={() => refetch()} /></div>
  return <div className={`${PAGE} space-y-6`} dir="rtl">
    <ViewHeader title="دفتر المحل" subtitle={`${arDate(new Date())} · الكاش والآجل، من غير تعقيد`} />
    <motion.section initial={reduced ? false : { opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="relative overflow-hidden rounded-[2rem] bg-slate-950 p-6 text-white shadow-xl sm:p-9" aria-label="خزنة المحل">
      <div aria-hidden className="pointer-events-none absolute -left-16 -top-20 size-72 rounded-full bg-emerald-400/15 blur-3xl" />
      <div className="relative grid min-w-0 grid-cols-1 gap-8 md:grid-cols-2">
        <div className="min-w-0"><span className="inline-flex items-center gap-2 rounded-full border border-white/15 px-3 py-1 text-xs text-emerald-100"><span className="size-1.5 rounded-full bg-emerald-300" />من الدفتر الحقيقي</span>
          <p className="mt-6 flex items-center gap-2 text-sm text-slate-300"><Wallet className="size-4" />{data?.cash == null ? "رصيد الخزنة غير معروف" : "المسجل في الخزنة دلوقتي"}</p>
          <p className={`mt-2 break-words text-4xl font-bold tracking-tight sm:text-5xl ${data?.cash != null && data.cash < 0 ? 'text-red-300' : ''}`} aria-live="polite">{isPending ? 'بنفتح الدفتر…' : !data ? '—' : data.cash == null ? 'غير محدد' : egp(data.cash)}</p>
          <p className="mt-4 max-w-sm text-xs leading-6 text-slate-300">مش لازم تسجل كل بيعة. عدّ اللي في الدرج وسجّل الديون والمصاريف. فرق العد مش دليل مبيعات أو مكسب.</p>
          {data?.cash == null && <p className="mt-2 max-w-sm text-xs leading-6 text-amber-200">لسه مفيش رصيد افتتاحي مُصرّح به ولا عدّ فعلي معتمد. الرقم مش صفر؛ الرصيد غير معروف. اعمل عدّ فعلي واعتمد المسودة عشان نثبت الرصيد.</p>}
          {data?.cash != null && data.cash < 0 && <p role="alert" className="mt-2 text-sm text-red-300">الرصيد القديم بالسالب؛ راجع الحركات وعدّ الخزنة. مش هنسمح بخروج كاش يزيد المشكلة.</p>}
        </div>
        <form onSubmit={e => { e.preventDefault(); if (/^\d+(?:\.\d{1,2})?$/.test(count)) ask(`باقي في الخزنة ${count}`) }} className="min-w-0 self-end rounded-2xl border border-white/15 bg-white/5 p-5 backdrop-blur">
          <label htmlFor="cashbook-count" className="flex items-center gap-2 font-semibold"><Coins className="size-5 text-emerald-300" />عدّ الخزنة / قفل اليوم</label>
          <p className="mt-2 text-xs leading-5 text-slate-300">معاك كام فعلًا؟ هنعرض الفرق عليك قبل ما تعتمد.</p>
          <div className="mt-4 flex gap-2"><input id="cashbook-count" value={count} onChange={e => setCount(e.target.value.replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))))} inputMode="decimal" placeholder="المبلغ بالجنيه" className="min-w-0 flex-1 rounded-xl border border-white/20 bg-slate-950/60 px-4 py-3 text-lg text-white outline-none focus:ring-2 focus:ring-emerald-300" /><Button type="submit" disabled={!/^\d+(?:\.\d{1,2})?$/.test(count)} className="h-auto rounded-xl bg-emerald-300 px-5 text-slate-950 hover:bg-emerald-200">راجع العدّ</Button></div>
          <p className="mt-3 flex items-center gap-1 text-[11px] text-slate-300"><ShieldCheck className="size-3.5" />مفيش رصيد هيتغير من غير اعتمادك</p>
        </form>
      </div>
    </motion.section>
    <MorningBriefCard businessId={businessId} userId={userId} onNavigate={onNavigate} />
    <div className="grid gap-3 sm:grid-cols-2">{[{ label: 'لينا عند الناس', value: data?.receivable, icon: ArrowDownLeft, color: 'text-emerald-600', prompt: 'مين عليه فلوس' }, { label: 'علينا للناس', value: data?.payable, icon: ArrowUpRight, color: 'text-amber-600', prompt: 'انا عليا كام' }].map(x => <button key={x.label} onClick={() => ask(x.prompt)} className="group flex items-center gap-4 rounded-2xl border bg-card p-5 text-start transition hover:-translate-y-0.5 hover:shadow-md motion-reduce:transform-none"><span className={`rounded-2xl bg-muted p-3 ${x.color}`}><x.icon className="size-6" /></span><span><span className="block text-xs text-muted-foreground">{x.label} · حسب المسجل</span><strong className="mt-1 block text-2xl">{x.value == null ? '—' : egp(x.value)}</strong></span><BookOpen className="ms-auto size-4 text-muted-foreground" /></button>)}</div>
    <section aria-label="طلبات يومك"><h2 className="mb-3 text-sm font-semibold">قولّي اللي حصل، وأنا أرتب الدفتر</h2><div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{[{ label: 'حد خد بضاعة آجل', text: 'عايز أسجل بضاعة لعميل على الحساب؛ اسألني الاسم والمبلغ واليوم' }, { label: 'جبت بضاعة على الحساب', text: 'عايز أسجل بضاعة من مورد على الحساب؛ اسألني الاسم والمبلغ واليوم' }, { label: 'تحصيل أو سداد', text: 'عايز أسجل سداد؛ اسألني لينا ولا علينا واسم الحساب والمبلغ واليوم' }, { label: 'مصروف أو سلفة', text: 'عايز أسجل فلوس خرجت؛ اسألني مصروف ولا سلفة ولا سحب شخصي والمبلغ واليوم' }].map(x => <motion.button key={x.label} whileTap={reduced ? undefined : { scale: 0.97 }} onClick={() => ask(x.text)} className="flex min-h-20 items-center gap-2 rounded-2xl border border-dashed bg-card p-4 text-start text-sm transition hover:border-emerald-500 hover:bg-emerald-500/5"><Plus className="size-4 shrink-0 text-emerald-600" />{x.label}</motion.button>)}</div></section>
    {!!data?.pendingOps.length && <section className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5"><h2 className="font-semibold">مستني مراجعتك · {data.pendingOps.length}</h2><p className="mt-1 text-xs text-muted-foreground">المسودات دي لسه ما غيرتش فلوس. راجع التفاصيل والفرق والاسم قبل الاعتماد.</p>{data.pendingOps.map(op => <details key={op.id} className="mt-3 border-t pt-3"><summary className="cursor-pointer text-sm">{op.summary} · راجع العملية</summary><div className="mt-3"><ActionCard card={pendingCard(op)} busy={pendingBusy === op.id} onApprove={reason => { void decide(op, 'approve', reason) }} onReject={() => { void decide(op, 'reject') }} /></div></details>)}</section>}
    {!!data?.reminders.length && <section className="rounded-2xl border bg-amber-500/5 p-5"><h2 className="flex items-center gap-2 text-sm font-semibold"><BellRing className="size-4 text-amber-600" />مع البضاعة الجاية</h2><div className="mt-3 flex flex-wrap gap-2">{data.reminders.map(r => <button key={r.id} onClick={() => ask(`جبت ${r.subject}`)} title="اضغط لو جبتها فعلًا؛ التذكير بس هيتشال" className="flex items-center gap-2 rounded-full border bg-card px-4 py-2 text-sm">{r.subject}<Check className="size-3 text-muted-foreground" /></button>)}</div><p className="mt-3 text-xs text-muted-foreground">هسألك عليهم لما تقولّي البضاعة وصلت. اضغط الاسم لو جبته فعلًا؛ ده مش تسجيل شراء.</p></section>}
    <section className="overflow-hidden rounded-2xl border bg-card"><div className="flex flex-wrap items-center justify-between gap-3 border-b p-5"><h2 className="flex w-full items-center gap-2 font-semibold sm:w-auto"><BookOpen className="size-4" />حركات دفتر الكاش</h2><Button variant="ghost" size="sm" onClick={() => ask('وريني الدفتر')}>افتح التفاصيل</Button><Button variant="ghost" size="sm" onClick={() => onNavigate?.('journal')}>كل الحركات</Button></div>
      {!data?.entries.length ? <div className="p-8 text-center"><BookOpen className="mx-auto size-8 text-muted-foreground/50" /><p className="mt-3 text-sm">أول حركة حقيقية هتظهر هنا بعد اعتمادها</p><p className="mt-1 text-xs text-muted-foreground">مفيش حسابات أو فلوس تجريبية في دفترك.</p></div> : <ol className="divide-y">{data.entries.map((e, index) => <motion.li key={e.id} initial={reduced ? false : { opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: Math.min(index, 5) * 0.035 }} className="flex items-start gap-3 px-5 py-4"><span className={`mt-1 rounded-full p-2 ${e.operation.reversedByRef ? 'bg-muted text-muted-foreground' : e.cashDelta < 0 ? 'bg-amber-500/10 text-amber-600' : 'bg-emerald-500/10 text-emerald-600'}`}><Coins className="size-4" /></span><div className="min-w-0 flex-1"><p className="text-sm font-medium">{kindLabels[e.kind] ?? e.kind}{e.partyName ? ` · ${e.partyName}` : ''}{e.operation.reversedByRef ? ' · معكوسة' : ''}</p><p className="mt-1 text-xs text-muted-foreground">{e.dateSource === 'recorded_day' ? 'اتسجل يوم' : e.dateSource === 'assumed_today' ? 'اليوم المفترض وقت الطلب' : 'يوم'} {e.occurredOn}{e.dueOn ? ` · السداد ${e.dueOn}` : ''} · <span className="font-mono">{e.operationRef}</span></p>{e.kind === 'cash_count' && <p className="mt-1 text-xs text-muted-foreground">فرق غير مصنف: {egp(e.cashDelta)} — مش مبيعات</p>}<details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">الوصف ووقت الإدخال</summary><p className="mt-2 whitespace-pre-wrap break-words">{e.note}</p><p className="mt-1">اتسجل: {new Date(e.recordedAt).toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' })} · {e.dateSource === 'recorded_day' ? 'يوم وساعة الواقعة مش محددين في المسار القديم' : 'ساعة الواقعة نفسها مش محددة'}</p></details></div><strong className="shrink-0 text-sm tabular-nums">{egp(e.amount)}</strong></motion.li>)}</ol>}
    </section>
    <p className="text-center text-xs leading-6 text-muted-foreground">التذكيرات داخل التطبيق أثناء تشغيل الخدمة. الدفتر مش كشف بنك، وعدّ الخزنة مش حساب أرباح.</p>
    <Button variant="ghost" size="sm" disabled={busy} onClick={async () => { setBusy(true); try { await api.setWorkflow('inventory', businessId, userId); await client.invalidateQueries({ queryKey: QUERY_KEYS.bootstrap }) } catch (e) { toast({ title: 'تعذر تغيير العرض', description: e instanceof Error ? e.message : 'جرّب تاني' }) } finally { setBusy(false) } }}>{busy && <Loader2 className="me-2 size-3 animate-spin" />}عرض متابعة الأصناف بدل دفتر المحل</Button>
  </div>
}
