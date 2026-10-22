import { afterAll, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { testDb } from '../helpers/test-db'

const db = await testDb()
const inheritedUrl = process.env.DATABASE_URL!
const inheritedPath = inheritedUrl.slice('file:'.length)
let businessId: string | null = null

afterAll(async () => {
  if (businessId) await db.business.delete({ where: { id: businessId } })
  await db.$disconnect()
})

test('a child that inherits a disposable DB path must not delete its parent-owned fixture', async () => {
  expect(existsSync(inheritedPath)).toBe(true)
  const script = [
    "import { ensureTestDatabaseReady, testDb } from './tests/helpers/test-db.ts'",
    'await ensureTestDatabaseReady()',
    'const childDb = await testDb()',
    "if (!process.env.DATABASE_URL?.includes('/wakil-test-')) throw new Error('child did not inherit a marked test database')",
    'await childDb.$disconnect()',
    "console.log('TEST_DB_CHILD_OK')",
  ].join(';')

  let output = ''
  const code = await new Promise<number>((resolveCode) => {
    const child = spawn(process.execPath, ['-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: inheritedUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    child.stderr.on('data', (chunk) => { output += String(chunk) })
    child.on('close', (exitCode) => resolveCode(exitCode ?? 1))
  })

  expect(code, output).toBe(0)
  expect(output).toContain('TEST_DB_CHILD_OK')
  expect(existsSync(inheritedPath)).toBe(true)

  // The parent must still be able to write through the Prisma connection
  // created before the child exited, not merely see a path with the same name.
  const business = await db.business.create({
    data: { name: `test-db-owner-${randomUUID()}`, type: 'supermarket' },
  })
  businessId = business.id
  expect(await db.business.count({ where: { id: business.id } })).toBe(1)
})
