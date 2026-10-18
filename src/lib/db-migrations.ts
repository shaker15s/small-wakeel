// وكيل — offline, versioned, ADDITIVE SQLite migrations (single source of truth).
//
// Invoked from:
//   • `bun run db:migrate` (explicit, production deployments) — via scripts/migrate.ts
//   • dev-server startup (`src/instrumentation.ts`) — idempotent, so a fresh
//     clone works with `bun install && bun dev` alone (R40-1: the committed
//     demo DB used to require a manual migrate step; a fresh clone crashed on
//     the first query with «no such column: Business.workflowMode»).
//   • test fixtures (tests/helpers/test-db.ts, evals runner, smoke scripts).
//
// Implemented on @libsql/client (the SAME driver Prisma uses here) so the
// engine runs identically under `bun dev`, `bun test`, and the node
// standalone build — no bun:sqlite dependency in the app bundle.
//
// Safety rules (contract, unchanged):
//   • additive only — renaming/dropping data requires a new migration version
//   • idempotent — the `_WakilMigration` ledger stores a sha256 per file
//   • a changed already-applied file is a CHECKSUM MISMATCH (fail loud)
//   • foreign-key check at the end; a violation aborts loudly — the app never
//     serves a half-migrated schema silently.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { createClient, type Client } from '@libsql/client'

export interface MigrationResult {
  applied: string[]
  skipped: number
}

/**
 * Split a migration file into individual executable statements.
 *
 * WHY: `client.execute('a; b;')` is NOT guaranteed to run both statements on
 * the libsql driver (observed: a 6-statement file reported success while only
 * some statements landed — the next migration then failed with «no such
 * table»). bun:sqlite's `exec()` handled this, the libsql client does not.
 * The splitter tracks single/double/backtick quotes and `--` line comments so
 * a semicolon inside a literal can never split a statement.
 */
export function splitSqlStatements(content: string): string[] {
  const out: string[] = []
  let cur = ''
  let inSingle = false
  let inDouble = false
  let inBacktick = false
  let inLineComment = false
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]
    const next = content[i + 1] ?? ''
    if (inLineComment) {
      cur += ch
      if (ch === '\n') inLineComment = false
      continue
    }
    if (inSingle) {
      cur += ch
      if (ch === "'" && next === "'") { cur += next; i++ } // escaped ''
      else if (ch === "'") inSingle = false
      continue
    }
    if (inDouble) {
      cur += ch
      if (ch === '"' && next === '"') { cur += next; i++ } // escaped ""
      else if (ch === '"') inDouble = false
      continue
    }
    if (inBacktick) {
      cur += ch
      if (ch === '`') inBacktick = false
      continue
    }
    if (ch === '-' && next === '-') { inLineComment = true; cur += ch; continue }
    if (ch === "'") { inSingle = true; cur += ch; continue }
    if (ch === '"') { inDouble = true; cur += ch; continue }
    if (ch === '`') { inBacktick = true; cur += ch; continue }
    if (ch === ';') {
      const stmt = cur.trim()
      if (stmt) out.push(stmt)
      cur = ''
      continue
    }
    cur += ch
  }
  const tail = cur.trim()
  if (tail) out.push(tail)
  return out
}

/** Find the `db/migrations` directory from the usual roots (dev = cwd). */
export function findMigrationsDir(): string | null {
  const candidates = [
    process.cwd(), // dev server / scripts run from the repo root
    process.env.WAKIL_PROJECT_ROOT,
    join(process.cwd(), '..'),
    join(process.cwd(), '../..'),
  ].filter((c): c is string => Boolean(c))
  for (const base of candidates) {
    const dir = join(base, 'db', 'migrations')
    if (existsSync(dir)) return dir
  }
  return null
}

export async function applyMigrations(dbPath: string, migrationsDir?: string): Promise<MigrationResult> {
  const dir = migrationsDir ?? findMigrationsDir()
  if (!dir) throw new Error('db/migrations directory not found (run from the repo root or set WAKIL_PROJECT_ROOT)')
  const absolute = isAbsolute(dbPath) ? dbPath : join(process.cwd(), dbPath)
  const client: Client = createClient({ url: `file:${absolute}` })
  const applied: string[] = []
  let skipped = 0
  try {
    await client.execute('PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON;')
    await client.execute('CREATE TABLE IF NOT EXISTS _WakilMigration (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, appliedAt TEXT NOT NULL)')
    for (const id of readdirSync(dir).sort()) {
      const contentPath = join(dir, id, 'migration.sql')
      if (!existsSync(contentPath)) continue
      const content = readFileSync(contentPath, 'utf8')
      const checksum = createHash('sha256').update(content).digest('hex')
      let isNew = false
      // libsql modes: 'write' (immediate write lock) | 'read' | 'deferred'
      const tx = await client.transaction('write')
      try {
        const row = await tx.execute({ sql: 'SELECT checksum FROM _WakilMigration WHERE id = ?', args: [id] })
        const existing = row.rows[0]?.checksum as string | undefined
        if (existing) {
          if (existing !== checksum) throw new Error(`Migration checksum mismatch: ${id}`)
        } else {
          for (const stmt of splitSqlStatements(content)) {
            await tx.execute({ sql: stmt })
          }
          await tx.execute({ sql: 'INSERT INTO _WakilMigration VALUES (?, ?, ?)', args: [id, checksum, new Date().toISOString()] })
          isNew = true
        }
        await tx.commit()
      } catch (e) {
        await tx.rollback().catch(() => {})
        throw e
      }
      if (isNew) applied.push(id)
      else skipped++
    }
    const fk = await client.execute('PRAGMA foreign_key_check')
    if (fk.rows.length) throw new Error('Migration foreign key check failed')
  } finally {
    client.close()
  }
  return { applied, skipped }
}
