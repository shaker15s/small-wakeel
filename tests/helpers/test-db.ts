// وكيل — shared test database.
//
// WHY a helper instead of each file building its own: `bun test` shares ONE
// module registry across test files in a run, so `src/lib/db` is instantiated
// exactly once per process — with whatever `DATABASE_URL` was set first. Two
// files each pointing at their own temp copy therefore made the second file
// talk to the first file's (already deleted) database.
//
// So: exactly one temp copy per test run, created lazily, cleaned up on exit.
// Tests never touch the real `db/custom.db`.
import { applyMigrations } from '../../scripts/lib/migrations'
import { snapshotSqlite } from '../../scripts/lib/sqlite-snapshot'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir: string | null = null
// R40-1: migrations are async (libsql driver). Preload is a sync context, so
// the migration STARTS here and every `testDb()` AWAITs it before the first
// query — no test can ever hit a half-migrated copy.
let migrationPromise: Promise<void> | null = null

export function ensureTestDatabase(): string {
  if (dir) return join(dir, 'custom.db')
  dir = mkdtempSync(join(tmpdir(), 'wakil-test-'))
  const target = join(dir, 'custom.db')
  // Seatbelt for the class of bug this helper exists for: if the preload ever
  // fails to load, fail LOUDLY instead of writing test drafts into real data.
  if (!target.startsWith(tmpdir())) {
    throw new Error('اختبارات وكيل لازم تشتغل على نسخة مؤقتة من الداتابيز — مش على الداتابيز الحقيقية')
  }
  snapshotSqlite(join(process.cwd(), 'db', 'custom.db'), target)
  migrationPromise = applyMigrations(target).then(
    () => undefined,
    (e) => {
      console.error('[test-db] migration FAILED — no test may run against a drifted copy:', e)
      throw e
    },
  )
  process.env.DATABASE_URL = `file:${target}`
  // one cleanup for the whole run
  process.on('exit', () => {
    try {
      if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort — it lives in the OS temp dir anyway
    }
  })
  return target
}

/**
 * The preload must await migrations before Bun evaluates any test module.
 * Some tests import the Prisma singleton at module scope, before beforeAll().
 * Merely starting this promise in preload leaves a race while WAL/schema are
 * being initialized, which can corrupt the copied test DB or surface SQLITE_IOERR.
 */
export async function ensureTestDatabaseReady(): Promise<string> {
  const target = ensureTestDatabase()
  if (migrationPromise) await migrationPromise
  return target
}

/** The Prisma handle bound to the shared temp copy of the seeded database. */
export async function testDb() {
  await ensureTestDatabaseReady()
  const mod = await import('../../src/lib/db')
  return mod.db as import('@prisma/client').PrismaClient
}
