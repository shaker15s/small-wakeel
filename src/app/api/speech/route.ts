import { NextResponse } from 'next/server'
import { guard } from '../_lib/guard'
import { readAudio, speechSelection, transcribeAudio, SpeechError } from '@/lib/speech'
import { validateSpeechSession } from '@/lib/speech-session'
export const dynamic = 'force-dynamic'

/**
 * Speech = STT into a REVIEWED draft (PR-014 / plan v2 §11.3, §12).
 *
 * Boundaries:
 *   • consent is explicit per request: header `x-wakil-audio-consent:
 *     review-only` — no header, no upload
 *   • audio is transient: the bytes are streamed to the provider and never
 *     persisted; only the returned, user-reviewed text may become a message
 *   • the voice path has NO write tool: it returns TEXT. A financial ask
 *     voiced by the owner becomes a normal reviewed message and still needs
 *     the human approval gate (P1) — voice never executes money directly
 *   • the Live client path authenticates with an EPHEMERAL session token
 *     (POST /api/speech/session, 60s, stt-only) — the browser never holds a
 *     durable credential or a provider key
 *   • cost + latency are MEASURED per call and returned (the plan: «الجودة
 *     والتكلفة معلومتان»)
 */
export async function GET(req: Request) {
  const gate = await guard(req); if (!gate.ok) return gate.res
  const selected = await speechSelection()
  return NextResponse.json({ available: !!selected, providerLabel: selected?.provider.name ?? null }, { headers: { 'Cache-Control': 'no-store' } })
}

/**
 * POST /api/speech — upload a recording → reviewed text.
 * Auth: the normal session guard OR a valid ephemeral speech token
 * (x-wakil-speech-session) — the latter is how the Live client authenticates
 * without holding a durable credential.
 */
export async function POST(req: Request) {
  const sessionToken = req.headers.get('x-wakil-speech-session')
  // tenant is established HERE and never re-read from the payload: either the
  // authenticated session guard or the mint-time binding of the ephemeral token
  let businessId: string | null = null
  if (sessionToken) {
    const session = validateSpeechSession(sessionToken)
    if (!session) return NextResponse.json({ error: 'جلسة الصوت غير صالحة أو منتهية' }, { status: 401, headers: { 'Cache-Control': 'no-store' } })
    businessId = session.businessId
  } else {
    const gate = await guard(req, { class: 'chat' }); if (!gate.ok) return gate.res
    businessId = gate.actor.business.id
  }

  if (req.headers.get('x-wakil-audio-consent') !== 'review-only') {
    return NextResponse.json({ error: 'موافقة إرسال التسجيل لخدمة تحويل الصوت مطلوبة' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
  }
  try {
    const selected = await speechSelection()
    if (!selected) throw new SpeechError('خدمة تحويل التسجيل مش متوصلة. مسؤول النظام يختار موديل صوت من الإعدادات؛ الإملاء من المتصفح والكتابة متاحين.', 503)
    const started = Date.now()
    const result = await transcribeAudio(await readAudio(req), selected, req.signal)
    const ms = Date.now() - started
    return NextResponse.json(
      { text: result.text, reviewRequired: true, ms, costUsd: result.costUsd },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof SpeechError ? error.message : 'تعذر تحويل التسجيل؛ كمّل بالكتابة' },
      { status: error instanceof SpeechError ? error.status : 500, headers: { 'Cache-Control': 'no-store' } },
    )
  }
}
