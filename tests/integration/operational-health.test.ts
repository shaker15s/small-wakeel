import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { testDb } from '../helpers/test-db'
import { operationalHealth } from '@/lib/saas/health'
let db: Awaited<ReturnType<typeof testDb>>
const prefix = `operational-${randomUUID()}`
const keys = ['WAKIL_SAAS_ENABLED', 'WAKIL_SIGNUP_ENABLED', 'WAKIL_MAIL_ENDPOINT', 'WAKIL_MAIL_TOKEN', 'WAKIL_APP_URL', 'WAKIL_SECRETS_KEY']
const env = { ...process.env }
beforeAll(async () => { db = await testDb() })
afterEach(() => { for (const k of keys) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k] } })
afterAll(async () => { await db.mailOutbox.deleteMany({ where: { id: { startsWith: prefix } } }) })
test('operator diagnostics report stalled/failed mail and missing worker without leaking payloads', async () => {
  Object.assign(process.env, { WAKIL_SAAS_ENABLED: '1', WAKIL_SIGNUP_ENABLED: '1', WAKIL_MAIL_ENDPOINT: 'https://mail.example.test/send', WAKIL_MAIL_TOKEN: 'synthetic-health-credential-not-real', WAKIL_APP_URL: 'https://app.example.test', WAKIL_SECRETS_KEY: 'dd'.repeat(32) })
  const previous = await db.workerHeartbeat.findUnique({ where: { id: 'mail' } })
  try {
    await db.workerHeartbeat.deleteMany({ where: { id: 'mail' } })
    await db.mailOutbox.create({ data: { id: prefix + '-stale', payload: 'private-recipient-and-token-must-not-escape', createdAt: new Date(Date.now() - 360_000), expiresAt: new Date(Date.now() + 86400_000) } })
    await db.mailOutbox.create({ data: { id: prefix + '-failed', payload: 'private-failed-payload', status: 'failed', attempts: 5, expiresAt: new Date(Date.now() + 86400_000) } })
    const result = await operationalHealth()
    expect(result.alerts).toContain('mail_worker_missing_or_stale')
    expect(result.alerts).toContain('mail_queue_delayed'); expect(result.alerts).toContain('mail_terminal_failures')
    expect(result.mail.externalDelivery).toBe('not_probed')
    expect(JSON.stringify(result)).not.toContain('private-')
    await db.workerHeartbeat.create({ data: { id: 'mail', runId: prefix, startedAt: new Date(), finishedAt: new Date(), ok: true } })
    expect((await operationalHealth()).alerts).not.toContain('mail_worker_missing_or_stale')
    await db.workerHeartbeat.update({ where: { id: 'mail' }, data: { finishedAt: new Date(Date.now() - 360_000) } })
    expect((await operationalHealth()).alerts).toContain('mail_worker_missing_or_stale')
    await db.workerHeartbeat.update({ where: { id: 'mail' }, data: { finishedAt: new Date(), ok: false } })
    expect((await operationalHealth()).alerts).toContain('mail_worker_failed')
  } finally {
    await db.workerHeartbeat.deleteMany({ where: { id: 'mail' } })
    if (previous) await db.workerHeartbeat.create({ data: previous })
  }
})
