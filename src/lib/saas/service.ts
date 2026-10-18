import { VERTICAL_PRESETS } from '@/lib/verticals'
import type { Account, Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { decryptProviderKey, encryptProviderKey } from '@/lib/security/provider-secrets'
import { csrfFor, hashPassword, matchTotp, newToken, newTotpSecret, SaasError, tokenHash, verifyPassword } from './crypto'
import { actionLink, mailReady, queueMail } from './mail'
import { issueSession, type SessionIdentity } from './session'

type Input = Record<string, string | undefined>
const need = (p: Input, key: string) => { const value = p[key]?.trim(); if (!value) throw new SaasError(`الحقل ${key} مطلوب`); return value }
const emailOf = (email: string) => email.trim().toLowerCase()
const roleAllowed = (role: string) => ['supervisor', 'cashier', 'reception'].includes(role)
const nowPlus = (ms: number) => new Date(Date.now() + ms)
export function registrationEnabled() { return process.env.WAKIL_SIGNUP_ENABLED === '1' && mailReady() }

async function throttle(key: string, max: number, windowMs = 15 * 60_000) {
  await db.$transaction(async (tx) => {
    const id = tokenHash(key)
    const row = await tx.authThrottle.findUnique({ where: { id } })
    if (!row || row.windowAt.getTime() + windowMs <= Date.now()) {
      await tx.authThrottle.upsert({ where: { id }, create: { id, attempts: 1 }, update: { attempts: 1, windowAt: new Date() } })
    } else {
      if (row.attempts >= max) throw new SaasError('محاولات كثيرة؛ استنى شوية وجرّب تاني', 429, 'rate_limited')
      await tx.authThrottle.update({ where: { id }, data: { attempts: { increment: 1 } } })
    }
  })
}
async function accountEvent(tx: Prisma.TransactionClient, userId: string, businessId: string, action: string, detail: object = {}) {
  await tx.auditEvent.create({ data: { businessId, actor: userId, action, detail: JSON.stringify(detail) } })
}
async function createWorkspace(tx: Prisma.TransactionClient, account: Pick<Account, 'id' | 'name'>, name: string, type: string) {
  if (!VERTICAL_PRESETS.some((preset) => preset.key === type)) throw new SaasError('نوع النشاط غير صالح')
  const business = await tx.business.create({ data: { name: name.slice(0, 80), type, workflowMode: ['supermarket', 'attar'].includes(type) ? 'cashbook' : 'inventory', openingCash: 0 } })
  const user = await tx.user.create({ data: { businessId: business.id, name: account.name, role: 'owner', title: 'صاحب المنشأة' } })
  const membership = await tx.membership.create({ data: { accountId: account.id, userId: user.id } })
  await tx.agentSettings.create({ data: { businessId: business.id, vertical: type, tone: 'friendly' } })
  await tx.subscription.create({ data: { businessId: business.id, trialEndsAt: nowPlus(14 * 86400_000) } })
  await accountEvent(tx, user.id, business.id, 'saas.workspace.created')
  return { membership, business, user }
}
async function accountLink(tx: Prisma.TransactionClient, account: Account, purpose: 'verify' | 'reset') {
  await tx.accountToken.updateMany({ where: { accountId: account.id, purpose, usedAt: null }, data: { usedAt: new Date() } })
  const token = newToken()
  const expiresAt = nowPlus(purpose === 'verify' ? 24 * 3600_000 : 30 * 60_000)
  await tx.accountToken.create({ data: { accountId: account.id, purpose, tokenHash: tokenHash(token), expiresAt } })
  await queueMail(tx, account.email, purpose === 'verify' ? 'تأكيد بريدك في وكيل' : 'استعادة كلمة مرور وكيل', actionLink(purpose, token), expiresAt)
}
async function consumeToken(tx: Prisma.TransactionClient, raw: string, purpose: string) {
  const row = await tx.accountToken.findUnique({ where: { tokenHash: tokenHash(raw) }, include: { account: true } })
  if (!row || row.purpose !== purpose || row.usedAt || row.expiresAt.getTime() <= Date.now() || row.account.disabledAt) throw new SaasError('الرابط غير صالح أو انتهت صلاحيته', 400, 'invalid_token')
  const claimed = await tx.accountToken.updateMany({ where: { id: row.id, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } })
  if (!claimed.count) throw new SaasError('الرابط غير صالح أو تم استخدامه')
  return row.account
}
async function checkMfa(tx: Prisma.TransactionClient, account: Account, code: string) {
  if (!account.mfaSecret) return
  const step = matchTotp(decryptProviderKey(account.mfaSecret), code, account.mfaLastStep)
  if (step !== null) {
    const claimed = await tx.account.updateMany({ where: { id: account.id, mfaLastStep: account.mfaLastStep }, data: { mfaLastStep: step } })
    if (claimed.count) return
  } else {
    const recovery = JSON.parse(account.recoveryHashes) as string[]
    const hash = tokenHash(code)
    if (recovery.includes(hash)) {
      const claimed = await tx.account.updateMany({ where: { id: account.id, recoveryHashes: account.recoveryHashes }, data: { recoveryHashes: JSON.stringify(recovery.filter((h) => h !== hash)) } })
      if (claimed.count) return
    }
  }
  throw new SaasError('رمز التحقق غير صالح أو تم استخدامه', 401, 'invalid_mfa')
}
async function joinInvitation(tx: Prisma.TransactionClient, raw: string, account: Account) {
  const invite = await tx.invitation.findUnique({ where: { tokenHash: tokenHash(raw) } })
  if (!invite || !roleAllowed(invite.role) || invite.email !== account.email || invite.acceptedAt || invite.revokedAt || invite.expiresAt.getTime() <= Date.now()) throw new SaasError('الدعوة غير صالحة أو البريد مختلف', 403)
  const inviter = await tx.user.findFirst({ where: { id: invite.invitedBy, businessId: invite.businessId } })
  const inviterMembership = await tx.membership.findUnique({ where: { userId: invite.invitedBy }, include: { account: true } })
  if (!inviter || !inviterMembership || inviterMembership.disabledAt || inviterMembership.account.disabledAt || !inviterMembership.account.verifiedAt || !['owner', 'supervisor'].includes(inviter.role) || (invite.role === 'supervisor' && inviter.role !== 'owner')) throw new SaasError('الدعوة لم تعد مصرحًا بها', 403)
  const existing = await tx.membership.findMany({ where: { accountId: account.id } })
  if (await tx.user.findFirst({ where: { businessId: invite.businessId, id: { in: existing.map((m) => m.userId) } } })) throw new SaasError('الحساب عضو بالفعل؛ اطلب إعادة تفعيل العضوية عند الحاجة', 409)
  const sub = await tx.subscription.findUniqueOrThrow({ where: { businessId: invite.businessId } })
  if (!subscriptionWritable(sub)) throw new SaasError('اشتراك المنشأة غير نشط', 402)
  const actors = await tx.user.findMany({ where: { businessId: invite.businessId }, select: { id: true } })
  if (await tx.membership.count({ where: { userId: { in: actors.map((u) => u.id) }, disabledAt: null } }) >= sub.seatLimit) throw new SaasError('المنشأة وصلت لحد المقاعد', 409)
  const claimed = await tx.invitation.updateMany({ where: { id: invite.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, data: { acceptedAt: new Date() } })
  if (!claimed.count) throw new SaasError('الدعوة مستخدمة بالفعل', 409)
  const actor = await tx.user.create({ data: { businessId: invite.businessId, name: account.name, role: invite.role } })
  const created = await tx.membership.create({ data: { accountId: account.id, userId: actor.id } })
  await tx.account.update({ where: { id: account.id }, data: { verifiedAt: account.verifiedAt ?? new Date() } })
  await accountEvent(tx, actor.id, invite.businessId, 'saas.invite.accepted')
  return created
}
export async function register(p: Input, ip: string) {
  if (!registrationEnabled()) throw new SaasError('إنشاء الحسابات غير متاح قبل تجهيز البريد وإعدادات التشغيل', 503, 'signup_unavailable')
  await throttle(`signup:${ip}`, 5, 3600_000)
  const email = emailOf(need(p, 'email'))
  const passwordHash = await hashPassword(p.password ?? '')
  if (await db.account.findUnique({ where: { email } })) throw new SaasError('تعذّر إنشاء الحساب؛ جرّب الدخول أو استعادة كلمة المرور', 409)
  try { return await db.$transaction(async (tx) => {
    const account = await tx.account.create({ data: { email, name: need(p, 'name').slice(0, 60), passwordHash } })
    if (p.token) {
      const joined = await joinInvitation(tx, p.token, account)
      return issueSession(tx, account.id, joined.id)
    }
    const workspace = await createWorkspace(tx, account, need(p, 'businessName'), p.type || 'supermarket')
    await accountLink(tx, account, 'verify')
    return issueSession(tx, account.id, workspace.membership.id)
  }) } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 'P2002') throw new SaasError('تعذّر إنشاء الحساب؛ جرّب الدخول أو استعادة كلمة المرور', 409)
    throw e
  }
}
export async function login(p: Input, ip: string) {
  const email = emailOf(need(p, 'email'))
  await throttle(`login-ip:${ip}`, 60)
  await throttle(`login-account:${email}`, 20)
  await throttle(`login:${ip}:${email}`, 10)
  const account = await db.account.findUnique({ where: { email } })
  const valid = await verifyPassword(p.password ?? '', account?.passwordHash)
  if (!account || !valid || account.disabledAt) throw new SaasError('البريد أو كلمة المرور غير صحيحة', 401, 'invalid_credentials')
  if (account.mfaSecret) {
    const challenge = newToken()
    await db.$transaction(async (tx) => {
      const fresh = await tx.account.findUniqueOrThrow({ where: { id: account.id } })
      if (fresh.disabledAt || fresh.passwordHash !== account.passwordHash || !fresh.mfaSecret) throw new SaasError('بيانات الدخول اتغيّرت؛ حاول من جديد', 401)
      await tx.accountToken.create({ data: { accountId: account.id, purpose: 'mfa', tokenHash: tokenHash(challenge), expiresAt: nowPlus(5 * 60_000) } })
    })
    return { challenge, mfaRequired: true as const }
  }
  return loginAccount(account.id, account.passwordHash)
}
async function loginAccount(accountId: string, expectedHash: string) {
  return db.$transaction(async (tx) => {
    const current = await tx.account.findUniqueOrThrow({ where: { id: accountId } })
    if (current.disabledAt || current.passwordHash !== expectedHash || current.mfaSecret) throw new SaasError('بيانات الدخول اتغيّرت؛ ادخل من جديد', 401)
    const memberships = await tx.membership.findMany({ where: { accountId, disabledAt: null }, orderBy: { createdAt: 'asc' } })
    for (const membership of memberships) {
      if (await tx.user.findUnique({ where: { id: membership.userId } })) return issueSession(tx, accountId, membership.id)
    }
    throw new SaasError('لا توجد عضوية نشطة لهذا الحساب', 403)
  })
}
export async function loginMfa(p: Input, ip: string) {
  await throttle(`mfa-ip:${ip}`, 40)
  const challengeHash = tokenHash(need(p, 'token'))
  const challenge = await db.accountToken.findUnique({ where: { tokenHash: challengeHash } })
  if (!challenge || challenge.purpose !== 'mfa') throw new SaasError('الرابط غير صالح أو انتهت صلاحيته', 400, 'invalid_token')
  await throttle(`mfa-token:${challengeHash}`, 5)
  await throttle(`mfa-account:${challenge.accountId}`, 10)
  return db.$transaction(async (tx) => {
    const account = await consumeToken(tx, need(p, 'token'), 'mfa')
    await checkMfa(tx, account, need(p, 'code'))
    const memberships = await tx.membership.findMany({ where: { accountId: account.id, disabledAt: null }, orderBy: { createdAt: 'asc' } })
    for (const membership of memberships) if (await tx.user.findUnique({ where: { id: membership.userId } })) return issueSession(tx, account.id, membership.id)
    throw new SaasError('لا توجد عضوية نشطة', 403)
  })
}
export async function requestReset(p: Input, ip: string) {
  if (!mailReady()) throw new SaasError('إرسال البريد غير مجهّز على الخادم', 503)
  const email = emailOf(need(p, 'email'))
  await throttle(`reset-ip:${ip}`, 10, 3600_000)
  await throttle(`reset-email:${email}`, 3, 3600_000)
  const account = await db.account.findUnique({ where: { email } })
  if (account && !account.disabledAt) await db.$transaction((tx) => accountLink(tx, account, 'reset'))
  return { message: 'لو البريد مسجّل، هيوصلك رابط استعادة صالح لمدة 30 دقيقة' }
}
export async function resetPassword(p: Input, ip: string) {
  await throttle(`reset-consume:${ip}`, 10)
  const passwordHash = await hashPassword(p.password ?? '')
  await db.$transaction(async (tx) => {
    const account = await consumeToken(tx, need(p, 'token'), 'reset')
    await tx.account.update({ where: { id: account.id }, data: { passwordHash, pendingMfaSecret: null, pendingMfaAt: null } })
    await tx.session.updateMany({ where: { accountId: account.id, revokedAt: null }, data: { revokedAt: new Date() } })
    await tx.accountToken.updateMany({ where: { accountId: account.id, purpose: { in: ['reset', 'mfa'] }, usedAt: null }, data: { usedAt: new Date() } })
  })
  return { message: 'اتغيّرت كلمة المرور واتقفلت كل الجلسات. ادخل تاني؛ التحقق بخطوتين ما زال مفعّلًا لو كنت فعّلته.' }
}
export async function verifyEmail(p: Input) {
  await db.$transaction(async (tx) => {
    const account = await consumeToken(tx, need(p, 'token'), 'verify')
    await tx.account.update({ where: { id: account.id }, data: { verifiedAt: new Date() } })
  })
  return { message: 'تم تأكيد البريد' }
}
export async function me(identity: SessionIdentity) {
  const subscription = await db.subscription.findUnique({ where: { businessId: identity.business.id }, select: { plan: true, status: true, trialEndsAt: true, seatLimit: true, dailyChatLimit: true } })
  const memberships = await db.membership.findMany({ where: { accountId: identity.account.id, disabledAt: null } })
  const users = await db.user.findMany({ where: { id: { in: memberships.map((m) => m.userId) } }, include: { business: true } })
  return {
    account: { id: identity.account.id, email: identity.account.email, name: identity.account.name, verified: !!identity.account.verifiedAt, mfaEnabled: !!identity.account.mfaSecret },
    csrfToken: identity.csrfToken, sessionId: identity.session.id,
    membershipId: identity.membership.id,
    memberships: memberships.flatMap((m) => { const user = users.find((u) => u.id === m.userId); return user ? [{ id: m.id, userId: user.id, businessId: user.businessId, businessName: user.business.name, role: user.role }] : [] }),
    subscription: subscription ? { ...subscription, writable: subscriptionWritable(subscription) } : null,
  }
}
async function liveIdentity(tx: Prisma.TransactionClient, identity: SessionIdentity) {
  const session = await tx.session.findUnique({ where: { id: identity.session.id }, include: { account: true, membership: { include: { user: true } } } })
  if (!session || session.revokedAt || session.expiresAt < new Date() || session.account.disabledAt || session.membership.disabledAt || session.account.passwordHash !== identity.account.passwordHash || session.membership.user.role !== identity.user.role) throw new SaasError('الجلسة أو الصلاحيات اتغيّرت؛ ادخل من جديد', 401)
}
export async function authenticatedAction(action: string, p: Input, identity: SessionIdentity) {
  const { account, session, membership, user, business } = identity
  if (action === 'logout' || action === 'logout-all') {
    await db.session.updateMany({ where: action === 'logout' ? { id: session.id } : { accountId: account.id, revokedAt: null }, data: { revokedAt: new Date() } })
    return { message: 'تم تسجيل الخروج' }
  }
  if (action === 'revoke-session') {
    await db.session.updateMany({ where: { id: need(p, 'sessionId'), accountId: account.id }, data: { revokedAt: new Date() } })
    return { message: 'تم إبطال الجلسة' }
  }
  if (action === 'resend-verification') {
    await throttle(`resend:${account.id}`, 3, 3600_000)
    if (!account.verifiedAt) await db.$transaction((tx) => accountLink(tx, account, 'verify'))
    return { message: 'تم وضع رسالة التأكيد في طابور الإرسال' }
  }
  if (action === 'switch') {
    return db.$transaction(async (tx) => {
      await liveIdentity(tx, identity)
      const target = await tx.membership.findFirst({ where: { id: need(p, 'membershipId'), accountId: account.id, disabledAt: null } })
      if (!target || !await tx.user.findUnique({ where: { id: target.userId } })) throw new SaasError('العضوية غير متاحة', 403)
      await tx.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } })
      return issueSession(tx, account.id, target.id)
    })
  }
  if (action === 'change-password' || action === 'mfa-setup' || action === 'mfa-enable' || action === 'mfa-disable') {
    await throttle(`sensitive:${account.id}`, 10)
    if (!await verifyPassword(p.currentPassword ?? '', account.passwordHash)) throw new SaasError('كلمة المرور الحالية غير صحيحة', 401)
    if (action === 'mfa-setup') {
      if (!/^[a-f0-9]{64}$/i.test(process.env.WAKIL_SECRETS_KEY ?? '')) throw new SaasError('مفتاح تشفير الخادم غير مجهّز', 503)
      if (account.mfaSecret) throw new SaasError('التحقق بخطوتين مفعّل بالفعل')
      const secret = newTotpSecret()
      await db.$transaction(async (tx) => {
        await liveIdentity(tx, identity)
        const fresh = await tx.account.findUniqueOrThrow({ where: { id: account.id } })
        if (fresh.mfaSecret) throw new SaasError('التحقق بخطوتين مفعّل بالفعل')
        await tx.account.update({ where: { id: account.id }, data: { pendingMfaSecret: encryptProviderKey(secret), pendingMfaAt: new Date() } })
      })
      return { secret, uri: `otpauth://totp/${encodeURIComponent('Wakil:' + account.email)}?secret=${secret}&issuer=Wakil&digits=6&period=30` }
    }
    if (action === 'mfa-enable') {
      const recoveryCodes = Array.from({ length: 10 }, () => newToken().slice(0, 16))
      await db.$transaction(async (tx) => {
      await liveIdentity(tx, identity)
        const fresh = await tx.account.findUniqueOrThrow({ where: { id: account.id } })
        if (fresh.mfaSecret || !fresh.pendingMfaSecret || !fresh.pendingMfaAt || fresh.pendingMfaAt.getTime() + 10 * 60_000 < Date.now()) throw new SaasError('إعداد التحقق انتهى؛ ابدأ من جديد')
        const step = matchTotp(decryptProviderKey(fresh.pendingMfaSecret), need(p, 'code'))
        if (step === null) throw new SaasError('رمز التحقق غير صالح')
        await tx.account.update({ where: { id: account.id }, data: { mfaSecret: fresh.pendingMfaSecret, pendingMfaSecret: null, pendingMfaAt: null, mfaLastStep: step, recoveryHashes: JSON.stringify(recoveryCodes.map(tokenHash)) } })
        await tx.session.updateMany({ where: { accountId: account.id, id: { not: session.id }, revokedAt: null }, data: { revokedAt: new Date() } })
      })
      return { recoveryCodes }
    }
    const passwordHash = action === 'change-password' ? await hashPassword(p.password ?? '') : undefined
    await db.$transaction(async (tx) => {
      await liveIdentity(tx, identity)
      const fresh = await tx.account.findUniqueOrThrow({ where: { id: account.id } })
      await checkMfa(tx, fresh, p.code ?? '')
      await tx.account.update({ where: { id: account.id }, data: action === 'mfa-disable' ? { mfaSecret: null, recoveryHashes: '[]', mfaLastStep: -1 } : { passwordHash, pendingMfaSecret: null, pendingMfaAt: null } })
      await tx.session.updateMany({ where: { accountId: account.id, revokedAt: null }, data: { revokedAt: new Date() } })
      await tx.accountToken.updateMany({ where: { accountId: account.id, purpose: { in: ['reset', 'mfa'] }, usedAt: null }, data: { usedAt: new Date() } })
    })
    return { message: 'تم تحديث الأمان وإبطال الجلسات. ادخل من جديد.' }
  }
  if (action === 'create-workspace') {
    if (!account.verifiedAt) throw new SaasError('أكد البريد أولًا', 403)
    return db.$transaction(async (tx) => {
      await liveIdentity(tx, identity)
      const memberships = await tx.membership.findMany({ where: { accountId: account.id, disabledAt: null } })
      if (await tx.user.count({ where: { id: { in: memberships.map((m) => m.userId) }, role: 'owner' } }) >= 3) throw new SaasError('الحد الحالي 3 منشآت للحساب', 409)
      const created = await createWorkspace(tx, account, need(p, 'businessName'), p.type || 'supermarket')
      await tx.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } })
      return issueSession(tx, account.id, created.membership.id)
    })
  }
  if (action === 'accept-invite') {
    return db.$transaction(async (tx) => {
      await liveIdentity(tx, identity)
      const created = await joinInvitation(tx, need(p, 'token'), account)
      await tx.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } })
      return issueSession(tx, account.id, created.id)
    })
  }
  if (action === 'invite') await throttle(`invite-account:${account.id}`, 10, 3600_000)
  if (action === 'invite' || action === 'revoke-invite' || action === 'member-update') {
    if (!account.verifiedAt || !['owner', 'supervisor'].includes(user.role)) throw new SaasError('صلاحية الإدارة وتأكيد البريد مطلوبين', 403)
    return db.$transaction(async (tx) => {
      await liveIdentity(tx, identity)
      if (action === 'member-update') {
        if (user.role !== 'owner') throw new SaasError('تعديل الأعضاء للمالك فقط', 403)
        const target = await tx.user.findFirst({ where: { id: need(p, 'userId'), businessId: business.id } })
        if (!target || target.role === 'owner') throw new SaasError('لا يمكن تعديل المالك أو عضو خارج المنشأة', 403)
        const member = await tx.membership.findUnique({ where: { userId: target.id } })
        if (!member || (p.role && !roleAllowed(p.role))) throw new SaasError('عضوية أو دور غير صالح')
        if (p.role) await tx.user.update({ where: { id: target.id }, data: { role: p.role } })
        if (p.disabled === 'false' && member.disabledAt) {
          const sub = await tx.subscription.findUniqueOrThrow({ where: { businessId: business.id } })
          const actors = await tx.user.findMany({ where: { businessId: business.id }, select: { id: true } })
          const pending = await tx.invitation.count({ where: { businessId: business.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } })
          if (pending + await tx.membership.count({ where: { userId: { in: actors.map((u) => u.id) }, disabledAt: null } }) >= sub.seatLimit) throw new SaasError('المنشأة وصلت لحد المقاعد', 409)
        }
        if (p.disabled !== undefined) {
          await tx.membership.update({ where: { id: member.id }, data: { disabledAt: p.disabled === 'true' ? new Date() : null } })
        }
        await tx.session.updateMany({ where: { membershipId: member.id, revokedAt: null }, data: { revokedAt: new Date() } })
        await tx.invitation.updateMany({ where: { businessId: business.id, invitedBy: target.id, acceptedAt: null }, data: { revokedAt: new Date() } })
        await accountEvent(tx, user.id, business.id, 'saas.member.updated', { userId: target.id, role: p.role, disabled: p.disabled })
        return { message: 'تم تحديث العضوية وإبطال جلساتها' }
      }
      if (action === 'revoke-invite') {
        await tx.invitation.updateMany({ where: { id: need(p, 'invitationId'), businessId: business.id, acceptedAt: null, ...(user.role === 'owner' ? {} : { invitedBy: user.id }) }, data: { revokedAt: new Date() } })
        return { message: 'تم إلغاء الدعوة' }
      }
      const role = need(p, 'role')
      if (!roleAllowed(role) || (role === 'supervisor' && user.role !== 'owner')) throw new SaasError('لا يمكنك منح هذا الدور', 403)
      const email = emailOf(need(p, 'email'))
      if (email === account.email || await tx.membership.findFirst({ where: { account: { email }, user: { businessId: business.id } } })) throw new SaasError('البريد عضو بالفعل؛ استخدم إدارة الفريق', 409)
      const sub = await tx.subscription.findUniqueOrThrow({ where: { businessId: business.id } })
      if (!subscriptionWritable(sub)) throw new SaasError('الفترة التجريبية انتهت؛ المنشأة للقراءة والتصدير فقط', 402)
      const actors = await tx.user.findMany({ where: { businessId: business.id }, select: { id: true } })
      const occupied = await tx.membership.count({ where: { userId: { in: actors.map((u) => u.id) }, disabledAt: null } })
      const pending = await tx.invitation.count({ where: { businessId: business.id, email: { not: email }, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } })
      if (occupied + pending >= sub.seatLimit) throw new SaasError('المنشأة وصلت لحد المقاعد والدعوات المحجوزة', 409)
      await tx.invitation.updateMany({ where: { businessId: business.id, email, acceptedAt: null }, data: { revokedAt: new Date() } })
      const token = newToken(), expiresAt = nowPlus(72 * 3600_000)
      const invite = await tx.invitation.create({ data: { businessId: business.id, email, role, tokenHash: tokenHash(token), invitedBy: user.id, expiresAt } })
      await queueMail(tx, email, `دعوة إلى ${business.name} في وكيل`, actionLink('invite', token), expiresAt)
      await accountEvent(tx, user.id, business.id, 'saas.invite.created', { invitationId: invite.id, role })
      return { message: 'تم وضع الدعوة في طابور البريد', invitationId: invite.id }
    })
  }
  throw new SaasError('الإجراء غير موجود', 404)
}
export function subscriptionWritable(sub: { status: string; trialEndsAt: Date }) {
  return sub.status === 'active' || (sub.status === 'trialing' && sub.trialEndsAt.getTime() > Date.now())
}
export async function team(identity: SessionIdentity) {
  if (!['owner', 'supervisor'].includes(identity.user.role)) throw new SaasError('قائمة الفريق للإدارة فقط', 403)
  const users = await db.user.findMany({ where: { businessId: identity.business.id } })
  const members = await db.membership.findMany({ where: { userId: { in: users.map((u) => u.id) } }, include: { account: true } })
  return { members: members.map((m) => ({ id: m.id, userId: m.userId, name: m.account.name, email: m.account.email, role: users.find((u) => u.id === m.userId)!.role, disabled: !!m.disabledAt })), invitations: await db.invitation.findMany({ where: { businessId: identity.business.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true, email: true, role: true, expiresAt: true } }) }
}
export async function sessions(identity: SessionIdentity) {
  return { sessions: await db.session.findMany({ where: { accountId: identity.account.id, revokedAt: null, expiresAt: { gt: new Date() }, lastSeenAt: { gt: new Date(Date.now() - 24 * 3600_000) } }, select: { id: true, createdAt: true, lastSeenAt: true, expiresAt: true }, orderBy: { createdAt: 'desc' } }) }
}
export { csrfFor }
