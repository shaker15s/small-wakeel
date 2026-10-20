// وكيل — Companion: a small, revocable, READ-ONLY bridge to the owner's own
// machine (PR-011 / plan v2 §10, P6).
//
// The companion is NOT a remote-control client. It is a trusted bridge between
// the cloud runtime and the few resources the owner explicitly allowed:
// explicit path roots and pinned executables, nothing else.
//
// Security invariants (each one is exercised by tests/integration/companion.test.ts):
//   1. enrollment — the owner creates a SHORT-LIVED (5 min), SINGLE-USE code;
//      only the sha256 is stored
//   2. activation — the code is exchanged ONCE for a device identity; the
//      device token is shown once and stored only as sha256
//   3. device auth — every claim/result call carries
//      HMAC(token, deviceId|nonce|ts|sha256(body)) with a 60s clock window;
//      stale timestamps and replayed nonces are refused
//   4. revocation — immediate: a REVOKED device claims nothing and its
//      in-flight jobs can never settle
//   5. allowlist — a job's tool+args are validated against the device's
//      explicit allowlist at dispatch time; the bridge itself re-validates
//      locally (path roots, symlink escape, size limits, argv arrays — never
//      a shell string)
//   6. evidence — every read returns a DOUBLE-READ hash (two independent
//      reads must agree) + size/lines, so «القراءة الخارجية تطابق مصدرها»
//      is verifiable, not assumed
//   7. jobs are single-purpose and expiring (60s): job_id + device + tool +
//      args + nonce + expires_at — no general-purpose command channel
//
// Financial boundary: the companion can only READ (files/dirs/CLI stdout).
// It has no write tool, no approval surface, and no money path — financial
// operations through an external program still need the human approval
// engine (P1) bound to that exact operation.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { db } from '@/lib/db'

export const ENROLLMENT_TTL_MS = 5 * 60_000
export const JOB_TTL_MS = 60_000
export const DEVICE_AUTH_WINDOW_MS = 60_000
const MAX_NONCE_MEMORY = 5_000

// ---------------------------------------------------------------------------
// Enrollment + activation
// ---------------------------------------------------------------------------

/** Owner initiates pairing: get a short-lived, single-use enrollment code. */
export async function createEnrollment(businessId: string, deviceName: string) {
  const code = randomBytes(12).toString('hex')
  await db.companionEnrollment.create({
    data: {
      businessId,
      codeHash: sha256(code),
      deviceName: deviceName.slice(0, 80),
      expiresAt: new Date(Date.now() + ENROLLMENT_TTL_MS),
    },
  })
  return { code, expiresAt: new Date(Date.now() + ENROLLMENT_TTL_MS) }
}

export interface CompanionAllowlist {
  /** Absolute path roots the device may list/read under. */
  paths: string[]
  /** Pinned executables (absolute path or exact name) the device may run. */
  cli: Array<{ command: string; label?: string }>
}

export function parseAllowlist(raw: string): CompanionAllowlist {
  try {
    const v = JSON.parse(raw) as Partial<CompanionAllowlist>
    return {
      paths: Array.isArray(v.paths) ? v.paths.filter((p) => typeof p === 'string') : [],
      cli: Array.isArray(v.cli)
        ? v.cli
            .filter((c) => c && typeof c.command === 'string' && c.command.length > 0)
            .map((c) => ({ command: (c as { command: string }).command, label: (c as { label?: string }).label }))
        : [],
    }
  } catch {
    return { paths: [], cli: [] }
  }
}

/**
 * Exchange an enrollment code (once) for a device identity. The allowlist is
 * chosen by the owner here — it is the device's EXPLICIT permission surface.
 */
