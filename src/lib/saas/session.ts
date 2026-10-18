import { db } from '@/lib/db'
import type { Prisma } from '@prisma/client'
import { csrfFor, newToken, tokenHash } from './crypto'

export const saasEnabled = () => process.env.WAKIL_SAAS_ENABLED === '1'
export const sessionCookieName = () => process.env.NODE_ENV === 'production' ? '__Host-wakil_session' : 'wakil_session'
export function sessionCookie(req: Request): string | null {
  const values = (req.headers.get('cookie') ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(sessionCookieName() + '='))
  if (values.length !== 1) return null
  const token = values[0].slice(sessionCookieName().length + 1)
  return /^[a-zA-Z0-9_-]{43}$/.test(token) ? token : null
}
export function cookieHeader(token: string, expires: Date) {
  return `${sessionCookieName()}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}; Max-Age=${token ? Math.max(0, Math.floor((expires.getTime() - Date.now()) / 1000)) : 0}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`
}
export async function issueSession(tx: Prisma.TransactionClient, accountId: string, membershipId: string) {
  const token = newToken()
  const now = new Date()
  const expiresAt = new Date(Date.now() + 7 * 86400_000)
  const session = await tx.session.create({ data: { accountId, membershipId, tokenHash: tokenHash(token), createdAt: now, lastSeenAt: now, expiresAt } })
  // Bound concurrent sessions per account; oldest sessions are explicitly revoked.
  const excess = await tx.session.findMany({ where: { accountId, revokedAt: null, id: { not: session.id } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: 9, select: { id: true } })
  if (excess.length) await tx.session.updateMany({ where: { id: { in: excess.map((s) => s.id) } }, data: { revokedAt: now } })
  return { token, session, csrfToken: csrfFor(token) }
}
export async function resolveSession(req: Request) {
  if (!saasEnabled()) return null
  const token = sessionCookie(req)
  if (!token) return null
  const session = await db.session.findUnique({ where: { tokenHash: tokenHash(token) }, include: { account: true, membership: true } })
  const now = Date.now()
  if (!session || session.revokedAt || session.expiresAt.getTime() <= now || session.lastSeenAt.getTime() + 24 * 3600_000 <= now || session.account.disabledAt || session.membership.disabledAt || session.membership.accountId !== session.accountId) return null
  const user = await db.user.findUnique({ where: { id: session.membership.userId }, include: { business: true } })
  if (!user) return null
  if (session.lastSeenAt.getTime() + 5 * 60_000 < now) await db.session.updateMany({ where: { id: session.id, revokedAt: null }, data: { lastSeenAt: new Date() } })
  return { session, account: session.account, membership: session.membership, user, business: user.business, csrfToken: csrfFor(token) }
}
export type SessionIdentity = NonNullable<Awaited<ReturnType<typeof resolveSession>>>

/** Cookie writes require BOTH a same-origin browser request and a CSRF header.
 * Requests without Origin are allowed only for non-cookie API credentials.
 */
export function sessionOriginAllowed(req: Request): boolean {
  const raw = req.headers.get('origin')
  if (!raw || raw === 'null') return false
  try {
    const expected = new URL(process.env.WAKIL_APP_URL || req.url).origin
    return new URL(raw).origin === expected && req.headers.get('sec-fetch-site') !== 'cross-site'
  } catch { return false }
}
