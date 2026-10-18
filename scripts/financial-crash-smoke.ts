// Real SIGKILL/reopen evidence for SQLite execution atomicity, NOT storage/HA
// certification. Uses a disposable migrated DB and separate executor processes.
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { PrismaLibSQL } from '@prisma/adapter-libsql'
import { applyMigrations } from './lib/migrations'
const dir = mkdtempSync(join(tmpdir(), 'wakil-financial-crash-')), path = join(dir, 'fixture.db')
copyFileSync(join(process.cwd(), 'db/custom.db'), path)
applyMigrations(path)
const db = new PrismaClient({ adapter: new PrismaLibSQL({ url: `file:${path}` }) })
const env = { ...process.env, NODE_ENV: 'production', DATABASE_URL: `file:${path}`, WAKIL_SAAS_ENABLED: '0', WAKIL_SCHEDULER: 'off' }
async function worker(opId: string, userId: string, phase: string, inspect?: () => Promise<void>) {
  const child = Bun.spawn(['bun', 'tests/helpers/financial-process-worker.ts', opId, userId, phase], { env, stdout: 'pipe', stderr: 'pipe' })
  const errors = new Response(child.stderr).text()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    if (!inspect) {
      const output = await new Response(child.stdout).text(), code = await child.exited
      assert.equal(code, 0, output + await errors)
      return JSON.parse(output.trim().split('\n').at(-1)!)
    }
    const reader = child.stdout.getReader()
    try {
      await Promise.race([
        (async () => {
          let text = ''
          while (true) {
            const next = await reader.read()
            if (next.done) throw new Error(`Executor exited before ${phase}: ${text}\n${await errors}`)
            text += new TextDecoder().decode(next.value)
            if (text.includes(`PAUSED:${phase}`)) return
          }
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timeout waiting for ${phase}`)), 8000) }),
      ])
      await inspect()
      child.kill('SIGKILL')
      assert.notEqual(await child.exited, 0)
      await errors
    } finally { reader.releaseLock() }
  } finally {
    if (timer) clearTimeout(timer)
    if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited }
  }
}
try {
  for (const phase of ['after-claim', 'after-stock', 'after-cash', 'before-commit', 'after-commit', 'lost-commit-ack']) {
    const biz = await db.business.create({ data: { name: `Crash fixture ${phase}`, type: 'supermarket' } })
    const owner = await db.user.create({ data: { businessId: biz.id, name: 'Synthetic owner', role: 'owner' } })
    const item = await db.item.create({ data: { businessId: biz.id, name: 'Synthetic stock', unit: 'piece', stockQty: 10, sellPrice: 100 } })
    const customer = await db.customer.create({ data: { businessId: biz.id, name: 'Synthetic debtor', balance: 50 } })
    const op = await db.operation.create({ data: { businessId: biz.id, userId: owner.id, ref: `CRASH-${randomUUID()}`, idempotencyKey: randomUUID(), type: 'sale', status: 'AWAITING_APPROVAL', risk: 'R1', summary: 'Synthetic partial-credit sale', payload: JSON.stringify({ itemId: item.id, qty: 2, total: 200, paid: 100, customerId: customer.id }) } })
    async function state(committed: boolean) {
      const current = await db.operation.findUniqueOrThrow({ where: { id: op.id } })
      assert.equal(current.status, committed ? 'SUCCEEDED' : 'AWAITING_APPROVAL')
      assert.equal((await db.item.findUniqueOrThrow({ where: { id: item.id } })).stockQty, committed ? 8 : 10)
      assert.equal((await db.customer.findUniqueOrThrow({ where: { id: customer.id } })).balance, committed ? 150 : 50)
      assert.equal(await db.cashEntry.count({ where: { ref: op.ref } }), committed ? 1 : 0)
      assert.equal(await db.auditEvent.count({ where: { ref: op.ref, action: 'operation.succeeded' } }), committed ? 1 : 0)
      if (committed) assert.equal((await db.cashEntry.findFirstOrThrow({ where: { ref: op.ref } })).amount, 100)
    }
    if (phase === 'lost-commit-ack') {
      assert.equal((await worker(op.id, owner.id, phase)).status, 'SUCCEEDED')
    } else {
      await worker(op.id, owner.id, phase, () => state(phase === 'after-commit'))
    }
    const committed = phase === 'after-commit' || phase === 'lost-commit-ack'
    await state(committed)
    const retry = await worker(op.id, owner.id, 'normal')
    assert.equal(retry.status, committed ? 409 : 'SUCCEEDED')
    await state(true)
    assert.equal((await worker(op.id, owner.id, 'normal')).status, 409)
    await state(true)
    assert.equal(await db.operation.count({ where: { businessId: biz.id, status: 'EXECUTING' } }), 0)
    console.log(`PASS: financial process-loss ${phase}; one cash/stock/debt effect and one success audit after retry`)
  }
  const integrity = await db.$queryRawUnsafe<{ integrity_check: string }[]>('PRAGMA integrity_check')
  assert.equal(integrity[0].integrity_check, 'ok')
  assert.equal((await db.$queryRawUnsafe<unknown[]>('PRAGMA foreign_key_check')).length, 0)
  console.log('PASS: financial crash smoke: five actual SIGKILL points + simulated commit-ack loss; SQLite rollback/reopen and cross-process retry verified on disposable local storage')
} finally { await db.$disconnect(); rmSync(dir, { recursive: true, force: true }) }