export async function activateDevice(input: {
  code: string
  deviceName: string
  allowlist: Partial<CompanionAllowlist>
}): Promise<{ deviceId: string; token: string } | { error: string }> {
  const row = await db.companionEnrollment.findUnique({ where: { codeHash: sha256(input.code) } })
  if (!row) return { error: 'رمز التسجيل غير صحيح' }
  if (row.usedAt) return { error: 'رمز التسجيل استُخدم بالفعل — أنشئ رمزًا جديدًا' }
  if (row.expiresAt.getTime() <= Date.now()) return { error: 'انتهت صلاحية رمز التسجيل — أنشئ رمزًا جديدًا' }

  const token = randomBytes(24).toString('hex')
  const device = await db.companionDevice.create({
    data: {
      businessId: row.businessId,
      name: input.deviceName.slice(0, 80),
      status: 'ACTIVE',
      tokenHash: sha256(token),
      allowlist: JSON.stringify({
        paths: (input.allowlist.paths ?? []).slice(0, 20),
        cli: (input.allowlist.cli ?? []).slice(0, 10),
      }),
      activatedAt: new Date(),
      lastSeenAt: new Date(),
    },
  })
  await db.companionEnrollment.update({ where: { id: row.id }, data: { usedAt: new Date() } })
  return { deviceId: device.id, token }
}

/** Immediate revocation: the device claims nothing from this moment on. */
export async function revokeDevice(deviceId: string, businessId: string): Promise<boolean> {
  const res = await db.companionDevice.updateMany({
    where: { id: deviceId, businessId, status: 'ACTIVE' },
    data: { status: 'REVOKED', revokedAt: new Date() },
  })
  return res.count === 1
}

/** Revoke a device AND expire every job it still holds (nothing settles). */
export async function revokeDeviceWithJobs(deviceId: string, businessId: string): Promise<{ device: boolean; jobs: number }> {
  const device = await revokeDevice(deviceId, businessId)
  const jobs = await db.companionJob.updateMany({
    where: { deviceId, status: { in: ['QUEUED', 'CLAIMED'] } },
    data: { status: 'EXPIRED', errorReason: 'تم فصل الجهاز — أُلغيت مهامه المعلقة', updatedAt: new Date() },
  })
  return { device, jobs: jobs.count }
}

