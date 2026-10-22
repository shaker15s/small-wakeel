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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

let dir: string | null = null
let migrationPromise: Promise<void> | null = null
let cleanupRegistered = false
const TEST_DB_MARKER = '.wakil-disposable-test-db'

function registerCleanup(): void {
  if (cleanupRegistered) return
  cleanupRegistered = true
  process.on('exit', () => {
    try {
      if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort — it lives in the OS temp dir anyway
    }
  })
}

/**
 * Bun's preload and a test module can be evaluated in different module
 * registries. If each registry creates its own temp copy, process.env points
 * at one file while a previously imported Prisma singleton remains bound to
 * the other; one copy can then be removed while it is still in use. Reuse only
 * a path carrying our marker, inside tmpdir, and with the expected filename.
 */
function markedDatabaseFromEnvironment(): { directory: string; target: string } | null {
  const raw = process.env.DATABASE_URL?.trim()
  if (!raw?.startsWith('file:')) return null

  const target = resolve(raw.slice('file:'.length))
  const directory = dirname(target)
  const tempRoot = resolve(tmpdir())
  const tempPrefix = tempRoot.endsWith(sep) ? tempRoot : `${tempRoot}${sep}`
  if (
    !target.startsWith(tempPrefix) ||
    basename(target) !== 'custom.db' ||
    !basename(directory).startsWith('wakil-test-') ||
    !existsSync(join(directory, TEST_DB_MARKER))
  ) return null

  return { directory, target }
}

function startMigration(target: string): void {
  migrationPromise = applyMigrations(target).then(
    () => undefined,
    (error) => {
      console.error('[test-db] migration FAILED — no test may run against a drifted copy:', error)
      throw error
    },
  )
}

export function ensureTestDatabase(): string {
  if (dir) return join(dir, 'custom.db')

  const inherited = markedDatabaseFromEnvironment()
  if (inherited) {
    dir = inherited.directory
    // Another preload context may have created this marked snapshot. Re-running
    // the versioned migrator is idempotent and guarantees schema readiness for
    // this module registry without binding Prisma to a different filename.
    startMigration(inherited.target)
    registerCleanup()
    return inherited.target
  }

  dir = mkdtempSync(join(tmpdir(), 'wakil-test-'))
  const target = join(dir, 'custom.db')
  const tempRoot = resolve(tmpdir())
  const tempPrefix = tempRoot.endsWith(sep) ? tempRoot : `${tempRoot}${sep}`
  // Seatbelt: tests must never point the fixture at the real/demo database.
  if (!target.startsWith(tempPrefix)) {
    throw new Error('اختبارات وكيل لازم تشتغل على نسخة مؤقتة من الداتابيز — مش على الداتابيز الحقيقية')
  }
  writeFileSync(join(dir, TEST_DB_MARKER), 'WAKIL-DISPOSABLE-SQLITE-V1\n', { flag: 'wx' })
  registerCleanup()
  snapshotSqlite(join(process.cwd(), 'db', 'custom.db'), target)
  startMigration(target)
  process.env.DATABASE_URL = `file:${target}`
  console.log(`[test-db] disposable SQLite snapshot: ${target}`)
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
