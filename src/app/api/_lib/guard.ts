// وكيل — the single gate every API route goes through.
//
// Responsibilities (in order):
//   1. identity in production; optional shared token for development demos
//   2. same-origin check for state-changing methods (CSRF)
//   3. per-IP rate limiting, per route class
//   4. tenant isolation (the user must belong to the business)
//
// Usage:
//   const gate = await guard(req, { businessId, userId, class: 'chat' })
//   if (!gate.ok) return gate.res
//   gate.actor // { business, user } — already loaded, no second round trip

import { consumeChatQuota } from '@/lib/saas/quota'
import { SaasError } from '@/lib/saas/crypto'
import { resolveSession, saasEnabled, sessionOriginAllowed } from '@/lib/saas/session'
import { safeEqual } from '@/lib/security/auth'
import { db } from '@/lib/db'
import { NextResponse } from 'next/server'
import type { Business, User } from '@prisma/client'
import {
  headerIds,
  credentialIdentity,
  identityRequired,
  type Actor,
  originAllowed,
  resolveActor,
  resolveBusiness,
  tokenAccepted,
  type ActorFailure,
} from '@/lib/security/auth'
import { canUsePermission, type Permission } from '@/lib/security/permissions'
import { clientIp, consumeRate, type RateClass } from '@/lib/security/rateLimit'

export interface GuardActorResult {
  ok: true
  actor: { business: Business; user: User }
  ip: string
  rateRemaining: number
}
export interface GuardBusinessResult {
  ok: true
  business: Business
  ip: string
  rateRemaining: number
}
export interface GuardOpenResult {
  ok: true
  principal?: Actor
  deploymentAdmin?: boolean
  ip: string
  rateRemaining: number
}
export interface GuardFailure {
  ok: false
  res: NextResponse
}

interface GuardOptions {
  permission?: Permission
  businessId?: string | null
  userId?: string | null
  /**
   * `actor`   — tenant + user isolation (default)
   * `business`— tenant isolation only (reports, exports, catalog reads)
   * `open`    — authenticated discovery (bootstrap); demo shell in development
   * `admin`   — deployment admin only in identity mode (global providers/health)
   */
  scope?: 'actor' | 'business' | 'open' | 'admin' | 'auth'
  class?: RateClass
}

function fail(status: number, message: string, extraHeaders?: Record<string, string>): GuardFailure {
  return {
    ok: false,
    res: NextResponse.json({ error: message }, { status, headers: extraHeaders }),
  }
}

function failureResponse(reason: ActorFailure): GuardFailure {
  switch (reason.kind) {
    case 'missing-ids':
      return fail(400, reason.message)
    case 'unauthorized':
      return fail(401, reason.message)
    case 'forbidden':
      return fail(403, reason.message)
    default:
      return fail(404, reason.message)
  }
}

function classify(req: Request, override?: RateClass): RateClass {
  if (override) return override
  const method = req.method.toUpperCase()
  return method === 'GET' || method === 'HEAD' ? 'read' : 'write'
}

