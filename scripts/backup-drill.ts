// Synthetic restore rehearsal ONLY; does not establish production RPO/RTO.
import { applyMigrations } from './lib/migrations'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { snapshotSqlite } from './lib/sqlite-snapshot'

const start = Date.now()
const dir = mkdtempSync(join(tmpdir(), 'wakil-backup-drill-'))
const sourcePath = join(dir, 'source.db')
const backupPath = join(dir, 'snapshot.db')
const restoredPath = join(dir, 'restored.db')
snapshotSqlite(join(process.cwd(), 'db/custom.db'), sourcePath)
await applyMigrations(sourcePath)
const source = createClient({ url: `file:${sourcePath}` })
let restored: Client | undefined
async function manifest(sql: Client) {
  const tables = (await sql.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).rows
  const counts: Record<string, unknown> = {}
  for (const table of tables) {
    const name = String(table.name).replace(/"/g, '""')
    counts[name] = (await sql.execute(`SELECT COUNT(*) AS n FROM "${name}"`)).rows[0].n
  }
  return {
    counts,
    schema: (await sql.execute("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name")).rows,
    cash: (await sql.execute('SELECT businessId, SUM(amount) AS total FROM CashEntry GROUP BY businessId ORDER BY businessId')).rows,
    stock: (await sql.execute('SELECT businessId, SUM(stockQty) AS total FROM Item GROUP BY businessId ORDER BY businessId')).rows,
  }
}
try {
  const before = await manifest(source)
  await source.execute({ sql: 'VACUUM INTO ?', args: [backupPath] })
  source.close()
  copyFileSync(backupPath, restoredPath)
  restored = createClient({ url: `file:${restoredPath}` })
  assert.equal((await restored.execute('PRAGMA integrity_check')).rows[0].integrity_check, 'ok')
  assert.equal((await restored.execute('PRAGMA foreign_key_check')).rows.length, 0)
  assert.deepEqual(await manifest(restored), before)
  console.log(`PASS: synthetic SQLite snapshot/restore; integrity, foreign keys, schema, all table counts, cash and stock aggregates (${Date.now() - start}ms). Not a production restore certification.`)
} finally {
  source.close()
  restored?.close()
  rmSync(dir, { recursive: true, force: true })
}
