// Validate shipped maintenance artifacts without src/tsconfig access. Not Docker
// certification or live mail delivery. Only the copied DB is ever written.
import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { cpSync, copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createClient } from '@libsql/client'
const root = process.cwd(), dir = mkdtempSync(join(tmpdir(), 'wakil-maintenance-'))
const path = join(dir, 'fixture.db'), oldKey = randomBytes(32).toString('hex'), nextKey = randomBytes(32).toString('hex')
const seal = (plain: string, key: string) => { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv); const body = Buffer.concat([cipher.update(plain), cipher.final()]); return 'wakil:v1:' + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64') }
const open = (raw: string, key: string) => { const bytes = Buffer.from(raw.slice(9), 'base64'), cipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString() }
const sql = createClient({ url: `file:${path}` })
const env = { ...process.env, NODE_ENV: 'production', DATABASE_URL: `file:${path}`, WAKIL_SECRETS_KEY: oldKey, WAKIL_NEW_SECRETS_KEY: nextKey, WAKIL_APP_URL: 'https://wakil.smoke.test', WAKIL_MAIL_ENDPOINT: 'https://mail.invalid/send', WAKIL_MAIL_TOKEN: 'synthetic-test-credential-not-real' }
async function run(name: string, args: string[] = [], overrides = {}, ok = true) {
  const child = Bun.spawn(['bun', join(dir, 'maintenance', name + '.js'), ...args], { cwd: dir, env: { ...env, ...overrides }, stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  assert.equal(code === 0, ok, `packaged ${name} exit ${code}: ${stdout}\n${stderr}`)
  assert.ok(!stdout.includes(oldKey) && !stdout.includes(nextKey) && !stderr.includes(oldKey) && !stderr.includes(nextKey), 'maintenance must not log key material')
  return stdout
}
try {
  copyFileSync(join(root, 'db/custom.db'), path)
  cpSync(join(root, 'build/maintenance'), join(dir, 'maintenance'), { recursive: true })
  cpSync(join(root, 'db/migrations'), join(dir, 'db/migrations'), { recursive: true })
  symlinkSync(resolve(root, '.next/standalone/node_modules'), join(dir, 'node_modules'), 'dir')
  await run('migrate'); await run('migrate')
  const migration = join(dir, 'db/migrations/20261018_saas/migration.sql'), source = readFileSync(migration, 'utf8')
  writeFileSync(migration, source + '\n-- unauthorized checksum drift\n'); await run('migrate', [], {}, false); writeFileSync(migration, source)
  const providers = (await sql.execute('SELECT id FROM ModelProvider')).rows
  for (const p of providers) await sql.execute({ sql: 'UPDATE ModelProvider SET apiKey=? WHERE id=?', args: [seal('synthetic-provider-' + p.id, oldKey), p.id] })
  const now = new Date().toISOString(), future = new Date(Date.now() + 86400_000).toISOString(), past = new Date(Date.now() - 40 * 86400_000).toISOString()
  await sql.execute({ sql: 'INSERT INTO Account (id,email,name,passwordHash,verifiedAt,disabledAt,mfaSecret,pendingMfaSecret,pendingMfaAt,mfaLastStep,recoveryHashes,createdAt) VALUES (?,?,?,?,?,NULL,?,?,?,-1,?,?)', args: ['maintenance-account', 'fixture@example.test', 'Synthetic only', 'synthetic-password-hash', now, seal('synthetic-totp', oldKey), seal('synthetic-pending-totp', oldKey), now, '[]', now] })
  for (const [id, status, next, expires] of [['future-mail', 'pending', future, future], ['expired-mail', 'failed', past, past]]) await sql.execute({ sql: 'INSERT INTO MailOutbox (id,payload,status,attempts,nextAttemptAt,expiresAt,createdAt) VALUES (?,?,?,0,?,?,?)', args: [id, seal('synthetic-mail', oldKey), status, next, expires, now] })
  await sql.execute({ sql: 'INSERT INTO AuthThrottle (id,attempts,windowAt) VALUES (?,1,?)', args: ['stale-throttle', past] })
  await sql.execute({ sql: 'INSERT INTO QuotaBucket (id,used) VALUES (?,5)', args: ['synthetic:2000-01-01'] })
  await run('rotate-provider-secrets', [], { WAKIL_SECRETS_KEY: '00'.repeat(32) }, false)
  const before = await sql.execute('SELECT apiKey FROM ModelProvider ORDER BY id')
  await run('rotate-provider-secrets')
  assert.deepEqual((await sql.execute('SELECT apiKey FROM ModelProvider ORDER BY id')).rows, before.rows)
  await run('rotate-provider-secrets', ['--apply'])
  const after = (await sql.execute('SELECT id,apiKey FROM ModelProvider')).rows
  for (const p of after) { assert.equal(open(String(p.apiKey), nextKey), 'synthetic-provider-' + p.id); assert.throws(() => open(String(p.apiKey), oldKey)) }
  const account = (await sql.execute("SELECT * FROM Account WHERE id='maintenance-account'")).rows[0]
  assert.equal(open(String(account.mfaSecret), nextKey), 'synthetic-totp'); assert.equal(open(String(account.pendingMfaSecret), nextKey), 'synthetic-pending-totp')
  assert.equal(account.passwordHash, 'synthetic-password-hash')
  assert.equal(open(String((await sql.execute("SELECT payload FROM MailOutbox WHERE id='future-mail'")).rows[0].payload), nextKey), 'synthetic-mail')
  assert.equal(JSON.parse(await run('mail-worker', [], { WAKIL_SECRETS_KEY: nextKey })).processed, 0)
  assert.equal((await sql.execute("SELECT ok FROM WorkerHeartbeat WHERE id='mail'")).rows[0].ok, 1)
  assert.equal((await sql.execute("SELECT payload FROM MailOutbox WHERE id='expired-mail'")).rows[0].payload, '')
  assert.equal((await sql.execute('SELECT COUNT(*) n FROM AuthThrottle')).rows[0].n, 0)
  assert.equal((await sql.execute('SELECT COUNT(*) n FROM QuotaBucket')).rows[0].n, 0)
  const owner = (await sql.execute('SELECT businessId FROM User LIMIT 1')).rows[0]
  await sql.execute({ sql: 'INSERT INTO User (id,businessId,name,role,createdAt) VALUES (?,?,?,?,?)', args: ['restore-user', owner.businessId, 'Synthetic restore owner', 'owner', now] })
  await sql.execute({ sql: 'INSERT INTO Membership (id,accountId,userId,createdAt) VALUES (?,?,?,?)', args: ['restore-member', 'maintenance-account', 'restore-user', now] })
  await sql.execute({ sql: 'INSERT INTO Session (id,tokenHash,accountId,membershipId,createdAt,lastSeenAt,expiresAt) VALUES (?,?,?,?,?,?,?)', args: ['restore-session', '11'.repeat(32), 'maintenance-account', 'restore-member', now, now, future] })
  await sql.execute({ sql: 'INSERT INTO AccountToken (id,tokenHash,accountId,purpose,expiresAt,createdAt) VALUES (?,?,?,?,?,?)', args: ['restore-link', '22'.repeat(32), 'maintenance-account', 'reset', future, now] })
  assert.equal(JSON.parse(await run('restore-quarantine')).applied, false)
  assert.equal((await sql.execute("SELECT disabledAt FROM Account WHERE id='maintenance-account'")).rows[0].disabledAt, null)
  assert.equal(JSON.parse(await run('restore-quarantine', ['--apply'])).applied, true)
  assert.notEqual((await sql.execute("SELECT disabledAt FROM Account WHERE id='maintenance-account'")).rows[0].disabledAt, null)
  assert.notEqual((await sql.execute("SELECT revokedAt FROM Session WHERE id='restore-session'")).rows[0].revokedAt, null)
  assert.notEqual((await sql.execute("SELECT usedAt FROM AccountToken WHERE id='restore-link'")).rows[0].usedAt, null)
  assert.equal((await sql.execute("SELECT payload FROM MailOutbox WHERE id='future-mail'")).rows[0].payload, '')
  // Quarantine never destroys the active MFA secret; recovery needs the right key.
  assert.equal(open(String((await sql.execute("SELECT mfaSecret FROM Account WHERE id='maintenance-account'")).rows[0].mfaSecret), nextKey), 'synthetic-totp')
  const backupPath = join(dir, 'private-backups', 'snapshot.db')
  await run('db-snapshot', ['--output', backupPath])
  assert.equal(statSync(backupPath).mode & 0o777, 0o600)
  await run('db-snapshot', ['--output', backupPath], {}, false)
  const restored = createClient({ url: `file:${backupPath}` })
  try {
    assert.equal((await restored.execute('PRAGMA integrity_check')).rows[0].integrity_check, 'ok')
    assert.notEqual((await restored.execute("SELECT revokedAt FROM Session WHERE id='restore-session'")).rows[0].revokedAt, null)
    assert.equal(open(String((await restored.execute("SELECT mfaSecret FROM Account WHERE id='maintenance-account'")).rows[0].mfaSecret), nextKey), 'synthetic-totp')
  } finally { restored.close() }
  console.log('PASS: packaged restore quarantine/dry-run/session+link revocation/account containment and private snapshot/no-overwrite/MFA restore (synthetic local storage)')
  console.log('PASS: packaged migration idempotency/checksum refusal, provider+MFA+pending-MFA+mail rotation/dry-run/wrong-key refusal and mail worker expiry/retention; no source tree, no external email')
} finally { sql.close(); rmSync(dir, { recursive: true, force: true }) }
