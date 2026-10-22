// Pure local database URL resolution — deliberately no Prisma import.
// Server instrumentation must resolve the file path and finish migrations
// before importing the Prisma singleton in src/lib/db.ts.
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

const DEFAULT_DATABASE_URL = 'file:./db/custom.db'

/** Resolve relative SQLite paths consistently in dev, scripts, and standalone. */
export function resolveDatabaseUrl(raw: string): string {
  if (!raw.startsWith('file:')) return raw // libsql://, https://, :memory:
  const filePart = raw.slice('file:'.length)
  if (!filePart || filePart === ':memory:' || isAbsolute(filePart)) return raw

  const candidates = [
    process.env.WAKIL_DB_DIR,
    process.cwd(),
    process.env.WAKIL_PROJECT_ROOT,
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
