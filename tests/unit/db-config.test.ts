import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
  isLocalSqliteUrl,
  MAX_SQLITE_BUSY_TIMEOUT_MS,
  MIN_SQLITE_BUSY_TIMEOUT_MS,
  sqliteBusyTimeoutMs,
} from '@/lib/db-config'

describe('local SQLite configuration', () => {
  test('uses a bounded nonzero busy timeout by default', () => {
    expect(DEFAULT_SQLITE_BUSY_TIMEOUT_MS).toBe(15_000)
    expect(sqliteBusyTimeoutMs(undefined)).toBe(DEFAULT_SQLITE_BUSY_TIMEOUT_MS)
    expect(sqliteBusyTimeoutMs('')).toBe(DEFAULT_SQLITE_BUSY_TIMEOUT_MS)
  })

  test('accepts explicit integer timeouts only inside the supported safety range', () => {
    expect(sqliteBusyTimeoutMs(String(MIN_SQLITE_BUSY_TIMEOUT_MS))).toBe(MIN_SQLITE_BUSY_TIMEOUT_MS)
    expect(sqliteBusyTimeoutMs(String(MAX_SQLITE_BUSY_TIMEOUT_MS))).toBe(MAX_SQLITE_BUSY_TIMEOUT_MS)
    for (const value of ['0', '999', '60001', '-1000', 'abc', '1.5']) {
      expect(() => sqliteBusyTimeoutMs(value)).toThrow(/WAKIL_SQLITE_BUSY_TIMEOUT_MS/)
    }
  })

  test('only local SQLite URLs get the busy-timeout option', () => {
    expect(isLocalSqliteUrl('file:./db/custom.db')).toBe(true)
    expect(isLocalSqliteUrl('file::memory:')).toBe(true)
    expect(isLocalSqliteUrl(':memory:')).toBe(true)
    expect(isLocalSqliteUrl('libsql://example.turso.io')).toBe(false)
    expect(isLocalSqliteUrl('https://example.test')).toBe(false)
  })
})
