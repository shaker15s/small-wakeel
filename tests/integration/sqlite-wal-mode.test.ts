import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createClient, type Client } from '@libsql/client'
import { randomUUID } from 'node:crypto'
import { testDb } from '../helpers/test-db'

let reader: Client
let writer: Client
let url = ''

beforeAll(async () => {
  await testDb() // applies the same versioned migrations used by runtime/deploy
  url = process.env.DATABASE_URL!
  reader = createClient({ url, timeout: 10_000 })
  writer = createClient({ url, timeout: 10_000 })
  await writer.execute('CREATE TABLE IF NOT EXISTS _WakilWalProbe (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
})

afterAll(() => {
  reader?.close()
  writer?.close()
})

describe('local SQLite journal safety', () => {
  test('migrations select WAL and a reader cannot strand later commits', async () => {
    const mode = await reader.execute('PRAGMA journal_mode')
    expect(String(mode.rows[0]?.journal_mode ?? '').toLowerCase()).toBe('wal')

    const id = randomUUID()
    const readTx = await reader.transaction('read')
    try {
      // Hold a read snapshot open while a second client performs a write.
      await readTx.execute('SELECT id FROM _WakilWalProbe')
      const writeTx = await writer.transaction('deferred')
      await writeTx.execute({
        sql: 'INSERT INTO _WakilWalProbe (id, value) VALUES (?, ?)',
        args: [id, 'synthetic WAL lock test'],
      })
      await writeTx.commit()

      // The read transaction still exists; in WAL mode the committed write is
      // visible to a fresh reader without waiting for the first reader to end.
      const visible = await writer.execute({
        sql: 'SELECT value FROM _WakilWalProbe WHERE id = ?',
        args: [id],
      })
      expect(String(visible.rows[0]?.value)).toBe('synthetic WAL lock test')
    } finally {
      await readTx.rollback().catch(() => {})
    }
  })
})
