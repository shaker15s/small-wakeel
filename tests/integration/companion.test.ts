// وكيل — PR-011 (plan v2 §10, P6): COMPANION — read-only bridge, the proof
// battery. Each test is a trust-boundary from the plan's P6 acceptance list:
//   1. full loop: the delivered read MATCHES ITS SOURCE (hash of the exact
//      bytes we wrote — «القراءة الخارجية تطابق مصدرها» as evidence)
//   2. a success whose double-read hash disagrees is refused (not delivered)
//   3. revocation is immediate: claims 403, pending jobs expire
//   4. cross-tenant: another tenant's device claims nothing, settles nothing
//   5. path traversal outside the allowlist is refused by the bridge
//   6. a symlink escaping the allowed root is refused
//   7. CLI: pinned executable + separated argv — no shell, injection literal
//   8. auth: replayed nonce and stale timestamp are refused
//   9. jobs are expiring: a lapsed job is never claimed, it is EXPIRED
//   10. list_dir is bounded and its listing hash is verifiable
//
// NOTE (honest scope): this proves the SHARED LOGIC on Linux. Real Windows
// acceptance (target machine, DPAPI key storage, signed updates) is a
// separate gate per the plan — it is NOT claimed here.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID, createHash, createHmac } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testDb } from '../helpers/test-db'
import { createNewBusinessWithDefaults } from '@/lib/domain/business-builder'
import { GET as companionGET, POST as companionPOST } from '@/app/api/companion/route'
import { POST as claimPOST } from '@/app/api/companion/claim/route'
import { POST as resultPOST } from '@/app/api/companion/result/route'
import { executeJob, executeReadFile, executeRunCli } from '../../companion/bridge-core.mjs'

let db: Awaited<ReturnType<typeof testDb>>
const ids: string[] = []
let tmpRoot: string
let outsideDir: string

beforeAll(async () => {
  db = await testDb()
  tmpRoot = mkdtempSync(join(tmpdir(), 'wakil-companion-'))
  outsideDir = mkdtempSync(join(tmpdir(), 'wakil-companion-outside-'))
})

afterAll(async () => {
  await db.business.deleteMany({ where: { id: { in: ids } } })
  rmSync(tmpRoot, { recursive: true, force: true })
  rmSync(outsideDir, { recursive: true, force: true })
})

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')

async function shop() {
  const created = await createNewBusinessWithDefaults({ name: `companion-${randomUUID()}`, type: 'supermarket' })
  ids.push(created.id)
  return {
    business: await db.business.findUniqueOrThrow({ where: { id: created.id } }),
    user: await db.user.findUniqueOrThrow({ where: { id: created.users[0].id } }),
  }
}

function post(body: unknown, businessId?: string) {
  return companionPOST(new Request('http://test/api/companion', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...(body as object), ...(businessId ? { businessId } : {}) }),
  }))
}

async function enrollAndActivate(businessId: string, userId: string, allowlist: { paths: string[]; cli: Array<{ command: string; label?: string }> }) {
  const e = await post({ action: 'enroll', deviceName: 'جهاز المالك', userId }, businessId)
  expect(e.status).toBe(201)
  const { code } = (await e.json()) as { code: string }
  const a = await post({ action: 'activate', code, deviceName: 'جهاز المالك', allowlist }, undefined)
  expect(a.status).toBe(201)
  return (await a.json()) as { deviceId: string; token: string }
}

function signedHeaders(deviceId: string, token: string, bodyText: string, opts: { nonce?: string; ts?: string } = {}) {
  const nonce = opts.nonce ?? randomUUID()
  const ts = opts.ts ?? String(Date.now())
  const signature = createHmac('sha256', sha256(token)).update(`${deviceId}|${nonce}|${ts}|${sha256(bodyText)}`).digest('hex')
  return {
    'content-type': 'application/json',
    'x-companion-device': deviceId,
    'x-companion-nonce': nonce,
    'x-companion-ts': ts,
    'x-companion-hmac': signature,
  }
}

