// One-shot production boot + HTTP security smoke on a disposable DB.
// This is NOT a browser test or a connector E2E test.
import { applyMigrations } from './lib/migrations'
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createHash, randomBytes, randomInt } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createClient } from '@libsql/client'
import { browserSmoke } from './browser-smoke'
import { saasHttpSmoke } from './saas-http-smoke'
import { financialHttpSmoke } from './financial-http-smoke'

const root = process.cwd()
const dir = mkdtempSync(join(tmpdir(), 'wakil-production-smoke-'))
const target = join(dir, 'custom.db')
copyFileSync(join(root, 'db/custom.db'), target)
await applyMigrations(target)
const sql = createClient({ url: `file:${target}` })
const users = (await sql.execute("SELECT id, businessId, role FROM User ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END")).rows
const owner = users.find((u) => u.role === 'owner')!
const cashier = users.find((u) => u.businessId === owner.businessId && u.role === 'cashier')
assert.ok(cashier, 'same-tenant cashier fixture')
const other = users.find((u) => u.businessId !== owner.businessId)!
const otherOp = (await sql.execute({ sql: 'SELECT id FROM Operation WHERE businessId = ? LIMIT 1', args: [other.businessId] })).rows[0]
sql.close()
const token = randomBytes(32).toString('hex')
const staffToken = randomBytes(32).toString('hex')
const cashierToken = randomBytes(32).toString('hex')
const credentials = JSON.stringify([
  { userId: owner.id, tokenHash: createHash('sha256').update(token).digest('hex'), admin: true },
  { userId: cashier.id, tokenHash: createHash('sha256').update(cashierToken).digest('hex') },
  { userId: other.id, tokenHash: createHash('sha256').update(staffToken).digest('hex') },
])
let server: ChildProcess | undefined

async function stop() {
  if (!server || server.exitCode !== null) return
  const child = server
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  const deadline = setTimeout(() => child.kill('SIGKILL'), 5_000)
  try { await exited } finally { clearTimeout(deadline); server = undefined }
}

async function boot(config?: string, saas = false, appUrl = 'https://wakil.smoke.test') {
  const port = randomInt(10_000, 60_000)
  const env: NodeJS.ProcessEnv = {
    ...process.env, NODE_ENV: 'production', DATABASE_URL: `file:${target}`,
    HOSTNAME: '0.0.0.0', PORT: String(port), WAKIL_SAAS_ENABLED: '0', WAKIL_SIGNUP_ENABLED: '0', WAKIL_OFFLINE: '1', WAKIL_SCHEDULER: 'off', WAKIL_STRICT_APPROVALS: '0',
  }
  // Never inherit an operator's real credentials or provider encryption key.
  delete env.WAKIL_AUTH_CREDENTIALS
  delete env.WAKIL_ACCESS_TOKEN
  delete env.WAKIL_SECRETS_KEY
  if (config) env.WAKIL_AUTH_CREDENTIALS = config
  if (saas) Object.assign(env, { WAKIL_SAAS_ENABLED: '1', WAKIL_SIGNUP_ENABLED: '1', WAKIL_APP_URL: appUrl, WAKIL_ALLOWED_ORIGINS: appUrl, WAKIL_SECRETS_KEY: '42'.repeat(32), WAKIL_MAIL_ENDPOINT: 'https://mail.invalid/send', WAKIL_MAIL_TOKEN: 'synthetic-mail-credential-not-real' })
  const child = spawn(process.execPath.includes('bun') ? 'node' : process.execPath, [resolve(root, '.next/standalone/server.js')], { env, stdio: ['ignore', 'inherit', 'inherit'] })
  server = child
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Production server exited before ready')
    try { if ((await fetch(base + '/api/bootstrap')).status === 401) return base } catch { /* starting */ }
    await new Promise((done) => setTimeout(done, 200))
  }
  throw new Error('Production boot timed out')
}

try {
  let base = await boot()
  for (const path of ['/api/bootstrap', '/api/providers', '/api/health', '/api/operations/unknown/confirm']) {
    assert.equal((await fetch(base + path)).status, 401, `unconfigured production: ${path}`)
  }
  console.log('PASS: production without identity config fails closed')
  await stop()
  base = await boot(credentials)
  const auth = { authorization: `Bearer ${token}` }
  const get = (path: string, headers: Record<string, string> = auth) => fetch(base + path, { headers })
  const bootstrap = await get('/api/bootstrap')
  assert.equal(bootstrap.status, 200)
  assert.match(bootstrap.headers.get('cache-control') ?? '', /no-store/)
  const payload = await bootstrap.json() as any
  assert.deepEqual(payload.businesses.map((b: any) => b.id), [owner.businessId])
  assert.deepEqual(payload.businesses[0].users.map((u: any) => u.id), [owner.id])
  assert.ok(!JSON.stringify(payload).includes('apiKey'))
  assert.equal((await get('/api/health')).status, 200)
  assert.equal((await fetch(base + '/api/providers')).status, 401)
  assert.equal((await get('/api/providers', { authorization: `Bearer ${staffToken}` })).status, 403)
  assert.equal((await get(`/api/items?businessId=${other.businessId}`)).status, 403)
  assert.equal((await get('/api/bootstrap', { ...auth, 'x-wakil-user': String(other.id) })).status, 403)
  if (otherOp) assert.equal((await get(`/api/operations/${otherOp.id}/confirm`)).status, 404)
  const bridge = await fetch(base + '/api/cli-anything/inspect', {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ appName: 'Excel' }),
  })
  assert.equal(bridge.status, 409)
  assert.equal((await bridge.json() as any).status, 'not_connected')
  const page = await fetch(base)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<html[^>]*lang="ar"[^>]*dir="rtl"/)
  console.log('PASS: production HTTP auth / tenant denial / connector fail-closed / RTL HTML')

  await financialHttpSmoke({
    base, databaseUrl: `file:${target}`,
    owner: { id: String(owner.id), businessId: String(owner.businessId), token },
    cashier: { id: String(cashier.id), businessId: String(cashier.businessId), token: cashierToken },
    foreign: { id: String(other.id), businessId: String(other.businessId), token: staffToken },
  })

  const screens = spawn('bun', ['scripts/screens-audit.tsx'], {
    cwd: root, env: { ...process.env, WAKIL_URL: base, WAKIL_SMOKE_TOKEN: token }, stdio: ['ignore', 'inherit', 'inherit'],
  })
  const [exitCode] = await once(screens, 'exit')
  assert.equal(exitCode, 0, 'server-rendered screens audit')
  await stop()
  base = await boot(undefined, true)
  await saasHttpSmoke(base, `file:${target}`, '42'.repeat(32))
  await browserSmoke(`file:${target}`, '42'.repeat(32), async (origin) => { await stop(); return boot(undefined, true, origin) })
  console.log('PASS: production boot, HTTP and Chromium smoke (synthetic DB only)')
} finally {
  await stop()
  rmSync(dir, { recursive: true, force: true })
}