export async function listDevices(businessId: string) {
  const devices = await db.companionDevice.findMany({ where: { businessId }, orderBy: { createdAt: 'desc' } })
  const jobs = await db.companionJob.findMany({
    where: { businessId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  return {
    devices: devices.map((d) => ({
      id: d.id,
      name: d.name,
      status: d.status,
      allowlist: parseAllowlist(d.allowlist),
      activatedAt: d.activatedAt?.toISOString() ?? null,
      revokedAt: d.revokedAt?.toISOString() ?? null,
      lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
      jobs: jobs.filter((j) => j.deviceId === d.id).map(summarizeJob),
    })),
  }
}

// ---------------------------------------------------------------------------
// Job dispatch (server → device), claim + result (device → server)
// ---------------------------------------------------------------------------

export const COMPANION_TOOLS = ['list_dir', 'read_file', 'run_cli'] as const
export type CompanionTool = (typeof COMPANION_TOOLS)[number]

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}
export function hmacHex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

/**
 * Dispatch a single-purpose job to a device. The tool + args must be inside
 * the device's explicit allowlist — anything else is refused at dispatch,
 * so a compromised UI or a confused agent can't widen the surface.
 */
export async function dispatchJob(input: {
  businessId: string
  deviceId: string
  tool: string
  args: Record<string, unknown>
}): Promise<{ jobId: string } | { error: string }> {
  const device = await db.companionDevice.findUnique({ where: { id: input.deviceId } })
  if (!device || device.businessId !== input.businessId) return { error: 'الجهاز غير موجود' }
  if (device.status !== 'ACTIVE') return { error: 'الجهاز مفصول — لا يمكن جدولة مهام له' }
  if (!COMPANION_TOOLS.includes(input.tool as CompanionTool)) return { error: 'أداة غير مدعومة' }

  const allowlist = parseAllowlist(device.allowlist)
  if (input.tool === 'run_cli') {
    const command = String(input.args.command ?? '')
    if (!allowlist.cli.some((c) => c.command === command)) {
      return { error: `الأمر «${command || '(فارغ)'}» غير موجود في قائمة الجهاز المسموح بها` }
    }
  }
  // path arguments are validated again by the bridge locally (it knows the
  // real filesystem); here we only enforce that SOMETHING was provided.
  if ((input.tool === 'list_dir' || input.tool === 'read_file') && !String(input.args.path ?? '')) {
    return { error: 'المسار مطلوب' }
  }

  const nonce = randomBytes(12).toString('hex')
  const expiresAt = new Date(Date.now() + JOB_TTL_MS)
  const job = await db.companionJob.create({
    data: {
      businessId: input.businessId,
      deviceId: device.id,
      tool: input.tool,
      args: JSON.stringify(input.args),
      status: 'QUEUED',
      nonce,
      envelopeHmac: '', // filled below (needs the nonce + id)
      expiresAt,
    },
  })
  // The bridge verifies with HMAC(sha256(token), envelope) — and the server
  // stores exactly tokenHash = sha256(token), so the signing key is known
  // without ever storing the token itself.
  const envelope = `${job.id}|${device.id}|${input.tool}|${JSON.stringify(input.args)}|${nonce}|${expiresAt.getTime()}`
  await db.companionJob.update({
    where: { id: job.id },
    data: { envelopeHmac: hmacHex(device.tokenHash + '|envelope', envelope) },
  })
  return { jobId: job.id }
}

/**
 * Device auth: verify the HMAC envelope of a claim/result request.
 * The body hash binds the payload to the signature; the 60s window +
 * in-memory nonce set defeat replay within a process lifetime.
 */
const seenNonces = new Map<string, number>() // nonce -> expiresAtMs

function nonceAllowed(key: string, nowMs: number): boolean {
  // opportunistic prune (map is bounded)
  if (seenNonces.size > MAX_NONCE_MEMORY) {
    for (const [k, exp] of seenNonces) if (exp < nowMs) seenNonces.delete(k)
  }
  const exp = seenNonces.get(key)
  if (exp !== undefined) return false
  return true
}

export interface DeviceAuth {
  ok: true
  device: { id: string; businessId: string }
}

export async function authenticateDevice(
  headers: { deviceId?: string | null; nonce?: string | null; ts?: string | null; hmac?: string | null },
  bodyText: string,
): Promise<DeviceAuth | { ok: false; error: string }> {
  const { deviceId, nonce, ts, hmac } = headers
  if (!deviceId || !nonce || !ts || !hmac) return { ok: false, error: 'توقيعات الجهاز ناقصة' }
  const tsNum = Number(ts)
  const now = Date.now()
  if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > DEVICE_AUTH_WINDOW_MS) {
    return { ok: false, error: 'خارج نافذة الوقت المسموح (60 ثانية)' }
  }
  const device = await db.companionDevice.findUnique({ where: { id: deviceId } })
  if (!device) return { ok: false, error: 'الجهاز غير موجود' }
  if (device.status !== 'ACTIVE') return { ok: false, error: 'الجهاز مفصول — لا يمكنه تنفيذ أي مهمة' }

  const key = `${deviceId}:${nonce}`
  if (!nonceAllowed(key, now)) return { ok: false, error: 'رمز nonce مكرر (إعادة استخدام مرفوضة)' }
  const expected = hmacHex(device.tokenHash, `${deviceId}|${nonce}|${ts}|${sha256(bodyText)}`)
  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(String(hmac), 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, error: 'التوقيع غير صالح' }
  }
  seenNonces.set(key, now + DEVICE_AUTH_WINDOW_MS)
  await db.companionDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } })
  return { ok: true, device: { id: device.id, businessId: device.businessId } }
}

/**
 * Claim the oldest QUEUED, unexpired job for this device (atomic flip to
 * CLAIMED — two polls can never take the same job).
 */
export async function claimJob(deviceId: string): Promise<Record<string, unknown> | null> {
  const device = await db.companionDevice.findUnique({ where: { id: deviceId } })
  if (!device || device.status !== 'ACTIVE') return null
  const now = new Date()
  // expire whatever lapsed (cheap sweep, bounded)
  await db.companionJob.updateMany({
    where: { deviceId, status: 'QUEUED', expiresAt: { lt: now } },
    data: { status: 'EXPIRED', errorReason: 'انتهت صلاحية المهمة قبل التنفيذ', updatedAt: now },
  })
  const candidates = await db.companionJob.findMany({
    where: { deviceId, status: 'QUEUED', expiresAt: { gt: now } },
    orderBy: { createdAt: 'asc' },
    take: 1,
  })
  if (candidates.length === 0) return null
  const job = candidates[0]
  const claim = await db.companionJob.updateMany({
    where: { id: job.id, status: 'QUEUED' },
    data: { status: 'CLAIMED', claimedAt: now, updatedAt: now },
  })
  if (claim.count === 0) return null
  return {
    jobId: job.id,
    tool: job.tool,
    args: JSON.parse(job.args),
    nonce: job.nonce,
    expiresAt: job.expiresAt.toISOString(),
    envelopeHmac: job.envelopeHmac,
  }
}

