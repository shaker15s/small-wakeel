'use client'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import type { ProviderDTO } from '@/lib/types'

export function SpeechSettings({ providers }: { providers: ProviderDTO[] }) {
  const qc = useQueryClient()
  const settings = useQuery({ queryKey: ['speech-settings'], queryFn: api.speechSettings })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const options = providers.flatMap(p => p.models.filter(m => m.enabled).map(m => ({ providerId: p.id, remoteId: m.remoteId, label: `${p.name} · ${m.label}` })))
  const selected = options.findIndex(o => o.providerId === settings.data?.providerId && o.remoteId === settings.data?.remoteId)
  async function save(index: number) {
    setBusy(true); setMessage('')
    try {
      await api.saveSpeechSettings(index < 0 ? { disabled: true } : { providerId: options[index].providerId, remoteId: options[index].remoteId })
      await qc.invalidateQueries({ queryKey: ['speech-settings'] }); await qc.invalidateQueries({ queryKey: ['speech-status'] })
      setMessage(index < 0 ? 'تحويل التسجيل متوقف؛ الإملاء من المتصفح مستقل.' : 'حفظت الاختيار. جرّب تسجيل حقيقي؛ الاختيار وحده مش دليل إن الموديل بيدعم الصوت.')
    } catch (e) { setMessage(e instanceof Error ? e.message : 'تعذر حفظ الاختيار') } finally { setBusy(false) }
  }
  return <section className="space-y-3 rounded-2xl border bg-card p-4" aria-labelledby="speech-setting-title">
    <h2 id="speech-setting-title" className="font-semibold">تحويل التسجيل الصوتي لنص</h2>
    <p className="text-sm leading-6 text-muted-foreground">اختار موديل بيدعم فعلًا <bdi className="font-mono">/audio/transcriptions</bdi> من مزوّدك. موديلات الشات مش بالضرورة تدعم صوت. المفتاح محفوظ على السيرفر، والتسجيل بيتبعت بس بعد موافقة المستخدم.</p>
    <label className="block text-sm" htmlFor="speech-model">موديل الصوت</label>
    <select id="speech-model" className="min-h-11 w-full min-w-0 rounded-xl border bg-background px-3 text-sm" value={selected} disabled={busy || settings.isPending} onChange={e => save(Number(e.target.value))}>
      <option value={-1}>متوقف · استخدم الإملاء من المتصفح أو الكتابة</option>
      {options.map((o, i) => <option key={`${o.providerId}:${o.remoteId}`} value={i}>{o.label}</option>)}
    </select>
    {settings.isError && <Button variant="outline" onClick={() => settings.refetch()}>إعادة تحميل إعداد الصوت</Button>}
    {message && <p role="status" className="text-sm">{message}</p>}
  </section>
}