// Overloads keep each call site's result type precise: asking for a business
// scope gives you `business`, asking for an actor gives you `actor`, and an
// open/admin scopes expose the optional authenticated principal for discovery.
export function guard(req: Request, options: GuardOptions & { scope: 'business' }): Promise<GuardBusinessResult | GuardFailure>
export function guard(req: Request, options: GuardOptions & { scope: 'open' | 'admin' | 'auth' }): Promise<GuardOpenResult | GuardFailure>
export function guard(req: Request, options?: GuardOptions): Promise<GuardActorResult | GuardFailure>
export async function guard(
  req: Request,
  options: GuardOptions = {},
): Promise<GuardActorResult | GuardBusinessResult | GuardOpenResult | GuardFailure> {
  const publicAuth = options.scope === 'auth'
  const authPath = new URL(req.url).pathname
  if (publicAuth && !/^\/api\/auth\/(config|register|login|login-mfa|request-reset|reset|verify)$/.test(authPath)) return fail(403, 'مسار دخول غير مسموح')
  const sessionIdentity = publicAuth ? null : await resolveSession(req)
  // 1. Cookie sessions or explicitly provisioned API credentials; no actor picker in SaaS mode.
  if (!publicAuth && !sessionIdentity && !tokenAccepted(req)) {
    return fail(401, 'محتاج مفتاح دخول صالح — راجع إعدادات النظام')
  }

  // 2. CSRF: browsers always send Origin on cross-site POSTs
  if (!originAllowed(req) || ((sessionIdentity || publicAuth) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !sessionOriginAllowed(req))) {
    return fail(403, 'الطلب جاي من مصدر غير مسموح')
  }

  // 3. rate limiting
  const cls = classify(req, options.class)
  const ip = clientIp(req)
  const url = new URL(req.url)
  const bucketKey = `${ip}:${cls}:${url.pathname.replace(/\/[a-z0-9]{20,}$/i, '/:id')}`
  const rate = consumeRate(bucketKey, cls)
  if (!rate.ok) {
    return fail(429, `طلبات كتير في وقت قصير — استنى ${rate.retryAfter} ثانية وجرّب تاني`, {
      'retry-after': String(rate.retryAfter),
    })
  }

  if (publicAuth) return { ok: true, ip, rateRemaining: rate.remaining }
  if (sessionIdentity && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    if (!safeEqual(req.headers.get('x-wakil-csrf') ?? '', sessionIdentity.csrfToken)) return fail(403, 'رمز حماية الطلب غير صالح')
    if (!authPath.startsWith('/api/auth/')) {
      if (!sessionIdentity.account.verifiedAt) return fail(403, 'أكد بريدك الإلكتروني قبل تعديل سجلات المنشأة')
      const sub = await db.subscription.findUnique({ where: { businessId: sessionIdentity.business.id } })
      if (!sub || !(sub.status === 'active' || (sub.status === 'trialing' && sub.trialEndsAt > new Date()))) return fail(402, 'الفترة التجريبية انتهت؛ القراءة والتصدير ما زالا متاحين')
      if (authPath === '/api/chat' && req.method === 'POST') {
        try { await consumeChatQuota(sessionIdentity.business.id) } catch (e) {
          if (e instanceof SaasError) return fail(e.status, e.message)
          throw e
        }
      }
    }
  }

  // 4. tenant isolation — ids may arrive in the body/query OR as the client's
  //    actor headers (PATCH/DELETE-by-id routes rely on the latter).
  const headers = headerIds(req)
  let businessId = options.businessId ?? headers.businessId
  let userId = options.userId ?? headers.userId
  let principal: Actor | undefined
  let deploymentAdmin = !identityRequired()

  if (identityRequired()) {
    const identity = sessionIdentity ? { userId: sessionIdentity.user.id, admin: false } : credentialIdentity(req)
    if (!identity) return fail(401, 'محتاج هوية دخول صالحة')
    const user = await db.user.findUnique({ where: { id: identity.userId }, include: { business: true } })
    if (!user) return fail(401, 'هوية الدخول لم تعد صالحة')
    if (saasEnabled()) {
      const membership = await db.membership.findUnique({ where: { userId: user.id }, include: { account: true } })
      if (membership && (membership.disabledAt || membership.account.disabledAt)) return fail(401, 'العضوية غير نشطة')
    }
    // Check ALL supplied contexts, including headers overridden by body/query.
    if ([options.businessId, headers.businessId].some((id) => id && id !== user.businessId) ||
        [options.userId, headers.userId].some((id) => id && id !== user.id)) {
      return fail(403, 'غير مسموح بانتحال مستخدم أو نشاط آخر')
    }
    principal = { user, business: user.business }
    deploymentAdmin = identity.admin === true
    businessId = user.businessId
    userId = user.id
    if (options.scope === 'admin' && !identity.admin) return fail(403, 'الإجراء ده لمدير النشر فقط')
  }

  if (options.permission) {
    const actor = principal ? { actor: principal } : await resolveActor(businessId, userId)
    if ('failure' in actor && actor.failure) return failureResponse(actor.failure)
    if (!actor.actor || !canUsePermission(actor.actor.user.role, options.permission)) {
      return fail(403, 'صلاحيتك مش بتسمح بالإجراء ده')
    }
  }

  if (options.scope === 'open' || options.scope === 'admin') {
    // Discovery/admin resource; production identity was resolved above.
    return { ok: true, ip, rateRemaining: rate.remaining, principal, deploymentAdmin }
  }

  if (options.scope === 'business') {
    const resolved = await resolveBusiness(businessId)
    if (resolved.failure) return failureResponse(resolved.failure)
    return { ok: true, business: resolved.business, ip, rateRemaining: rate.remaining }
  }

  const resolved = await resolveActor(businessId, userId)
  if (resolved.failure) return failureResponse(resolved.failure)
  return { ok: true, actor: resolved.actor, ip, rateRemaining: rate.remaining }
}
