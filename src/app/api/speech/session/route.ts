// POST /api/speech/session — mint an EPHEMERAL STT token (PR-014 / plan §11.3).
//
// The Live client-to-server path must not hold a durable credential or a
// provider key: an authenticated owner request mints a 60-second, stt-only
// token that the voice client presents as x-wakil-speech-session.
import { NextResponse } from 'next/server'
import { guard } from '../../_lib/guard'
import { badRequest, serverError } from '../../_lib/http'
import { createSpeechSession } from '@/lib/speech-session'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { businessId?: string }
    if (!body.businessId) return badRequest('businessId مطلوب')
    // same scope as the audio upload itself: any authenticated business user
    const gate = await guard(req, { businessId: body.businessId, class: 'chat' })
    if (!gate.ok) return gate.res
    const session = createSpeechSession(gate.actor.business.id, gate.actor.user.id)
    return NextResponse.json(
      { token: session.token, scope: 'stt', expiresAt: new Date(session.expiresAt).toISOString() },
      { status: 201 },
    )
  } catch (e) {
    return serverError('speech-session', e)
  }
}
