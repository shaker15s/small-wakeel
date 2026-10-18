import { VERTICAL_PRESETS } from '@/lib/verticals'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import { testDb } from '../helpers/test-db'
import { POST, GET } from '@/app/api/auth/[action]/route'
import { GET as bootstrap } from '@/app/api/bootstrap/route'
import { GET as morningBrief } from '@/app/api/morning-brief/route'
import { GET as backgroundRead } from '@/app/api/background-tasks/route'
import { buildMorningBrief } from '@/lib/agent/brief'
import { scanRisksAndOpportunities } from '@/lib/agent/task-engine'
import { POST as chat } from '@/app/api/chat/route'
import { guard } from '@/app/api/_lib/guard'
import { resetRateLimiter } from '@/lib/security/rateLimit'
import { decryptProviderKey } from '@/lib/security/provider-secrets'
import { register, authenticatedAction, login, loginMfa, requestReset, resetPassword, verifyEmail } from '@/lib/saas/service'
import { resolveSession, cookieHeader, sessionCookieName } from '@/lib/saas/session'
import { hashPassword, matchTotp, SaasError, tokenHash, totp, verifyPassword } from '@/lib/saas/crypto'
import { createDraft } from '@/lib/domain/executors'

const original = { ...process.env }
const password = 'A long unique passphrase! 742'
const appUrl = 'https://wakil.test'
const prefix = `saas-${randomUUID()}`
let db: Awaited<ReturnType<typeof testDb>>
const created: string[] = []
function request(action: string, body?: object, token?: string, csrf?: string, overrides: Record<string, string> = {}) {
  return new NextRequest(`${appUrl}/api/auth/${action}`, { method: body === undefined ? 'GET' : 'POST', headers: {
    host: 'wakil.test', origin: appUrl, 'content-type': 'application/json', 'x-forwarded-for': randomUUID(),
    ...(token ? { cookie: `${sessionCookieName()}=${token}` } : {}), ...(csrf ? { 'x-wakil-csrf': csrf } : {}), ...overrides,
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
const call = (action: string, body: object, token?: string, csrf?: string, headers?: Record<string, string>) => POST(request(action, body, token, csrf, headers), { params: Promise.resolve({ action }) })
const get = (action: string, token?: string) => GET(request(action, undefined, token), { params: Promise.resolve({ action }) })
async function fixture(verified = true) {
  const email = `${prefix}-${randomUUID()}@example.test`
  const issued = await register({ email, password, name: 'مالك', businessName: prefix, type: 'supermarket' }, randomUUID())
  created.push(issued.session.accountId)
  if (verified) await db.account.update({ where: { id: issued.session.accountId }, data: { verifiedAt: new Date() } })
  const identity = (await resolveSession(request('me', undefined, issued.token)))!
  return { ...issued, identity, email }
}
async function mailToken(email: string, action: string) {
  const messages = await db.mailOutbox.findMany({ orderBy: { createdAt: 'desc' } })
  for (const row of messages) {
    if (!row.payload) continue
    const payload = JSON.parse(decryptProviderKey(row.payload))
    if (payload.to !== email) continue
    const params = new URLSearchParams(new URL(payload.text).hash.slice(1))
    if (params.get('action') === action) return params.get('token')!
  }
  throw new Error('Expected encrypted auth mail')
}
beforeAll(async () => { db = await testDb() })
beforeEach(() => {
  Object.assign(process.env, { NODE_ENV: 'production', WAKIL_SAAS_ENABLED: '1', WAKIL_SIGNUP_ENABLED: '1', WAKIL_APP_URL: appUrl, WAKIL_SECRETS_KEY: '7a'.repeat(32), WAKIL_MAIL_ENDPOINT: 'https://mail.example.test/send', WAKIL_MAIL_TOKEN: 'test-only-mail-credential-not-real' })
  delete process.env.WAKIL_AUTH_CREDENTIALS
})
afterEach(() => {
  for (const key of ['NODE_ENV', 'WAKIL_SAAS_ENABLED', 'WAKIL_SIGNUP_ENABLED', 'WAKIL_APP_URL', 'WAKIL_SECRETS_KEY', 'WAKIL_MAIL_ENDPOINT', 'WAKIL_MAIL_TOKEN', 'WAKIL_AUTH_CREDENTIALS']) {
    if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]
  }
  resetRateLimiter()
})
afterAll(async () => {
  await db.business.deleteMany({ where: { name: prefix } })
  await db.account.deleteMany({ where: { id: { in: created } } })
})

test('password hashing is salted, constant-work for missing users, and never plaintext', async () => {
  const a = await hashPassword(password), b = await hashPassword(password)
  expect(a).not.toBe(b); expect(a).not.toContain(password)
  expect(await verifyPassword(password, a)).toBe(true)
  expect(await verifyPassword('wrong', a)).toBe(false)
  expect(await verifyPassword(password, null)).toBe(false)
  await expect(hashPassword('123456789012345')).rejects.toBeInstanceOf(SaasError)
})
test('TOTP agrees with the RFC 6238 vector and rejects replay', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
  expect(totp(secret, 1)).toBe('287082')
  expect(matchTotp(secret, '287082', -1, 59_000)).toBe(1)
  expect(matchTotp(secret, '287082', 1, 59_000)).toBeNull()
})
test('registration creates a blank isolated tenant, encrypted mail and a hashed HttpOnly session', async () => {
  const email = `${prefix}-${randomUUID()}@example.test`
  const response = await call('register', { email, password, name: 'مالك', businessName: prefix })
  expect(response.status).toBe(200)
  const cookie = response.headers.get('set-cookie')!
  expect(cookie).toContain('__Host-wakil_session='); expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('Secure'); expect(cookie).toContain('SameSite=Lax')
  const body = await response.json()
  expect(body.token).toBeUndefined(); expect(body.csrfToken).toHaveLength(43)
  const account = await db.account.findUniqueOrThrow({ where: { email } }); created.push(account.id)
  expect(account.verifiedAt).toBeNull()
  const member = await db.membership.findFirstOrThrow({ where: { accountId: account.id }, include: { user: true } })
  expect(await db.item.count({ where: { businessId: member.user.businessId } })).toBe(0)
  expect(await db.operation.count({ where: { businessId: member.user.businessId } })).toBe(0)
  expect((await db.business.findUniqueOrThrow({ where: { id: member.user.businessId } })).openingCash).toBe(0)
  const raw = cookie.split(';')[0].split('=')[1]
  expect(await db.session.findUnique({ where: { tokenHash: tokenHash(raw) } })).not.toBeNull()
  expect(await db.session.findUnique({ where: { tokenHash: raw } })).toBeNull()
  expect(JSON.stringify(await db.mailOutbox.findMany())).not.toContain(email)
})
test('native signup supports all nine business presets with empty real ledgers, and rejects unknown types atomically', async () => {
  for (const preset of VERTICAL_PRESETS) {
    const email = `${prefix}-${randomUUID()}@example.test`
    const issued = await register({ email, password, name: 'مالك', businessName: prefix, type: preset.key }, randomUUID())
    created.push(issued.session.accountId)
    const membership = await db.membership.findFirstOrThrow({ where: { accountId: issued.session.accountId }, include: { user: { include: { business: true } } } })
    expect(membership.user.business.type).toBe(preset.key)
    expect(membership.user.business.openingCash).toBe(0)
    expect(await db.item.count({ where: { businessId: membership.user.businessId } })).toBe(0)
  }
  const email = `${prefix}-${randomUUID()}@example.test`
  await expect(register({ email, password, name: 'مالك', businessName: prefix, type: 'unregistered-type' }, randomUUID())).rejects.toBeInstanceOf(SaasError)
  expect(await db.account.count({ where: { email } })).toBe(0)
})
test('simultaneous normalized-email signup creates one account/workspace/session/mail and no orphan tenant', async () => {
  const email = `${prefix}-${randomUUID()}@example.test`
  const businessesBefore = await db.business.count({ where: { name: prefix } })
  const mailBefore = await db.mailOutbox.count()
  const responses = await Promise.all([
    call('register', { email, password, name: 'Owner one', businessName: prefix }),
    call('register', { email: `  ${email.toUpperCase()}  `, password, name: 'Owner two', businessName: prefix }),
  ])
  const account = await db.account.findUnique({ where: { email } })
  if (account) created.push(account.id)
  expect(responses.map((r) => r.status).sort()).toEqual([200, 409])
  expect(account).not.toBeNull()
  expect(await db.account.count({ where: { email } })).toBe(1)
  expect(await db.business.count({ where: { name: prefix } })).toBe(businessesBefore + 1)
  const memberships = await db.membership.findMany({ where: { accountId: account!.id }, include: { user: true } })
  expect(memberships).toHaveLength(1)
  const businessId = memberships[0].user.businessId
  expect(await db.user.count({ where: { businessId } })).toBe(1)
  expect(await db.subscription.count({ where: { businessId } })).toBe(1)
  expect(await db.session.count({ where: { accountId: account!.id } })).toBe(1)
  expect(await db.accountToken.count({ where: { accountId: account!.id, purpose: 'verify' } })).toBe(1)
  expect(await db.mailOutbox.count()).toBe(mailBefore + 1)
  const failure = responses.find((r) => r.status === 409)!
  expect(failure.headers.get('set-cookie')).toBeNull()
  expect(JSON.stringify(await failure.json())).not.toMatch(/passwordHash|P2002|Unique constraint|tokenHash/)
})
test('SaaS guard accepts no demo actor picker, and public auth requires strict same-origin', async () => {
  expect((await get('me')).status).toBe(401)
  expect((await call('login', { email: 'nobody@example.test', password }, undefined, undefined, { origin: 'https://evil.test' })).status).toBe(403)
  expect((await call('login', { email: 'nobody@example.test', password }, undefined, undefined, { origin: 'null' })).status).toBe(403)
  const bypass = await guard(new Request(`${appUrl}/api/export`), { scope: 'auth' })
  expect(bypass.ok).toBe(false)
})
test('unverified accounts cannot mutate business truth; verification tokens are one-time', async () => {
  const f = await fixture(false)
  const req = new NextRequest(`${appUrl}/api/chat`, { method: 'POST', headers: { host: 'wakil.test', origin: appUrl, cookie: `${sessionCookieName()}=${f.token}`, 'x-wakil-csrf': f.csrfToken }, body: JSON.stringify({ businessId: f.identity.business.id, userId: f.identity.user.id, text: 'ضيف مصروف 10 جنيه' }) })
  expect((await chat(req)).status).toBe(403)
  const token = await mailToken(f.email, 'verify')
  expect((await call('verify', { token })).status).toBe(200)
  expect((await call('verify', { token })).status).toBe(400)
  expect((await db.account.findUniqueOrThrow({ where: { id: f.identity.account.id } })).verifiedAt).not.toBeNull()
})
test('cookie writes require CSRF and Origin; header/body tenant spoofing is refused', async () => {
  const f = await fixture(), other = await fixture()
  expect((await call('logout', {}, f.token)).status).toBe(403)
  expect((await call('logout', {}, f.token, f.csrfToken, { origin: 'https://evil.test' })).status).toBe(403)
  expect((await call('logout', {}, f.token, f.csrfToken, { 'x-wakil-business': other.identity.business.id })).status).toBe(403)
  const result = await bootstrap(new NextRequest(`${appUrl}/api/bootstrap`, { headers: { cookie: `${sessionCookieName()}=${f.token}` } }))
  expect(result.status).toBe(200)
  const data = await result.json(); expect(data.businesses.map((b: { id: string }) => b.id)).toEqual([f.identity.business.id])
  expect((await get('me', f.token)).status).toBe(200)
})
test('logout revokes server-side immediately and closes the cookie', async () => {
  const f = await fixture()
  const response = await call('logout', {}, f.token, f.csrfToken)
  expect(response.status).toBe(200); expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
  expect((await get('me', f.token)).status).toBe(401)
})
test('logout-all invalidates every device but not a different account', async () => {
  const f = await fixture(), other = await fixture()
  const second = await login({ email: f.email, password }, randomUUID())
  expect('token' in second).toBe(true)
  expect((await call('logout-all', {}, f.token, f.csrfToken)).status).toBe(200)
  if ('token' in second) expect((await get('me', second.token)).status).toBe(401)
  expect((await get('me', other.token)).status).toBe(200)
})
test('absolute expiry and idle expiry both invalidate sessions', async () => {
  const a = await fixture(), b = await fixture()
  await db.session.update({ where: { id: a.session.id }, data: { expiresAt: new Date(Date.now() - 1) } })
  await db.session.update({ where: { id: b.session.id }, data: { lastSeenAt: new Date(Date.now() - 25 * 3600_000) } })
  expect((await get('me', a.token)).status).toBe(401); expect((await get('me', b.token)).status).toBe(401)
})
test('reset responses do not enumerate users; tokens are one-time and reset revokes all sessions', async () => {
  const f = await fixture()
  const a = await requestReset({ email: f.email }, randomUUID()), b = await requestReset({ email: 'not-an-account@example.test' }, randomUUID())
  expect(a).toEqual(b)
  const token = await mailToken(f.email, 'reset')
  await resetPassword({ token, password: 'A different passphrase! 843' }, randomUUID())
  expect((await get('me', f.token)).status).toBe(401)
  await expect(resetPassword({ token, password }, randomUUID())).rejects.toBeInstanceOf(SaasError)
  await expect(login({ email: f.email, password }, randomUUID())).rejects.toBeInstanceOf(SaasError)
  expect('token' in await login({ email: f.email.toUpperCase(), password: 'A different passphrase! 843' }, randomUUID())).toBe(true)
})
test('workspace creation/switch rotates the session and never accepts a foreign membership', async () => {
  const f = await fixture(), other = await fixture()
  const switched = await authenticatedAction('create-workspace', { businessName: prefix, type: 'gym' }, f.identity)
  expect('token' in switched).toBe(true)
  expect((await get('me', f.token)).status).toBe(401)
  if (!('token' in switched)) throw new Error('Expected session')
  const identity = (await resolveSession(request('me', undefined, switched.token)))!
  expect(identity.business.id).not.toBe(f.identity.business.id)
  await expect(authenticatedAction('switch', { membershipId: other.identity.membership.id }, identity)).rejects.toBeInstanceOf(SaasError)
  const back = await authenticatedAction('switch', { membershipId: f.identity.membership.id }, identity)
  expect('token' in back).toBe(true)
})
test('invites are email-bound, single-use, and staff cannot invite or gain owner role', async () => {
  const owner = await fixture(), staff = await fixture(), wrong = await fixture()
  await authenticatedAction('invite', { email: staff.email, role: 'cashier' }, owner.identity)
  const token = await mailToken(staff.email, 'invite')
  await expect(authenticatedAction('accept-invite', { token }, wrong.identity)).rejects.toBeInstanceOf(SaasError)
  const accepted = await authenticatedAction('accept-invite', { token }, staff.identity)
  if (!('token' in accepted)) throw new Error('Expected session')
  const identity = (await resolveSession(request('me', undefined, accepted.token)))!
  expect(identity.user.role).toBe('cashier'); expect(identity.business.id).toBe(owner.identity.business.id)
  await expect(authenticatedAction('invite', { email: wrong.email, role: 'supervisor' }, identity)).rejects.toBeInstanceOf(SaasError)
  await expect(authenticatedAction('invite', { email: wrong.email, role: 'owner' }, owner.identity)).rejects.toBeInstanceOf(SaasError)
  await expect(authenticatedAction('accept-invite', { token }, identity)).rejects.toBeInstanceOf(SaasError)
})
test('member role changes and suspension revoke linked sessions; owner cannot be removed', async () => {
  const owner = await fixture(), employee = await fixture()
  await authenticatedAction('invite', { email: employee.email, role: 'supervisor' }, owner.identity)
  const accepted = await authenticatedAction('accept-invite', { token: await mailToken(employee.email, 'invite') }, employee.identity)
  if (!('token' in accepted)) throw new Error('Expected session')
  const identity = (await resolveSession(request('me', undefined, accepted.token)))!
  await authenticatedAction('member-update', { userId: identity.user.id, role: 'cashier', disabled: 'true' }, owner.identity)
  expect((await get('me', accepted.token)).status).toBe(401)
  await expect(createDraft({ businessId: identity.business.id, userId: identity.user.id, type: 'sale', summary: '', payload: {}, idempotencyKey: randomUUID() })).rejects.toThrow()
  await expect(authenticatedAction('member-update', { userId: owner.identity.user.id, disabled: 'true' }, owner.identity)).rejects.toBeInstanceOf(SaasError)
})
test('pending invites reserve seats atomically; concurrent invites cannot exceed the plan', async () => {
  const owner = await fixture()
  await db.subscription.update({ where: { businessId: owner.identity.business.id }, data: { seatLimit: 2 } })
  const results = await Promise.allSettled([1, 2].map((n) => authenticatedAction('invite', { email: `${prefix}-${n}@example.test`, role: 'cashier' }, owner.identity)))
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(await db.invitation.count({ where: { businessId: owner.identity.business.id, revokedAt: null } })).toBe(1)
})
test('expired trial is read-only and cannot bypass the limit through direct domain calls', async () => {
  const f = await fixture()
  await db.subscription.update({ where: { businessId: f.identity.business.id }, data: { trialEndsAt: new Date(Date.now() - 1) } })
  const request = new NextRequest(`${appUrl}/api/chat`, { method: 'POST', headers: { host: 'wakil.test', origin: appUrl, cookie: `${sessionCookieName()}=${f.token}`, 'x-wakil-csrf': f.csrfToken } })
  const denied = await guard(request)
  expect(denied.ok).toBe(false); if (!denied.ok) expect(denied.res.status).toBe(402)
  expect((await get('me', f.token)).status).toBe(200)
  await expect(createDraft({ businessId: f.identity.business.id, userId: f.identity.user.id, type: 'expense', payload: { total: 100 }, summary: '', idempotencyKey: randomUUID() })).rejects.toThrow()
  const readonly = (path: string) => new NextRequest(`${appUrl}/api/${path}?businessId=${f.identity.business.id}&userId=${f.identity.user.id}`, { headers: { host: 'wakil.test', cookie: `${sessionCookieName()}=${f.token}` } })
  expect((await morningBrief(readonly('morning-brief'))).status).toBe(200)
  expect((await backgroundRead(readonly('background-tasks'))).status).toBe(200)
  await db.membership.update({ where: { id: f.identity.membership.id }, data: { disabledAt: new Date() } })
  expect((await morningBrief(readonly('morning-brief'))).status).toBe(401)
  expect((await backgroundRead(readonly('background-tasks'))).status).toBe(401)
  await expect(buildMorningBrief(f.identity.business.id, f.identity.user.id)).rejects.toThrow()
  await expect(scanRisksAndOpportunities(f.identity.business.id, f.identity.user.id)).rejects.toThrow()
})
test('MFA setup proves possession, encrypts secret, and login needs a one-time challenge/code', async () => {
  const f = await fixture()
  const setup = await authenticatedAction('mfa-setup', { currentPassword: password }, f.identity)
  if (!('secret' in setup) || !setup.secret) throw new Error('Expected MFA secret')
  expect(setup.secret).toHaveLength(32)
  const enabled = await authenticatedAction('mfa-enable', { currentPassword: password, code: totp(setup.secret, Math.floor(Date.now() / 30_000)) }, f.identity)
  if (!('recoveryCodes' in enabled) || !enabled.recoveryCodes) throw new Error('Expected recovery codes')
  expect(enabled.recoveryCodes).toHaveLength(10)
  const account = await db.account.findUniqueOrThrow({ where: { id: f.identity.account.id } })
  expect(account.mfaSecret).toStartWith('wakil:v1:'); expect(account.recoveryHashes).not.toContain(enabled.recoveryCodes[0])
  const challenge = await login({ email: f.email, password }, randomUUID())
  if (!('challenge' in challenge)) throw new Error('MFA must not issue a session yet')
  await expect(loginMfa({ token: challenge.challenge, code: '000000' }, randomUUID())).rejects.toBeInstanceOf(SaasError)
  const device = await loginMfa({ token: challenge.challenge, code: enabled.recoveryCodes[0] }, randomUUID())
  expect((await get('me', device.token)).status).toBe(200)
  await expect(loginMfa({ token: challenge.challenge, code: enabled.recoveryCodes[1] }, randomUUID())).rejects.toBeInstanceOf(SaasError)
  const second = await login({ email: f.email, password }, randomUUID())
  if (!('challenge' in second)) throw new Error('Expected MFA')
  await expect(loginMfa({ token: second.challenge, code: enabled.recoveryCodes[0] }, randomUUID())).rejects.toBeInstanceOf(SaasError)
})
test('persistent login throttling survives the in-memory limiter reset', async () => {
  const email = `${prefix}-blocked@example.test`, ip = randomUUID()
  for (let i = 0; i < 10; i++) await expect(login({ email, password: 'wrong' }, ip)).rejects.toBeInstanceOf(SaasError)
  resetRateLimiter()
  try { await login({ email, password: 'wrong' }, ip); throw new Error('Expected throttling') } catch (e) { expect((e as SaasError).status).toBe(429) }
})
test('expired/revoked verification links fail, and GET never consumes security links', async () => {
  const f = await fixture(false), token = await mailToken(f.email, 'verify')
  await db.accountToken.update({ where: { tokenHash: tokenHash(token) }, data: { expiresAt: new Date(Date.now() - 1) } })
  await expect(verifyEmail({ token })).rejects.toBeInstanceOf(SaasError)
  expect((await get('verify')).status).toBe(401)
})

test('daily tenant chat quota is persistent, atomic under contention, and isolated', async () => {
  const { consumeChatQuota, quotaKey } = await import('@/lib/saas/quota')
  const f = await fixture(), other = await fixture()
  await db.subscription.update({ where: { businessId: f.identity.business.id }, data: { dailyChatLimit: 2 } })
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => consumeChatQuota(f.identity.business.id)))
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2)
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(4)
  expect((await db.quotaBucket.findUniqueOrThrow({ where: { id: quotaKey(f.identity.business.id) } })).used).toBe(2)
  await consumeChatQuota(other.identity.business.id)
  expect((await db.quotaBucket.findUniqueOrThrow({ where: { id: quotaKey(other.identity.business.id) } })).used).toBe(1)
})
test('operator subscriptions require deployment admin, not account ownership or a body flag', async () => {
  const { POST: operator } = await import('@/app/api/admin/subscriptions/route')
  const f = await fixture()
  const body = { businessId: f.identity.business.id, plan: 'manual', status: 'active', trialEndsAt: new Date().toISOString(), seatLimit: 5, dailyChatLimit: 100, reason: 'Synthetic operator contract', admin: true }
  const req = (token: string, cookie = false) => new Request(`${appUrl}/api/admin/subscriptions`, { method: 'POST', headers: { origin: appUrl, host: 'wakil.test', 'content-type': 'application/json', ...(cookie ? { cookie: `${sessionCookieName()}=${token}`, 'x-wakil-csrf': f.csrfToken } : { authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) })
  expect((await operator(req(f.token, true))).status).toBe(403)
  const operatorToken = 'test-operator-token-not-real-at-least-32-chars'
  process.env.WAKIL_AUTH_CREDENTIALS = JSON.stringify([{ userId: f.identity.user.id, tokenHash: tokenHash(operatorToken), admin: true }])
  const response = await operator(req(operatorToken))
  expect(response.status).toBe(200)
  expect((await response.json()).paymentProcessed).toBe(false)
  expect((await db.subscription.findUniqueOrThrow({ where: { businessId: f.identity.business.id } })).dailyChatLimit).toBe(100)
  expect(await db.auditEvent.count({ where: { businessId: f.identity.business.id, action: 'saas.subscription.operator_updated' } })).toBe(1)
})
test('a newly issued session survives the ten-device cap even with timestamp ties', async () => {
  const { issueSession } = await import('@/lib/saas/session')
  const f = await fixture()
  let last = f
  for (let i = 0; i < 12; i++) last = { ...f, ...await db.$transaction((tx) => issueSession(tx, f.identity.account.id, f.identity.membership.id)) }
  expect(await db.session.count({ where: { accountId: f.identity.account.id, revokedAt: null } })).toBe(10)
  expect(await resolveSession(request('me', undefined, last.token))).not.toBeNull()
})
test('reactivation cannot consume seats already reserved by pending invitations', async () => {
  const f = await fixture(), employee = await fixture()
  await authenticatedAction('invite', { email: employee.email, role: 'cashier' }, f.identity)
  await authenticatedAction('accept-invite', { token: await mailToken(employee.email, 'invite') }, employee.identity)
  const member = await db.membership.findFirstOrThrow({ where: { accountId: employee.identity.account.id, user: { businessId: f.identity.business.id } } })
  await authenticatedAction('member-update', { userId: member.userId, disabled: 'true' }, f.identity)
  await db.subscription.update({ where: { businessId: f.identity.business.id }, data: { seatLimit: 2 } })
  await authenticatedAction('invite', { email: `${randomUUID()}@example.test`, role: 'cashier' }, f.identity)
  await expect(authenticatedAction('member-update', { userId: member.userId, disabled: 'false' }, f.identity)).rejects.toMatchObject({ status: 409 })
})
test('MFA challenge retry limits survive rotating source IPs', async () => {
  const f = await fixture()
  const setup = await authenticatedAction('mfa-setup', { currentPassword: password }, f.identity)
  if (!('secret' in setup) || !setup.secret) throw new Error('setup missing')
  const enabled = await authenticatedAction('mfa-enable', { currentPassword: password, code: totp(setup.secret, Math.floor(Date.now() / 30_000)) }, f.identity)
  if (!('recoveryCodes' in enabled) || !enabled.recoveryCodes) throw new Error('codes missing')
  const result = await login({ email: f.email, password }, randomUUID())
  if (!('challenge' in result)) throw new Error('challenge missing')
  for (let i = 0; i < 5; i++) await expect(loginMfa({ token: result.challenge, code: 'bad-code' }, randomUUID())).rejects.toMatchObject({ status: 401 })
  await expect(loginMfa({ token: result.challenge, code: enabled.recoveryCodes[0] }, randomUUID())).rejects.toMatchObject({ status: 429 })
})
test('distributed password guessing is also limited per account', async () => {
  const f = await fixture()
  for (let i = 0; i < 20; i++) await expect(login({ email: f.email, password: 'wrong-password' }, randomUUID())).rejects.toMatchObject({ status: 401 })
  await expect(login({ email: f.email, password }, randomUUID())).rejects.toMatchObject({ status: 429 })
})
test('auth JSON has a streaming size bound and public-auth scope cannot bypass protected paths', async () => {
  const large = await call('login', { email: 'nobody@example.test', password: 'x'.repeat(17_000) })
  expect(large.status).toBe(413)
  const forbidden = await guard(new Request(`${appUrl}/api/export`), { scope: 'auth' })
  expect(forbidden.ok).toBe(false)
  if (!forbidden.ok) expect(forbidden.res.status).toBe(403)
})
test('mail is a real prerequisite, never a pretend successful reset/signup', async () => {
  const f = await fixture()
  delete process.env.WAKIL_MAIL_TOKEN
  await expect(register({ email: `${randomUUID()}@example.test`, password, name: 'Test', businessName: prefix }, randomUUID())).rejects.toMatchObject({ status: 503 })
  const known = await call('request-reset', { email: f.email }), unknown = await call('request-reset', { email: 'unknown@example.test' })
  expect(known.status).toBe(503); expect(unknown.status).toBe(503)
  expect(await known.json()).toEqual(await unknown.json())
})
test('an invited new account joins atomically, verified, without creating a dummy owned workspace', async () => {
  const owner = await fixture(), email = `${prefix}-${randomUUID()}@example.test`
  await authenticatedAction('invite', { email, role: 'reception' }, owner.identity)
  const token = await mailToken(email, 'invite')
  const before = await db.business.count()
  const registered = await register({ email, password, name: 'Invited employee', token }, randomUUID())
  created.push(registered.session.accountId)
  const current = (await resolveSession(request('me', undefined, registered.token)))!
  expect(current.business.id).toBe(owner.identity.business.id)
  expect(current.user.role).toBe('reception'); expect(current.account.verifiedAt).not.toBeNull()
  expect(await db.business.count()).toBe(before)
  expect(await db.membership.count({ where: { accountId: current.account.id } })).toBe(1)
  await expect(register({ email: `${randomUUID()}@example.test`, password, name: 'Wrong invite email', token }, randomUUID())).rejects.toMatchObject({ status: 403 })
  expect(await db.account.count({ where: { name: 'Wrong invite email' } })).toBe(0)
})