describe('PR-011 — full loop: the read matches its source', () => {
  test('enroll → activate → dispatch → claim → execute → deliver; hash equals the source bytes', async () => {
    const { business, user } = await shop()
    const { deviceId, token } = await enrollAndActivate(business.id, user.id, { paths: [tmpRoot], cli: [] })

    const content = `فاتورة رقم 1001 — سوبر ماركت النور\nإجمالي: 1,250.00 جنيه\n${randomUUID()}`
    const filePath = join(tmpRoot, 'invoice-1001.txt')
    writeFileSync(filePath, content, 'utf8')

    const d = await post({ action: 'job', deviceId, userId: user.id, tool: 'read_file', args: { path: filePath } }, business.id)
    expect(d.status).toBe(201)
    const { jobId } = (await d.json()) as { jobId: string }

    // The bridge polls (signed claim):
    const claimBody = '{}'
    const c1 = await claimPOST(new Request('http://test/api/companion/claim', {
      method: 'POST', headers: signedHeaders(deviceId, token, claimBody), body: claimBody,
    }))
    expect(c1.status).toBe(200)
    const job = (await c1.json()) as { jobId: string; tool: string; args: { path: string }; envelopeHmac: string }
    expect(job.jobId).toBe(jobId)

    // The bridge executes LOCALLY (the allowlist is enforced here):
    const { ok, evidence } = (await executeJob({ paths: [tmpRoot], cli: [] }, { tool: job.tool, args: job.args })) as {
      ok: boolean
      evidence: { hash: string; hash2: string; content?: string; size: number; lines: number }
    }
    expect(ok).toBe(true)
    expect(evidence.hash).toBe(evidence.hash2)
    // THE proof: the delivered hash equals the hash of the exact source bytes
    expect(evidence.hash).toBe(sha256(content))
    expect(evidence.content).toBe(content)

    // The bridge reports (signed result):
    const rBody = JSON.stringify({ jobId, ok: true, evidence })
    const r1 = await resultPOST(new Request('http://test/api/companion/result', {
      method: 'POST', headers: signedHeaders(deviceId, token, rBody), body: rBody,
    }))
    expect(r1.status).toBe(200)

    const settled = await db.companionJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(settled.status).toBe('DELIVERED')
    const ev = JSON.parse(settled.result!) as { hash: string; size: number; content: string }
    expect(ev.hash).toBe(sha256(content))
    expect(ev.content).toBe(content)

    // And the owner sees the job + evidence in the device list (honest state):
    const listRes = await companionGET(new Request(`http://test/api/companion?businessId=${business.id}`))
    expect(listRes.status).toBe(200)
    const list = (await listRes.json()) as { devices: Array<{ id: string; status: string; jobs: Array<{ status: string; evidence: { hash: string } }> }> }
    expect(list.devices[0].status).toBe('ACTIVE')
    expect(list.devices[0].jobs[0].status).toBe('DELIVERED')
    expect(list.devices[0].jobs[0].evidence.hash).toBe(sha256(content))
  })
})

describe('PR-011 — evidence integrity', () => {
  test('a success whose double-read hash disagrees is refused and marked failed', async () => {
    const { business, user } = await shop()
    const { deviceId, token } = await enrollAndActivate(business.id, user.id, { paths: [tmpRoot], cli: [] })
    const f = join(tmpRoot, 'doc.txt')
    writeFileSync(f, 'بيانات', 'utf8')
    const d = await post({ action: 'job', deviceId, userId: user.id, tool: 'read_file', args: { path: f } }, business.id)
    expect(d.status).toBe(201)
    const { jobId } = (await d.json()) as { jobId: string }

    // the bridge claims it, then reports FORGED evidence (hashes disagree):
    await claimPOST(new Request('http://test/api/companion/claim', {
      method: 'POST', headers: signedHeaders(deviceId, token, '{}'), body: '{}',
    }))

    const rBody = JSON.stringify({ jobId, ok: true, evidence: { hash: 'aa'.repeat(32), hash2: 'bb'.repeat(32), size: 12 } })
    const r1 = await resultPOST(new Request('http://test/api/companion/result', {
      method: 'POST', headers: signedHeaders(deviceId, token, rBody), body: rBody,
    }))
    expect(r1.status).toBe(409)

    const settled = await db.companionJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(settled.status).toBe('FAILED')
    expect(settled.errorReason).toContain('غير موثقة')
  })
})

