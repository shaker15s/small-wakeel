import { NextResponse } from 'next/server'
import { guard } from '../_lib/guard'
import { readAudio, speechSelection, transcribeAudio, SpeechError } from '@/lib/speech'
export const dynamic = 'force-dynamic'
export async function GET(req: Request) {
  const gate = await guard(req); if (!gate.ok) return gate.res
  const selected = await speechSelection()
  return NextResponse.json({ available: !!selected, providerLabel: selected?.provider.name ?? null }, { headers: { 'Cache-Control': 'no-store' } })
}
export async function POST(req: Request) {
  const gate = await guard(req, { class: 'chat' }); if (!gate.ok) return gate.res
  if (req.headers.get('x-wakil-audio-consent') !== 'review-only') return NextResponse.json({ error: 'موافقة إرسال التسجيل لخدمة تحويل الصوت مطلوبة' }, { status: 400 })
  try {
    const selected = await speechSelection()
    if (!selected) throw new SpeechError('خدمة تحويل التسجيل مش متوصلة. مسؤول النظام يختار موديل صوت من الإعدادات؛ الإملاء من المتصفح والكتابة متاحين.', 503)
    const text = await transcribeAudio(await readAudio(req), selected, req.signal)
    return NextResponse.json({ text, reviewRequired: true }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return NextResponse.json({ error: error instanceof SpeechError ? error.message : 'تعذر تحويل التسجيل؛ كمّل بالكتابة' }, { status: error instanceof SpeechError ? error.status : 500, headers: { 'Cache-Control': 'no-store' } })
  }
}
