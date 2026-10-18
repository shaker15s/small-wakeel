// وكيل — request authentication & tenant isolation.
//
// Development demo mode trusts the actor picker. Production never does:
// server-configured, hashed per-user credentials bind every request to a DB user.
// This is a pilot API credential mechanism, not a hosted identity provider.

import { createHash } from 'node:crypto'
import { db } from '@/lib/db'
import type { Business, User } from '@prisma/client'

export interface Actor {
  business: Business
  user: User
}

export type ActorFailure =
  | { kind: 'missing-ids'; message: string }
  | { kind: 'unauthorized'; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'not-found'; message: string }

/** Constant-time string compare (length-safe). */
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const ab = enc.encode(a)
  const bb = enc.encode(b)
  // Compare a fixed number of bytes by folding lengths in — never early-exit
  // on the first difference.
  let diff = ab.length ^ bb.length
  const len = Math.max(ab.length, bb.length, 1)
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0)
  }
  return diff === 0
}

function tokenFromRequest(req: Request, headerOnly = false): string | null {
  const auth = req.headers.get('authorization')
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()
  const header = req.headers.get('x-wakil-token')
  if (header?.trim()) return header.trim()
  if (headerOnly) return null
  try {
    const url = new URL(req.url)
    const q = url.searchParams.get('token')
    if (q?.trim()) return q.trim()
  } catch {
    // ignore malformed URLs — the route handlers parse them separately
  }
  const cookie = req.headers.get('cookie') ?? ''
  const match = /(?:^|;\s*)wakil_token=([^;]+)/.exec(cookie)
  if (match) {
    try { return decodeURIComponent(match[1]) } catch { return null }
  }
  return null
}

/**
 * Actor ids carried as headers by the web client (`x-wakil-business`,
 * `x-wakil-user`). The fetch layer attaches them to EVERY request, so
 * handlers that only receive an object id (PATCH/DELETE by id) can still prove
 * which tenant the caller belongs to without changing a single call site.
 */
export function headerIds(req: Request): { businessId: string | null; userId: string | null } {
  return {
    businessId: req.headers.get('x-wakil-business')?.trim() || null,
    userId: req.headers.get('x-wakil-user')?.trim() || null,
  }
}

export interface CredentialIdentity {
  userId: string
  admin: boolean
}

/** Production always requires identity; configuring credentials also enables it in dev. */
export function identityRequired(): boolean {
  return process.env.WAKIL_SAAS_ENABLED === '1' || process.env.NODE_ENV === 'production' || process.env.WAKIL_AUTH_CREDENTIALS !== undefined
}

/** Never accept IDs, roles, shared demo tokens, query strings or cookies as identity. */
export function credentialIdentity(req: Request): CredentialIdentity | null {
  const token = tokenFromRequest(req, true)
  if (!token || token.length < 32) return null
  try {
    const entries: unknown = JSON.parse(process.env.WAKIL_AUTH_CREDENTIALS ?? 'null')
    if (!Array.isArray(entries) || entries.length === 0) return null
    if (!entries.every((e) => e && typeof e.userId === 'string' && e.userId.length > 0 &&
      typeof e.tokenHash === 'string' && /^[a-f0-9]{64}$/.test(e.tokenHash) &&
      (e.admin === undefined || typeof e.admin === 'boolean'))) return null
    const digest = createHash('sha256').update(token).digest('hex')
    const matches = entries.filter((e) => safeEqual(e.tokenHash, digest))
    if (matches.length !== 1) return null
    return { userId: matches[0].userId, admin: matches[0].admin === true }
  } catch {
    return null // invalid / absent configuration is fail-closed
  }
}

/** Demo access shell is never sufficient in production. */
export function tokenAccepted(req: Request): boolean {
  if (identityRequired()) return credentialIdentity(req) !== null
  const expected = process.env.WAKIL_ACCESS_TOKEN?.trim()
  if (!expected) return true
  const provided = tokenFromRequest(req)
  return provided != null && safeEqual(provided, expected)
}

/** Same-origin check for state-changing requests (CSRF defence). */
export function originAllowed(req: Request): boolean {
  const method = req.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true
  const origin = req.headers.get('origin')
  // Non-browser clients (curl, the scheduler, tests) send no Origin header.
  if (!origin) return true
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? ''
  const extra = (process.env.WAKIL_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  try {
    const originHost = new URL(origin).host
    if (host && originHost === host) return true
    return extra.some((allowed) => {
      try {
        return new URL(allowed).host === originHost
      } catch {
        return allowed === originHost
      }
    })
  } catch {
    return false
  }
}

/**
 * Load the actor for a request and prove the user belongs to the business.
 * Returns `null` only when the caller may proceed; otherwise the reason.
 */
export async function resolveActor(
  businessId: string | null | undefined,
  userId: string | null | undefined,
): Promise<{ actor: Actor; failure?: undefined } | { actor?: undefined; failure: ActorFailure }> {
  if (!businessId) return { failure: { kind: 'missing-ids', message: 'businessId مطلوب' } }
  if (!userId) return { failure: { kind: 'missing-ids', message: 'userId مطلوب' } }

  const [business, user] = await Promise.all([
    db.business.findUnique({ where: { id: businessId } }),
    db.user.findUnique({ where: { id: userId } }),
  ])
  if (!business) return { failure: { kind: 'not-found', message: 'النشاط التجاري غير موجود' } }
  if (!user) return { failure: { kind: 'not-found', message: 'المستخدم غير موجود' } }
  // THE isolation check: ids are client-supplied, membership is not optional.
  if (user.businessId !== business.id) {
    return { failure: { kind: 'forbidden', message: 'المستخدم ده مش تابع للنشاط ده' } }
  }
  return { actor: { business, user } }
}

/**
 * Business-only variant for routes that legitimately have no user context
 * (reports, radar, provider management, exports).
 */
export async function resolveBusiness(
  businessId: string | null | undefined,
): Promise<{ business: Business; failure?: undefined } | { business?: undefined; failure: ActorFailure }> {
  if (!businessId) return { failure: { kind: 'missing-ids', message: 'businessId مطلوب' } }
  const business = await db.business.findUnique({ where: { id: businessId } })
  if (!business) return { failure: { kind: 'not-found', message: 'النشاط التجاري غير موجود' } }
  return { business }
}