describe('PR-011 — revocation is immediate', () => {
  test('a revoked device claims nothing (403) and its pending jobs expire', async () => {
    const { business, user } = await shop()
    const { deviceId, token } = await enrollAndActivate(business.id, user.id, { paths: [tmpRoot], cli: [] })
    const f = join(tmpRoot, 'x.txt')
    writeFileSync(f, 'x', 'utf8')
    const d = await post({ action: 'job', deviceId, userId: user.id, tool: 'read_file', args: { path: f } }, business.id)
    expect(d.status).toBe(201)
    const { jobId } = (await d.json()) as { jobId: string }

    const rev = await post({ action: 'revoke', deviceId, userId: user.id }, business.id)
    expect(rev.status).toBe(200)

    const c = await claimPOST(new Request('http://test/api/companion/claim', {
      method: 'POST', headers: signedHeaders(deviceId, token, '{}'), body: '{}',
    }))
    expect(c.status).toBe(403)

    const settled = await db.companionJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(settled.status).toBe('EXPIRED')
    expect(settled.errorReason).toContain('فصل الجهاز')

    const device = await db.companionDevice.findUniqueOrThrow({ where: { id: deviceId } })
    expect(device.status).toBe('REVOKED')

    // New jobs can't even be dispatched to a revoked device:
    const d2 = await post({ action: 'job', deviceId, tool: 'read_file', args: { path: f } }, business.id)
    expect(d2.status).toBe(400)
  })
})

describe('PR-011 — tenant isolation', () => {
  test('another tenant’s device claims nothing and settles nothing', async () => {
    const A = await shop()
    const B = await shop()
    const { deviceId: devA } = await enrollAndActivate(A.business.id, A.user.id, { paths: [tmpRoot], cli: [] })
    const { deviceId: devB, token: tokB } = await enrollAndActivate(B.business.id, B.user.id, { paths: [tmpRoot], cli: [] })

    const f = join(tmpRoot, 'secret-A.txt')
    writeFileSync(f, 'سري لأ', 'utf8')
    const d = await post({ action: 'job', deviceId: devA, userId: A.user.id, tool: 'read_file', args: { path: f } }, A.business.id)
    const { jobId } = (await d.json()) as { jobId: string }

    // B polls: empty claim — A's job is invisible to B.
    const c = await claimPOST(new Request('http://test/api/companion/claim', {
      method: 'POST', headers: signedHeaders(devB, tokB, '{}'), body: '{}',
    }))
    expect(c.status).toBe(200)
    expect((await c.json()) as object).toEqual({})

    // A's job is still QUEUED — B cannot even see it, let alone settle it:
    const rBody = JSON.stringify({ jobId, ok: true, evidence: { hash: sha256('x'), hash2: sha256('x') } })
    const r = await resultPOST(new Request('http://test/api/companion/result', {
      method: 'POST', headers: signedHeaders(devB, tokB, rBody), body: rBody,
    }))
    expect(r.status).toBe(404)
    const settled = await db.companionJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(settled.status).toBe('QUEUED') // still untouched
  })
})

