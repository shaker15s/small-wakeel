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
import { PrismaClient } from '@prisma/client'
import { PrismaLibSQL } from '@prisma/adapter-libsql'
import { isLocalSqliteUrl, sqliteBusyTimeoutMs } from './db-config'
import { databaseUrl } from './db-url'
export { databaseUrl, resolveDatabaseUrl } from './db-url'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
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
