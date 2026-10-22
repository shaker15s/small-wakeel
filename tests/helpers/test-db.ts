// WAKIL test database isolation.
//
// Each CI test process receives a private copy of the committed seed DB.
// Keep the preload marker: Bun may evaluate the preload and test helper in
// separate module registries, and creating two temp DBs would bind the Prisma
// singleton to one file while DATABASE_URL points at another.
//
// The seed DB is committed and is not live-writable in CI. We intentionally
// use a byte copy plus the same LibSQL migration path used by the app. Do not
// round-trip this test fixture through a second SQLite engine after migration:
// a previous VACUUM-into / integrity-check flow passed its initial check but
// produced later SQLITE_IOERR/SQLITE_CORRUPT errors through Prisma's adapter.
import { applyMigrations } from '../../scripts/lib/migrations'
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

let dir: string | null = null
// Only the process that creates a temp DB owns and may delete that directory.
// Child test runners can inherit DATABASE_URL and reuse the parent's marker.
let ownsDir = false
let migrationPromise: Promise<void> | null = null
let cleanupRegistered = false

const TEST_DB_MARKER = '.wakil-disposable-test-db'
const TEST_DB_INITIALIZING = 'WAKIL-DISPOSABLE-SQLITE-INITIALIZING-V1'
const TEST_DB_READY = 'WAKIL-DISPOSABLE-SQLITE-READY-V1'

function registerCleanup(): void {
  if (cleanupRegistered) return
  cleanupRegistered = true
  process.on('exit', () => {
    try {
      if (ownsDir && dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup of an OS temp directory
    }
  })
}

function markedDatabaseFromEnvironment(): {
  directory: string
  target: string
  markerPath: string
  markerState: string
} | null {
  const raw = process.env.DATABASE_URL?.trim()
  if (!raw?.startsWith('file:')) return null

  const target = resolve(raw.slice('file:'.length))
  const directory = dirname(target)
  const markerPath = join(directory, TEST_DB_MARKER)
  const tempRoot = resolve(tmpdir())
  const tempPrefix = tempRoot.endsWith(sep) ? tempRoot : `${tempRoot}${sep}`

  if (
    !target.startsWith(tempPrefix) ||
    basename(target) !== 'custom.db' ||
    !basename(directory).startsWith('wakil-test-') ||
    !existsSync(target) ||
    !existsSync(markerPath)
  ) return null

  let markerState = ''
  try { markerState = readFileSync(markerPath, 'utf8').trim() } catch { /* fail closed below */ }
  return { directory, target, markerPath, markerState }
}

async function waitForExistingFixtureReady(target: string, markerPath: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    let state = ''
    try { state = readFileSync(markerPath, 'utf8').trim() } catch { /* initializer may still be publishing */ }
    if (state === TEST_DB_READY && existsSync(target)) return
    if (state !== TEST_DB_INITIALIZING && state !== TEST_DB_READY) {
      throw new Error('Disposable test DB marker has unexpected state: ' + (state || '(empty)') + ' at ' + markerPath)
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  throw new Error('Timed out waiting for disposable test DB migrations: ' + target)
}

function startMigration(target: string): void {
  migrationPromise = applyMigrations(target).then(() => {
    // Publish READY only after the same app migration path has completed.
    writeFileSync(join(dirname(target), TEST_DB_MARKER), TEST_DB_READY + '\n', { flag: 'w' })
    console.log('[test-db] ready disposable SQLite DB: ' + target + ' (' + statSync(target).size + ' bytes)')
  }).catch((error) => {
    console.error('[test-db] migrations failed; no test may use this copy:', error)
    throw error
  })
}

export function ensureTestDatabase(): string {
  if (dir) return join(dir, 'custom.db')

  const inherited = markedDatabaseFromEnvironment()
  if (inherited) {
    // Inherited fixture: it belongs to the parent process. Never register
    // cleanup for a directory this process did not create.
    dir = inherited.directory
    migrationPromise = inherited.markerState === TEST_DB_READY
      ? Promise.resolve()
      : waitForExistingFixtureReady(inherited.target, inherited.markerPath)
    return inherited.target
  }

  dir = mkdtempSync(join(tmpdir(), 'wakil-test-'))
  ownsDir = true
  const target = join(dir, 'custom.db')
  const tempRoot = resolve(tmpdir())
  const tempPrefix = tempRoot.endsWith(sep) ? tempRoot : `${tempRoot}${sep}`

  if (!target.startsWith(tempPrefix)) {
    throw new Error('اختبارات وكيل لازم تشتغل على نسخة مؤقتة من الداتابيز — مش على الداتابيز الحقيقية')
  }

  const source = resolve(process.cwd(), 'db', 'custom.db')
  // A live source with WAL sidecars cannot be copied by copying only its main
  // file. Fail closed rather than take a potentially inconsistent local copy.
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = source + suffix
    if (existsSync(sidecar) && statSync(sidecar).size > 0) {
      throw new Error('Seed SQLite DB has active ' + suffix + ' sidecar. Stop the local app/checkpoint the seed DB before tests: ' + sidecar)
    }
  }

  writeFileSync(join(dir, TEST_DB_MARKER), TEST_DB_INITIALIZING + '\n', { flag: 'wx' })
  registerCleanup()
  copyFileSync(source, target)
  process.env.DATABASE_URL = 'file:' + target
  startMigration(target)
  console.log('[test-db] disposable SQLite copy: ' + target)
  return target
}

export async function ensureTestDatabaseReady(): Promise<string> {
  const target = ensureTestDatabase()
  if (migrationPromise) await migrationPromise
  return target
}

/** The Prisma handle bound to this process's disposable copy. */
export async function testDb() {
  await ensureTestDatabaseReady()
  const mod = await import('../../src/lib/db')
  return mod.db as import('@prisma/client').PrismaClient
}