describe('PR-011 — path boundary (bridge-side enforcement)', () => {
  test('path traversal outside the allowlist is refused; nothing is read', async () => {
    const { business, user } = await shop()
    const { deviceId, token } = await enrollAndActivate(business.id, user.id, { paths: [tmpRoot], cli: [] })
    const secret = join(outsideDir, 'outside.txt')
    writeFileSync(secret, 'سري خارج النطاق', 'utf8')

    const d = await post({ action: 'job', deviceId, userId: user.id, tool: 'read_file', args: { path: secret } }, business.id)
    expect(d.status).toBe(201) // dispatch is fine; the BRIDGE enforces the root
    const { jobId } = (await d.json()) as { jobId: string }

    const claimBody = '{}'
    const c = await claimPOST(new Request('http://test/api/companion/claim', {
      method: 'POST', headers: signedHeaders(deviceId, token, claimBody), body: claimBody,
    }))
    const job = (await c.json()) as { jobId: string; args: { path: string } }
    let threw = ''
    try {
      await executeJob({ paths: [tmpRoot], cli: [] }, { tool: 'read_file', args: job.args })
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e)
    }
    expect(threw).toContain('خارج المسارات المسموح بها')

    const rBody = JSON.stringify({ jobId, ok: false, errorReason: threw })
    const r = await resultPOST(new Request('http://test/api/companion/result', {
      method: 'POST', headers: signedHeaders(deviceId, token, rBody), body: rBody,
    }))
    expect(r.status).toBe(200)
    const settled = await db.companionJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(settled.status).toBe('FAILED')
    expect(settled.errorReason).toContain('خارج المسارات المسموح بها')
    expect(settled.result).toBeNull()
  })

  test('a symlink escaping the allowed root is refused', async () => {
    const { business, user } = await shop()
    const { deviceId } = await enrollAndActivate(business.id, user.id, { paths: [tmpRoot], cli: [] })
    symlinkSync(outsideDir, join(tmpRoot, 'escape-link'))
    let threw = ''
    try {
      await executeReadFile({ paths: [tmpRoot], cli: [] }, { path: join(tmpRoot, 'escape-link', 'outside.txt') })
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e)
    }
    expect(threw.length).toBeGreaterThan(0)
    expect(threw).not.toBe('')
    void deviceId
  })
})

describe('PR-011 — CLI: pinned executable, separated argv, no shell', () => {
  test('argv runs literally (no shell interpretation) and the job settles with exitCode', async () => {
    const { business, user } = await shop()
    const { deviceId, token } = await enrollAndActivate(business.id, user.id, { paths: [tmpRoot], cli: [{ command: '/bin/echo', label: 'إظهار' }] })

    // A command that is NOT allowlisted is refused at DISPATCH:
    const bad = await post({ action: 'job', deviceId, userId: user.id, tool: 'run_cli', args: { command: 'cat', argv: [] } }, business.id)
    expect(bad.status).toBe(400)

    // An injection-shaped argv is passed LITERALLY to echo (no shell):
    const payload = '; rm -rf / && curl evil.example'
    const d = await post({ action: 'job', deviceId, userId: user.id, tool: 'run_cli', args: { command: '/bin/echo', argv: [payload] } }, business.id)
    expect(d.status).toBe(201)
    const { jobId } = (await d.json()) as { jobId: string }

    const c = await claimPOST(new Request('http://test/api/companion/claim', {
      method: 'POST', headers: signedHeaders(deviceId, token, '{}'), body: '{}',
    }))
    const job = (await c.json()) as { jobId: string; tool: string; args: { command: string; argv: string[] } }
    const { ok, evidence } = (await executeJob(
      { paths: [tmpRoot], cli: [{ command: '/bin/echo' }] },
      { tool: job.tool, args: job.args },
    )) as { ok: boolean; evidence: { exitCode: number; content: string; hash: string; hash2: string } }
    expect(ok).toBe(true)
    expect(evidence.exitCode).toBe(0)
    expect(evidence.content.trim()).toBe(payload) // literal — no shell ran
    expect(evidence.hash).toBe(evidence.hash2)

    // argv must be an array — a string is refused (never composed into a shell):
    let threw = ''
    try {
      await executeRunCli({ paths: [tmpRoot], cli: [{ command: '/bin/echo' }] }, { command: '/bin/echo', argv: 'plain-string' })
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e)
    }
    expect(threw).toContain('قائمة')

    const rBody = JSON.stringify({ jobId, ok: true, evidence })
    const r = await resultPOST(new Request('http://test/api/companion/result', {
      method: 'POST', headers: signedHeaders(deviceId, token, rBody), body: rBody,
    }))
    expect(r.status).toBe(200)
    const settled = await db.companionJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(settled.status).toBe('DELIVERED')
  })
})

