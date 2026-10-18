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
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir: string | null = null

export function ensureTestDatabase(): string {
  if (dir) return join(dir, 'custom.db')
  dir = mkdtempSync(join(tmpdir(), 'wakil-test-'))
  const target = join(dir, 'custom.db')
  // Seatbelt for the class of bug this helper exists for: if the preload ever
  // fails to load, fail LOUDLY instead of writing test drafts into real data.
  if (!target.startsWith(tmpdir())) {
    throw new Error('اختبارات وكيل لازم تشتغل على نسخة مؤقتة من الداتابيز — مش على الداتابيز الحقيقية')
  }
  copyFileSync(join(process.cwd(), 'db', 'custom.db'), target)
  applyMigrations(target)
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

/** The Prisma handle bound to the shared temp copy of the seeded database. */
export async function testDb() {
  ensureTestDatabase()
  const mod = await import('../../src/lib/db')
  return mod.db as import('@prisma/client').PrismaClient
}
