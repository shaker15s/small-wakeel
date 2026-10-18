// Runs in a separate Bun process to avoid global singleton/env/mock pollution.
// The transport here is a stub; this is NOT external mail delivery evidence.
import assert from 'node:assert/strict'
import { testDb } from './test-db'
Object.assign(process.env, { NODE_ENV: 'production', WAKIL_SECRETS_KEY: 'ab'.repeat(32), WAKIL_MAIL_TOKEN: 'synthetic-mail-credential-not-real', WAKIL_MAIL_ENDPOINT: 'https://mail.example.test/send', WAKIL_APP_URL: 'https://wakil.example.test' })
const db = await testDb()
const { queueMail, deliverMailBatch } = await import('../../src/lib/saas/mail')
const future = () => new Date(Date.now() + 3600_000), past = () => new Date(Date.now() - 1000)
const queued = () => db.$transaction((tx) => queueMail(tx, 'fixture@example.test', 'Safe\r\nSubject', 'synthetic mail text', future()))
try {
  const mail = await queued()
  let sends = 0
  const fake: Parameters<typeof deliverMailBatch>[1] = async (url, init) => {
    sends++; assert.equal(url, process.env.WAKIL_MAIL_ENDPOINT)
    assert.equal(init.headers['idempotency-key'], mail.id)
    assert.equal(init.headers.authorization, `Bearer ${process.env.WAKIL_MAIL_TOKEN}`)
    assert.deepEqual(JSON.parse(init.body), { to: 'fixture@example.test', subject: 'Safe  Subject', text: 'synthetic mail text' })
    await Bun.sleep(20)
    return { ok: true, body: null }
  }
  const pair = await Promise.all([deliverMailBatch(1, fake), deliverMailBatch(1, fake)])
  assert.equal(sends, 1); assert.equal(pair.reduce((sum, r) => sum + r.sent, 0), 1)
  const sent = await db.mailOutbox.findUniqueOrThrow({ where: { id: mail.id } })
  assert.equal(sent.status, 'sent'); assert.equal(sent.payload, ''); assert.equal(sent.attempts, 1)
  const failure = await queued()
  let attempts = 0
  const refuse: Parameters<typeof deliverMailBatch>[1] = async () => { attempts++; return { ok: false, body: null } }
  await deliverMailBatch(1, refuse)
  assert.equal((await deliverMailBatch(1, refuse)).processed, 0, 'backoff blocks immediate redelivery')
  for (let i = 0; i < 4; i++) {
    await db.mailOutbox.update({ where: { id: failure.id }, data: { nextAttemptAt: past() } })
    await deliverMailBatch(1, refuse)
  }
  const failed = await db.mailOutbox.findUniqueOrThrow({ where: { id: failure.id } })
  assert.equal(attempts, 5); assert.equal(failed.status, 'failed'); assert.equal(failed.attempts, 5)
  assert.notEqual(failed.payload, '')
  await db.mailOutbox.update({ where: { id: failure.id }, data: { expiresAt: past() } })
  await deliverMailBatch(1, refuse)
  assert.equal((await db.mailOutbox.findUniqueOrThrow({ where: { id: failure.id } })).payload, '')
  const leased = await queued()
  const stale: Parameters<typeof deliverMailBatch>[1] = async () => {
    // Another owner reclaimed/requeued the lease while this sender was paused.
    await db.mailOutbox.update({ where: { id: leased.id }, data: { status: 'pending', lockedAt: null, nextAttemptAt: future() } })
    return { ok: true, body: null }
  }
  assert.equal((await deliverMailBatch(1, stale)).sent, 0)
  const fenced = await db.mailOutbox.findUniqueOrThrow({ where: { id: leased.id } })
  assert.equal(fenced.status, 'pending'); assert.notEqual(fenced.payload, '')
  const crashed = await queued()
  await db.mailOutbox.update({ where: { id: crashed.id }, data: { status: 'sending', attempts: 5, lockedAt: new Date(Date.now() - 6 * 60_000) } })
  await deliverMailBatch(1, refuse)
  assert.equal((await db.mailOutbox.findUniqueOrThrow({ where: { id: crashed.id } })).status, 'failed')
  console.log('PASS: isolated encrypted mail outbox claim/backoff/retry/expiry/stale-lease fencing/header sanitation (stub transport only)')
} finally { await db.$disconnect() }
