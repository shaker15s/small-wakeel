// وكيل — the single database handle.
//
// R19 change: Prisma now runs **engine-free** through a driver adapter
// (`@prisma/adapter-libsql` + the WASM query compiler enabled in
// prisma/schema.prisma). Why:
//   1. Deploys stop depending on a downloadable Rust engine binary
//      (`binaries.prisma.sh`) — the #1 cause of "works on my machine" builds,
//      and the reason `prisma generate` fails on locked-down networks.
//   2. Cold starts/size shrink (no ~40MB query engine per platform).
//   3. It is where Prisma itself is heading (Prisma 7 makes driver adapters
//      the default), so the code needs no rewrite later.
//
// The connection string still comes from DATABASE_URL. A *relative* `file:`
// URL is resolved against the process CWD by libsql, so the default below keeps
// `bun dev` working from the repo root without a .env at all.
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { PrismaLibSQL } from '@prisma/adapter-libsql'
import { isLocalSqliteUrl, sqliteBusyTimeoutMs } from './db-config'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

/** Same jitter-free default as .env.example — repo-root relative. */
const DEFAULT_DATABASE_URL = 'file:./db/custom.db'

/**
 * Resolve a relative `file:` URL to an ABSOLUTE one.
 *
 * Why this matters (production bug found while booting the standalone build):
 * `next build` + `output: 'standalone'` produce a server that does
 * `process.chdir(__dirname)` at boot, so a relative `file:./db/custom.db`
 * silently points at `.next/standalone/db/custom.db` instead of the project's
 * database — the app started, answered `/api/health` with `unhealthy`, and
 * refused every query. `bun dev` never shows it because dev keeps the repo root
 * as CWD.
 *
 * Strategy: try the usual roots in order and use the first one that already
 * contains the file; if none does (fresh install), fall back to the project
 * root so the database is created in the right place. `WAKIL_DB_DIR` overrides
 * everything for exotic deployments (read-only app dir, mounted volume…).
 */
export function resolveDatabaseUrl(raw: string): string {
  if (!raw.startsWith('file:')) return raw // libsql://, https://, :memory:
  const filePart = raw.slice('file:'.length)
  if (!filePart || filePart === ':memory:' || isAbsolute(filePart)) return raw

  const candidates = [
    process.env.WAKIL_DB_DIR,
    process.cwd(), // server started from the project root
    process.env.WAKIL_PROJECT_ROOT,
    // `.next/standalone/server.js` chdir's here; `db/` is copied next to it
    resolve(process.cwd(), '..'),
    resolve(process.cwd(), '../..'),
  ].filter((c): c is string => Boolean(c))

  for (const base of candidates) {
    const absolute = join(base, filePart)
    if (existsSync(absolute)) return `file:${absolute}`
  }
  return `file:${join(process.cwd(), filePart)}`
}

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim()
  return resolveDatabaseUrl(url && url.length > 0 ? url : DEFAULT_DATABASE_URL)
}

function createPrismaClient(): PrismaClient {
  const url = databaseUrl()
  // Pass the bounded lock-wait timeout through the adapter's supported config
  // API. A PRAGMA on a separate admin/test connection does not configure the
  // adapter's own local SQLite connections.
  const adapter = new PrismaLibSQL({
    url,
    ...(isLocalSqliteUrl(url) ? { timeout: sqliteBusyTimeoutMs() } : {}),
  })
  return new PrismaClient({
    adapter,
    // `log: ['query']` used to be hardcoded — it printed every SQL statement in
    // production too (huge log volume, measurable latency). Warnings/errors
    // only; set WAKIL_DB_LOG=query when you actually want the firehose.
    log: process.env.WAKIL_DB_LOG === 'query' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  })
}

export const db = globalForPrisma.prisma ?? createPrismaClient()

// Cache the handle across HMR reloads in dev (never in production, where each
// process is short-lived anyway).
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