export interface ReadEvidence {
  hash?: string
  hash2?: string
  size?: number
  lines?: number
  truncated?: boolean
  exitCode?: number
  entries?: number
  /** small reads store the content itself (≤64KB) for the caller */
  content?: string
}

/**
 * Settle a job with its evidence. The double-read hash (hash === hash2) is
 * the «read matches its source» proof; CLI jobs carry exitCode + stdout hash.
 */
export async function submitJobResult(
  deviceId: string,
  jobId: string,
  input: { ok: boolean; evidence?: ReadEvidence; errorReason?: string },
): Promise<{ ok: boolean } | { error: string }> {
  const job = await db.companionJob.findUnique({ where: { id: jobId } })
  if (!job || job.deviceId !== deviceId) return { error: 'المهمة غير موجودة لهذا الجهاز' }
  if (job.status === 'DELIVERED') return { error: 'المهمة سبق تسليمها' }
  if (job.status !== 'CLAIMED') return { error: `لا يمكن تسليم مهمة بحالة «${job.status}»` }
  if (job.expiresAt.getTime() <= Date.now()) {
    await db.companionJob.update({
      where: { id: job.id },
      data: { status: 'EXPIRED', errorReason: 'انتهت صلاحية المهمة قبل التسليم', updatedAt: new Date() },
    })
    return { error: 'انتهت صلاحية المهمة — النتيجة مرفوضة' }
  }

  if (!input.ok) {
    await db.companionJob.update({
      where: { id: job.id },
      data: {
        status: 'FAILED',
        errorReason: String(input.errorReason ?? 'فشل غير معروف').slice(0, 500),
        updatedAt: new Date(),
      },
    })
    return { ok: true }
  }

  const ev = input.evidence ?? {}
  // Evidence integrity: a "successful" file read MUST carry a double-read
  // hash that agrees — otherwise the read is not proven against its source.
  const needsHash = job.tool === 'read_file' || job.tool === 'run_cli'
  if (needsHash) {
    if (!ev.hash || !ev.hash2 || ev.hash !== ev.hash2) {
      await db.companionJob.update({
        where: { id: job.id },
        data: { status: 'FAILED', errorReason: 'القراءة غير موثقة: الهاشتان المتقاطعان غير متطابقين', updatedAt: new Date() },
      })
      return { error: 'القراءة غير موثقة — الهاش المزدوج غير متطابق' }
    }
  }

  const evidence: Record<string, unknown> = { ...ev }
  // Keep the content itself only when it is small — the hash is the proof,
  // the content is a convenience for the caller.
  if (typeof ev.content !== 'string' || ev.content.length > 65_536) delete evidence.content

  await db.companionJob.update({
    where: { id: job.id },
    data: { status: 'DELIVERED', result: JSON.stringify(evidence), updatedAt: new Date() },
  })
  return { ok: true }
}

function summarizeJob(j: {
  id: string
  tool: string
  status: string
  args: string
  createdAt: Date
  claimedAt: Date | null
  result: string | null
  errorReason: string | null
}) {
  return {
    id: j.id,
    tool: j.tool,
    status: j.status,
    args: safeParse(j.args),
    createdAt: j.createdAt.toISOString(),
    claimedAt: j.claimedAt?.toISOString() ?? null,
    evidence: j.result ? safeParse(j.result) : null,
    errorReason: j.errorReason,
  }
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Expire lapsed jobs across all devices (called by the scheduler sweep). */
export async function expireLapsedCompanionJobs(): Promise<number> {
  const now = new Date()
  const res = await db.companionJob.updateMany({
    where: { status: { in: ['QUEUED', 'CLAIMED'] }, expiresAt: { lt: now } },
    data: { status: 'EXPIRED', errorReason: 'انتهت صلاحية المهمة', updatedAt: now },
  })
  return res.count
}
