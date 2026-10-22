/**
 * Local SQLite can have several legitimate readers/writers during a chat turn
 * (the app process, backup/reconciliation checks, and local operator tooling).
 * @libsql/client defaults local-file lock waiting to zero unless `timeout`
 * is configured. Keep retries bounded and configurable rather than failing a
 * valid chat write at the first transient SQLITE_BUSY.
 */
export const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 15_000
export const MIN_SQLITE_BUSY_TIMEOUT_MS = 1_000
export const MAX_SQLITE_BUSY_TIMEOUT_MS = 60_000

export function sqliteBusyTimeoutMs(
  raw: string | undefined = process.env.WAKIL_SQLITE_BUSY_TIMEOUT_MS,
): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_SQLITE_BUSY_TIMEOUT_MS
  const parsed = Number(raw)
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_SQLITE_BUSY_TIMEOUT_MS ||
    parsed > MAX_SQLITE_BUSY_TIMEOUT_MS
  ) {
    throw new Error(
      `WAKIL_SQLITE_BUSY_TIMEOUT_MS must be an integer between ${MIN_SQLITE_BUSY_TIMEOUT_MS} and ${MAX_SQLITE_BUSY_TIMEOUT_MS} milliseconds`,
    )
  }
  return parsed
}

export function isLocalSqliteUrl(url: string): boolean {
  return url.startsWith('file:') || url === ':memory:'
}
