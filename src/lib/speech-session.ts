// وكيل — EPHEMERAL SPEECH SESSIONS (PR-014 / plan v2 §11.3).
//
// «الأسرار Server-side؛ وفي Live client-to-server يستخدم backend ephemeral
// token محدود الصلاحية بدل كشف API key دائم للمتصفح»
//
// A speech session is created by an AUTHENTICATED owner request and handed
// to the voice client. It:
//   • lives 60 seconds and is single-purpose (stt only)
//   • carries the tenant + user server-side — the client never sees a
//     provider API key or a durable credential
//   • is stored in-process (a token map with expiry). One runtime process
//     serves the tenant in this deployment; a multi-process deployment moves
//     the map to the shared cache (documented, not silently assumed)
//   • cannot approve, write, or schedule anything — the text it produces
//     still goes through the normal reviewed-message + approval gates

import { randomBytes } from 'node:crypto'

/**
 * 60s default — long enough to transcribe a 4-minute clip, short enough that a
 * leaked token is useless. Read at MINT time (env overridable for tests/dev
 * tuning — a module-load const would freeze the value before test setup).
 */
export function speechSessionTtlMs(): number {
  return Number(process.env.WAKIL_SPEECH_SESSION_TTL_MS || 60_000)
}

export interface SpeechSession {
  token: string
  businessId: string
  userId: string
  expiresAt: number
}

const sessions = new Map<string, SpeechSession>()

function prune(now = Date.now()): void {
  if (sessions.size < 64) return
  for (const [k, v] of sessions) if (v.expiresAt < now) sessions.delete(k)
}

/** Create a short-lived STT session for an authenticated owner request. */
export function createSpeechSession(businessId: string, userId: string): SpeechSession {
  prune()
  const session: SpeechSession = {
    token: `wsp_${randomBytes(24).toString('hex')}`,
    businessId,
    userId,
    expiresAt: Date.now() + speechSessionTtlMs(),
  }
  sessions.set(session.token, session)
  return session
}

/** Validate a token: expired/unknown tokens are simply not sessions. */
export function validateSpeechSession(token: string): SpeechSession | null {
  const s = sessions.get(token)
  if (!s) return null
  if (s.expiresAt < Date.now()) {
    sessions.delete(token)
    return null
  }
  return s
}

export function speechSessionCount(): number {
  prune()
  return sessions.size
}
