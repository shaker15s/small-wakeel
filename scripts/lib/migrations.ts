// Offline, versioned additive SQLite migrations. Never invoked on API startup.
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function applyMigrations(path: string) {
  const sql = new Database(path)
  try {
    sql.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000;')
    sql.exec('CREATE TABLE IF NOT EXISTS _WakilMigration (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, appliedAt TEXT NOT NULL)')
    for (const id of readdirSync(join(process.cwd(), 'db/migrations')).sort()) {
      const content = readFileSync(join(process.cwd(), 'db/migrations', id, 'migration.sql'), 'utf8')
      const checksum = createHash('sha256').update(content).digest('hex')
      sql.transaction(() => {
        const existing = sql.query('SELECT checksum FROM _WakilMigration WHERE id = ?').get(id) as { checksum: string } | null
        if (existing) {
          if (existing.checksum !== checksum) throw new Error(`Migration checksum mismatch: ${id}`)
          return
        }
        sql.exec(content)
        sql.query('INSERT INTO _WakilMigration VALUES (?, ?, ?)').run(id, checksum, new Date().toISOString())
      }).immediate()
    }
    if (sql.query('PRAGMA foreign_key_check').all().length) throw new Error('Migration foreign key check failed')
  } finally { sql.close() }
}
