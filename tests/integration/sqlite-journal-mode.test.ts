import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createClient, type Client } from '@libsql/client'
import type { PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { testDb } from '../helpers/test-db'

let prisma: PrismaClient
let client: Client | null = null
let url = ''

beforeAll(async () => {
  prisma = await testDb()
  url = process.env.DATABASE_URL!
  client = createClient({ url, timeout: 10_000, concurrency: 1 })
  await client.execute('CREATE TABLE IF NOT EXISTS _WakilJournalProbe (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
})

afterAll(async () => {
  client?.close()
  await prisma?.$disconnect?.()
})

describe('local SQLite journal safety', () => {
  test('migration policy disables WAL until the bundled libSQL core is patched', async () => {
    const mode = await client!.execute('PRAGMA journal_mode')
    expect(String(mode.rows[0]?.journal_mode ?? '').toLowerCase()).toBe('delete')

    const engine = await client!.execute('SELECT sqlite_version() AS version')
    const version = String(engine.rows[0]?.version ?? '')
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
    console.info(`[sqlite-journal-test] mode=delete; bundled SQLite=${version}`)
  })

  test('serial local writes survive close/reopen with intact schema and values', async () => {
    const ids: string[] = []
    for (let i = 0; i < 40; i++) {
      const id = randomUUID()
      ids.push(id)
      await client!.execute({
        sql: 'INSERT INTO _WakilJournalProbe (id, value) VALUES (?, ?)',
        args: [id, `synthetic-${i}`],
      })
    }
    const integrity = await client!.execute('PRAGMA integrity_check')
    expect(String(integrity.rows[0]?.integrity_check ?? '')).toBe('ok')
    const count = await client!.execute({
      sql: 'SELECT COUNT(*) AS count FROM _WakilJournalProbe WHERE id IN (' + ids.map(() => '?').join(',') + ')',
      args: ids,
    })
    expect(Number(count.rows[0]?.count ?? 0)).toBe(40)

    client!.close()
    client = createClient({ url, timeout: 10_000, concurrency: 1 })
    const reopened = await client.execute({
      sql: 'SELECT COUNT(*) AS count FROM _WakilJournalProbe WHERE id IN (' + ids.map(() => '?').join(',') + ')',
      args: ids,
    })
    expect(Number(reopened.rows[0]?.count ?? 0)).toBe(40)
    const after = await client.execute('PRAGMA integrity_check')
    expect(String(after.rows[0]?.integrity_check ?? '')).toBe('ok')
  })
})
