'use client'
import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Mic, Square, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogHeader } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { useWakil } from '@/lib/store'

/** Real MediaRecorder → bounded ASR upload → editable draft, never automatic send/approval. */
export function SpeechRecorder({ open, onClose, onTranscript }: { open: boolean; onClose: () => void; onTranscript: (text: string) => void }) {
  const identity = useWakil(s => `${s.businessId}:${s.userId}`)
  const status = useQuery({ queryKey: ['speech-status', identity], queryFn: api.speechStatus, enabled: open })
  const [phase, setPhase] = useState<'idle' | 'recording' | 'captured' | 'transcribing'>('idle')
  const [seconds, setSeconds] = useState(0)
  const [audio, setAudio] = useState<Blob | null>(null)
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const abort = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    setAudio(null); setPhase('idle'); setSeconds(0); setError('')
    return () => {
      generation.current++
      abort.current?.abort()
      if (timer.current) clearInterval(timer.current)
      const r = recorder.current; recorder.current = null
      if (r && r.state !== 'inactive') r.stop()
      stream.current?.getTracks().forEach(t => t.stop()); stream.current = null
    }
  }, [open, identity])
  useEffect(() => { if (!audio) { setUrl(''); return }; const next = URL.createObjectURL(audio); setUrl(next); return () => URL.revokeObjectURL(next) }, [audio])
  async function start() {
    setError(''); setAudio(null); setSeconds(0)
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { setError('المتصفح مش بيسمح بتسجيل الصوت. جرّب HTTPS ومتصفح حديث أو كمّل كتابة.'); return }
    const epoch = ++generation.current
    try {
      const tracks = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (epoch !== generation.current) { tracks.getTracks().forEach(t => t.stop()); return }
      stream.current = tracks
      const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t))
      const r = new MediaRecorder(tracks, mimeType ? { mimeType } : undefined)
      const chunks: Blob[] = []; let size = 0
      recorder.current = r
      r.ondataavailable = e => { if (epoch !== generation.current || !e.data.size) return; chunks.push(e.data); size += e.data.size; if (size > 4 * 1024 * 1024 && r.state !== 'inactive') r.stop() }
      r.onstop = () => {
        tracks.getTracks().forEach(t => t.stop())
        if (timer.current) clearInterval(timer.current)
        if (epoch !== generation.current) return
        recorder.current = null
        if (!size || size > 4 * 1024 * 1024) { setError('التسجيل فاضي أو أكبر من الحد. جرّب مقطع أقصر.'); setPhase('idle'); return }
        setAudio(new Blob(chunks, { type: r.mimeType || mimeType || 'audio/webm' })); setPhase('captured')
      }
      r.onerror = () => { if (epoch !== generation.current) return; setError('التسجيل اتوقف. راجع الميكروفون وجرّب تاني.'); if (r.state !== 'inactive') r.stop(); tracks.getTracks().forEach(t => t.stop()) }
      r.start(250); setPhase('recording')
      let elapsed = 0
      timer.current = setInterval(() => { if (epoch !== generation.current) return; setSeconds(++elapsed); if (elapsed >= 30 && r.state !== 'inactive') r.stop() }, 1000)
    } catch { if (epoch === generation.current) { stream.current?.getTracks().forEach(t => t.stop()); setPhase('idle'); setError('اسمح بالميكروفون من إعدادات المتصفح. النص المكتوب محفوظ.') } }
  }
  async function convert() {
    if (!audio) return
    const epoch = generation.current
    const controller = new AbortController(); abort.current = controller
    setPhase('transcribing'); setError('')
    try {
      const result = await api.transcribe(audio, controller.signal)
      if (epoch !== generation.current) return
      onTranscript(result.text); onClose()
    } catch (e) { if (epoch === generation.current) { setPhase('captured'); setError(e instanceof Error ? e.message : 'تعذر تحويل التسجيل') } }
  }
  return <Dialog open={open} onOpenChange={next => { if (!next) onClose() }}><DialogContent className="max-w-md" dir="rtl">
    <DialogHeader><DialogTitle>سجّل، اسمع، وراجع</DialogTitle><DialogDescription>الصوت هيتحوّل لنص تراجعه بنفسك. مفيش إرسال رسالة ولا اعتماد فلوس تلقائي.</DialogDescription></DialogHeader>
    <p className="text-sm leading-7">التسجيل على جهازك لحد ما تضغط «حوّل لنص». وقتها بيتبعت لـ{status.data?.providerLabel ?? 'خدمة الصوت المختارة'} لمعالجته؛ التطبيق مش بيحفظ ملف الصوت. سياسة حفظ المزوّد تخصّه. ما تسجلش أسرار أو صوت حد تاني من غير إذنه.</p>
    {!status.data?.available && <p role="status" className="text-sm text-muted-foreground">{status.isPending ? 'بتحقق من خدمة الصوت…' : 'خدمة تحويل التسجيل لسه مش متوصلة. مسؤول النظام يختار موديل صوت من الإعدادات. زر الإملاء من المتصفح والكتابة متاحين.'}</p>}
    {phase === 'recording' && <p role="status" aria-live="polite" className="font-semibold text-red-600">● تسجيل فعلي · {seconds} / ٣٠ ثانية</p>}
    {url && <audio controls src={url} aria-label="اسمع تسجيلك قبل إرساله لخدمة الصوت" className="w-full" />}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex flex-wrap gap-2">
      {phase === 'recording' ? <Button onClick={() => recorder.current?.stop()}><Square /> وقف التسجيل</Button> : <Button variant="outline" disabled={phase === 'transcribing' || !status.data?.available} onClick={start}><Mic /> {audio ? 'سجّل من جديد' : 'ابدأ التسجيل'}</Button>}
      {audio && <Button onClick={convert} disabled={phase === 'transcribing'}>{phase === 'transcribing' && <Loader2 className="animate-spin" />} حوّل لنص للمراجعة</Button>}
      <Button variant="ghost" onClick={onClose}>إلغاء ومسح التسجيل</Button>
    </div>
    <p className="text-xs text-muted-foreground">راجع خصوصًا اسم صاحب الحساب والمبلغ ويوم الحركة وميعاد السداد. بعد إرسال النص أي حركة فلوس محتاجة اعتماد مستقل.</p>
  </DialogContent></Dialog>
}
