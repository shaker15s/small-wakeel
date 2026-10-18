// Actual standalone production auth/session/team/CSRF/MFA/entitlement HTTP test.
// Mail delivery is NOT mocked as successful: tokens are read from the encrypted
// test outbox, never returned by the public API. No external email is sent.
import assert from 'node:assert/strict'
import { createDecipheriv, randomUUID } from 'node:crypto'
import { createClient } from '@libsql/client'
import { totp } from '../src/lib/saas/crypto'

type Jar = { cookie?: string; csrf?: string }
export async function saasHttpSmoke(base: string, databaseUrl: string, encryptionKey: string) {
  const sql = createClient({ url: databaseUrl })
  let requests = 0
  const origin = 'https://wakil.smoke.test'
  const password = 'HTTP test passphrase! 529'
  const email = `owner-${randomUUID()}@example.test`, staffEmail = `staff-${randomUUID()}@example.test`
  async function call(action: string, body?: object, jar: Jar = {}, headers: Record<string, string> = {}) {
    requests++
    const response = await fetch(`${base}/api/auth/${action}`, { method: body === undefined ? 'GET' : 'POST', headers: { origin, 'content-type': 'application/json', ...(jar.cookie ? { cookie: jar.cookie } : {}), ...(jar.csrf ? { 'x-wakil-csrf': jar.csrf } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const data = await response.json()
    const cookie = response.headers.get('set-cookie')
    if (cookie && response.ok) { assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); jar.cookie = cookie.split(';')[0] }
    if (data.csrfToken) jar.csrf = data.csrfToken
    return { response, data }
  }
  async function api(path: string, jar: Jar, body?: object) {
    requests++
    return fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { origin, 'content-type': 'application/json', cookie: jar.cookie ?? '', 'x-wakil-csrf': jar.csrf ?? '' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) })
  }
  async function linkToken(to: string, action: string) {
    const rows = (await sql.execute('SELECT payload FROM MailOutbox ORDER BY createdAt DESC')).rows
    for (const row of rows) {
      const raw = String(row.payload)
      if (!raw.startsWith('wakil:v1:')) continue
      const bytes = Buffer.from(raw.slice('wakil:v1:'.length), 'base64')
      const decipher = createDecipheriv('aes-256-gcm', Buffer.from(encryptionKey, 'hex'), bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28))
      const mail = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString())
      if (mail.to !== to) continue
      const params = new URLSearchParams(new URL(mail.text).hash.slice(1))
      if (params.get('action') === action) return params.get('token')!
    }
    throw new Error('Expected encrypted outbox token')
  }
  try {
    assert.equal((await call('config')).data.saasEnabled, true)
    const owner: Jar = {}, staff: Jar = {}
    assert.equal((await call('register', { email, password, name: 'HTTP owner', businessName: 'HTTP SaaS workspace' }, owner)).response.status, 200)
    assert.ok(owner.cookie && owner.csrf)
    const identity = (await call('me', undefined, owner)).data
    const membership = identity.memberships[0]
    assert.equal(identity.account.verified, false)
    assert.equal((await api('/api/chat', owner, { businessId: membership.businessId, userId: membership.userId, text: 'ضيف مصروف 33 جنيه' })).status, 403)
    const verify = await linkToken(email, 'verify')
    assert.equal((await call('verify', { token: verify })).response.status, 200)
    assert.equal((await call('verify', { token: verify })).response.status, 400)
    assert.equal((await call('logout', {}, { cookie: owner.cookie })).response.status, 403)
    const discovery = await api('/api/bootstrap', owner)
    assert.equal(discovery.status, 200)
    const discovered = await discovery.json() as { businesses: { id: string }[] }
    assert.deepEqual(discovered.businesses.map((b) => b.id), [membership.businessId])
    const countResponse = await api('/api/chat', owner, { businessId: membership.businessId, userId: membership.userId, text: 'باقي في الخزنة ٢٥٠٠', turnId: randomUUID() })
    assert.equal(countResponse.status, 200)
    const countEvents = (await countResponse.text()).split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)))
    const countOp = countEvents.find(e => e.event === 'card')?.card
    assert.ok(countOp?.opId, 'physical drawer count must be a real pending draft')
    const countApproved = await api(`/api/operations/${countOp.opId}/confirm`, owner, { action: 'approve', userId: membership.userId })
    assert.equal(countApproved.status, 200); assert.equal((await countApproved.json() as { outcome: { ok: boolean } }).outcome.ok, true)
    const turnId = randomUUID()
    const chat = await api('/api/chat', owner, { businessId: membership.businessId, userId: membership.userId, text: 'ضيف مصروف ٣٣ جنيه بند صيانة', turnId })
    assert.equal(chat.status, 200)
    const events = (await chat.text()).split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)))
    const op = events.find((e) => e.event === 'card')?.card
    assert.ok(op?.opId, 'SaaS cookie-authenticated chat must persist a draft')
    const approved = await api(`/api/operations/${op.opId}/confirm`, owner, { action: 'approve', userId: membership.userId, reason: 'HTTP SaaS approval' })
    assert.equal(approved.status, 200); assert.equal((await approved.json() as { outcome: { ok: boolean } }).outcome.ok, true)
    await sql.execute({ sql: 'UPDATE Subscription SET dailyChatLimit = 1 WHERE businessId = ?', args: [membership.businessId] })
    await sql.execute({ sql: 'DELETE FROM QuotaBucket WHERE id LIKE ?', args: [membership.businessId + ':%'] })
    const replay = { businessId: membership.businessId, userId: membership.userId, text: 'ضيف مصروف ٣٣ جنيه بند صيانة', turnId, conversationId: events.find((e) => e.event === 'start')?.conversationId }
    const quotaAttempt = await api('/api/chat', owner, replay)
    assert.equal(quotaAttempt.status, 200); await quotaAttempt.text()
    assert.equal((await api('/api/chat', owner, replay)).status, 429)
    const beforeSwitch = { ...owner }
    assert.equal((await call('create-workspace', { businessName: 'Second SaaS workspace', type: 'gym' }, owner)).response.status, 200)
    assert.equal((await call('me', undefined, beforeSwitch)).response.status, 401)
    assert.equal((await call('me', undefined, owner)).data.memberships.length, 2)
    assert.equal((await call('switch', { membershipId: membership.id }, owner)).response.status, 200)
    assert.equal((await call('register', { email: staffEmail, password, name: 'HTTP employee', businessName: 'Employee own workspace' }, staff)).response.status, 200)
    const foreignMembership = (await call('me', undefined, staff)).data.membershipId
    assert.equal((await call('switch', { membershipId: foreignMembership }, owner)).response.status, 403)
    assert.equal((await call('invite', { email: staffEmail, role: 'cashier' }, owner)).response.status, 200)
    const invitation = await linkToken(staffEmail, 'invite')
    assert.equal((await call('accept-invite', { token: invitation }, staff)).response.status, 200)
    assert.equal((await call('accept-invite', { token: invitation }, staff)).response.status, 403)
    const employee = (await call('me', undefined, staff)).data
    assert.equal(employee.memberships.find((m: { id: string }) => m.id === employee.membershipId).role, 'cashier')
    assert.equal((await call('invite', { email: 'unauthorized@example.test', role: 'supervisor' }, staff)).response.status, 403)
    assert.equal((await call('team', undefined, staff)).response.status, 403)
    assert.equal((await api(`/api/export?businessId=${membership.businessId}`, staff)).status, 403)
    const members = (await call('team', undefined, owner)).data.members
    assert.equal(members.length, 2)
    const target = members.find((m: { email: string }) => m.email === staffEmail)
    assert.equal((await call('member-update', { userId: target.userId, disabled: 'true' }, owner)).response.status, 200)
    assert.equal((await call('me', undefined, staff)).response.status, 401)
    const invitedEmail = `invited-${randomUUID()}@example.test`, newEmployee: Jar = {}
    assert.equal((await call('invite', { email: invitedEmail, role: 'reception' }, owner)).response.status, 200)
    assert.equal((await call('register', { email: invitedEmail, password, name: 'Invited reception', token: await linkToken(invitedEmail, 'invite') }, newEmployee)).response.status, 200)
    const joined = (await call('me', undefined, newEmployee)).data
    assert.equal(joined.account.verified, true); assert.equal(joined.memberships.length, 1)
    assert.equal(joined.memberships[0].businessId, membership.businessId); assert.equal(joined.memberships[0].role, 'reception')
    const setup = await call('mfa-setup', { currentPassword: password }, owner)
    assert.equal(setup.response.status, 200)
    const mfa = await call('mfa-enable', { currentPassword: password, code: totp(setup.data.secret, Math.floor(Date.now() / 30_000)) }, owner)
    assert.equal(mfa.response.status, 200); assert.equal(mfa.data.recoveryCodes.length, 10)
    const challenge = await call('login', { email, password })
    assert.equal(challenge.data.mfaRequired, true)
    const otherDevice: Jar = {}
    assert.equal((await call('login-mfa', { token: challenge.data.challenge, code: mfa.data.recoveryCodes[0] }, otherDevice)).response.status, 200)
    assert.equal((await call('login-mfa', { token: challenge.data.challenge, code: mfa.data.recoveryCodes[1] })).response.status, 400)
    assert.equal((await call('request-reset', { email })).response.status, 200)
    const reset = await linkToken(email, 'reset')
    const nextPassword = 'HTTP changed passphrase! 842'
    assert.equal((await call('reset', { token: reset, password: nextPassword })).response.status, 200)
    assert.equal((await call('me', undefined, owner)).response.status, 401)
    assert.equal((await call('me', undefined, otherDevice)).response.status, 401)
    assert.equal((await call('reset', { token: reset, password: nextPassword })).response.status, 400)
    assert.equal((await call('login', { email, password })).response.status, 401)
    const afterReset = await call('login', { email, password: nextPassword })
    assert.equal(afterReset.data.mfaRequired, true, 'password reset must NOT bypass MFA')
    assert.equal((await call('login-mfa', { token: afterReset.data.challenge, code: mfa.data.recoveryCodes[1] }, owner)).response.status, 200)
    await sql.execute({ sql: 'UPDATE Subscription SET trialEndsAt = ? WHERE businessId = ?', args: [new Date(Date.now() - 1000).toISOString(), membership.businessId] })
    assert.equal((await api('/api/chat', owner, { businessId: membership.businessId, userId: membership.userId, text: 'خزنتي كام' })).status, 402)
    assert.equal((await api(`/api/export?businessId=${membership.businessId}`, owner)).status, 200)
    assert.equal((await call('logout-all', {}, owner)).response.status, 200)
    assert.equal((await call('me', undefined, owner)).response.status, 401)
    console.log(`PASS: SaaS production HTTP (${requests} requests): signup/blank tenant/verify/CSRF/chat+approval/workspaces/invites/RBAC/revocation/MFA/recovery/reset/daily quota/expiry/logout; email delivery NOT claimed`)
  } finally { sql.close() }
}