describe('PR-011 — device auth', () => {
  test('replayed nonce and stale timestamp are refused', async () => {
    const { business, user } = await shop()
    const { deviceId, token } = await enrollAndActivate(business.id, user.id, { paths: [tmpRoot], cli: [] })

    const body = '{}'
    const headers = signedHeaders(deviceId, token, body, { nonce: 'fixed-nonce-1' })
    const c1 = await claimPOST(new Request('http://test/api/companion/claim', { method: 'POST', headers, body }))
    expect(c1.status).toBe(200)
    const c2 = await claimPOST(new Request('http://test/api/companion/claim', { method: 'POST', headers, body }))
    expect(c2.status).toBe(401)

    const stale = signedHeaders(deviceId, token, body, { ts: String(Date.now() - 5 * 60_000) })
    const c3 = await claimPOST(new Request('http://test/api/companion/claim', { method: 'POST', headers: stale, body }))
    expect(c3.status).toBe(401)

    // A wrong token never authenticates:
    const wrong = signedHeaders(deviceId, token + '0', body)
    const c4 = await claimPOST(new Request('http://test/api/companion/claim', { method: 'POST', headers: wrong, body }))
    expect(c4.status).toBe(401)
  })
})

describe('PR-011 — jobs are expiring', () => {
  test('a lapsed job is never claimed and ends EXPIRED', async () => {
    const { business, user } = await shop()
    const { deviceId, token } = await enrollAndActivate(business.id, user.id, { paths: [tmpRoot], cli: [] })
    const f = join(tmpRoot, 'later.txt')
    writeFileSync(f, 'later', 'utf8')
    const d = await post({ action: 'job', deviceId, userId: user.id, tool: 'read_file', args: { path: f } }, business.id)
    expect(d.status).toBe(201)
    const { jobId } = (await d.json()) as { jobId: string }

    // Age the job past its TTL:
    await db.companionJob.update({ where: { id: jobId }, data: { expiresAt: new Date(Date.now() - 1000) } })

    const c = await claimPOST(new Request('http://test/api/companion/claim', {
      method: 'POST', headers: signedHeaders(deviceId, token, '{}'), body: '{}',
    }))
    expect(c.status).toBe(200)
    expect((await c.json()) as object).toEqual({})
    const settled = await db.companionJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(settled.status).toBe('EXPIRED')
  })
})

describe('PR-011 — bounded listing', () => {
  test('list_dir returns bounded entries with a verifiable listing hash', async () => {
    const { business, user } = await shop()
    const { deviceId, token } = await enrollAndActivate(business.id, user.id, { paths: [tmpRoot], cli: [] })
    const sub = join(tmpRoot, `sub-${randomUUID().slice(0, 6)}`)
    mkdirSync(sub)
    writeFileSync(join(sub, 'a.txt'), 'أ')
    writeFileSync(join(sub, 'b.txt'), 'ب')
    writeFileSync(join(sub, 'c.txt'), 'ج')

    const d = await post({ action: 'job', deviceId, userId: user.id, tool: 'list_dir', args: { path: sub } }, business.id)
    const { jobId } = (await d.json()) as { jobId: string }
    const c = await claimPOST(new Request('http://test/api/companion/claim', {
      method: 'POST', headers: signedHeaders(deviceId, token, '{}'), body: '{}',
    }))
    const job = (await c.json()) as { jobId: string; tool: string; args: { path: string } }
    const { ok, evidence } = (await executeJob({ paths: [tmpRoot], cli: [] }, { tool: job.tool, args: job.args })) as {
      ok: boolean
      evidence: { entries: number; hash: string; hash2: string; content: string }
    }
    expect(ok).toBe(true)
    expect(evidence.entries).toBe(3)
    expect(evidence.hash).toBe(evidence.hash2)
    const listing = JSON.parse(evidence.content) as Array<{ name: string }>
    expect(listing.map((l) => l.name).sort()).toEqual(['a.txt', 'b.txt', 'c.txt'])

    const rBody = JSON.stringify({ jobId, ok: true, evidence })
    const r = await resultPOST(new Request('http://test/api/companion/result', {
      method: 'POST', headers: signedHeaders(deviceId, token, rBody), body: rBody,
    }))
    expect(r.status).toBe(200)
  })
})
