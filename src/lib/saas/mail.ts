import type { Prisma } from '@prisma/client'
import { db } from '../db'
import { encryptProviderKey, decryptProviderKey } from '../security/provider-secrets'
import { publicFetch } from '../security/provider-network'
import { SaasError } from './crypto'

export function mailReady() {
  try {
    return new URL(process.env.WAKIL_MAIL_ENDPOINT ?? '').protocol === 'https:' &&
      new URL(process.env.WAKIL_APP_URL ?? '').protocol === 'https:' &&
      (process.env.WAKIL_MAIL_TOKEN?.length ?? 0) >= 16 && /^[a-f0-9]{64}$/i.test(process.env.WAKIL_SECRETS_KEY ?? '')
  } catch { return false }
}
export async function queueMail(tx: Prisma.TransactionClient, to: string, subject: string, text: string, expiresAt: Date) {
  if (!mailReady()) throw new SaasError('إرسال البريد غير مجهّز على الخادم بعد', 503, 'mail_not_configured')
  return tx.mailOutbox.create({ data: { payload: encryptProviderKey(JSON.stringify({ to, subject: subject.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').slice(0, 200), text })), expiresAt } })
}
export function actionLink(action: string, token: string) {
  const url = new URL(process.env.WAKIL_APP_URL!)
  url.pathname = '/'; url.search = ''; url.hash = new URLSearchParams({ action, token }).toString()
  // Fragment avoids putting one-time credentials in HTTP logs/referrers.
  return url.toString()
}
/** Delivery is at-least-once, with a stable idempotency key for the mail gateway.
 * Expired auth mail is discarded; a lost worker lease becomes retryable.
 */
type MailTransport = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; body: { cancel(): Promise<unknown> } | null }>
export async function deliverMailBatch(limit = 20, transport: MailTransport = publicFetch) {
  if (!mailReady()) throw new SaasError('إرسال البريد غير مجهّز', 503)
  const now = new Date()
  await db.$executeRaw`DELETE FROM QuotaBucket WHERE substr(id, -10) < ${new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10)}`
  await db.account.updateMany({ where: { pendingMfaAt: { lt: new Date(Date.now() - 10 * 60_000) } }, data: { pendingMfaSecret: null, pendingMfaAt: null } })
  await db.mailOutbox.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 90 * 86400_000) }, status: { in: ['sent', 'expired', 'failed'] } } })
  await db.authThrottle.deleteMany({ where: { windowAt: { lt: new Date(Date.now() - 86400_000) } } })
  await db.accountToken.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 30 * 86400_000) } } })
  await db.session.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 30 * 86400_000) } } })
  await db.mailOutbox.updateMany({ where: { status: 'sending', lockedAt: { lt: new Date(Date.now() - 5 * 60_000) } }, data: { status: 'pending', lockedAt: null } })
  await db.mailOutbox.updateMany({ where: { expiresAt: { lte: now }, status: { notIn: ['sent', 'expired'] } }, data: { status: 'expired', payload: '' } })
  await db.mailOutbox.updateMany({ where: { status: 'pending', attempts: { gte: 5 } }, data: { status: 'failed' } })
  const candidates = await db.mailOutbox.findMany({ where: { status: 'pending', nextAttemptAt: { lte: now }, expiresAt: { gt: now }, attempts: { lt: 5 } }, orderBy: { createdAt: 'asc' }, take: Math.min(limit, 50) })
  let sent = 0
  for (const message of candidates) {
    const lease = new Date()
    const claimed = await db.mailOutbox.updateMany({ where: { id: message.id, status: 'pending', attempts: message.attempts, nextAttemptAt: { lte: lease }, expiresAt: { gt: lease } }, data: { status: 'sending', lockedAt: lease, attempts: { increment: 1 } } })
    if (!claimed.count) continue
    try {
      const response = await transport(process.env.WAKIL_MAIL_ENDPOINT!, {
        method: 'POST', headers: { authorization: `Bearer ${process.env.WAKIL_MAIL_TOKEN}`, 'content-type': 'application/json', 'idempotency-key': message.id },
        body: decryptProviderKey(message.payload), signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) { await response.body?.cancel(); throw new Error('Mail delivery refused') }
      await response.body?.cancel()
      const committed = await db.mailOutbox.updateMany({ where: { id: message.id, status: 'sending', lockedAt: lease }, data: { status: 'sent', sentAt: new Date(), payload: '', lockedAt: null } })
      sent += committed.count
    } catch {
      await db.mailOutbox.updateMany({ where: { id: message.id, status: 'sending', lockedAt: lease }, data: { status: message.attempts >= 4 ? 'failed' : 'pending', lockedAt: null, nextAttemptAt: new Date(Date.now() + 60_000 * 2 ** message.attempts) } })
    }
  }
  return { processed: candidates.length, sent }
}
