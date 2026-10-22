// Consistent, WAL-aware snapshot of a local SQLite database.
// Never copy only the main .db file: committed pages may still be in -wal.
// VACUUM INTO takes a transactionally consistent snapshot of the live source.
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export function snapshotSqlite(sourcePath: string, targetPath: string): void {
  const source = resolve(sourcePath)
  const target = resolve(targetPath)
  if (source === target) throw new Error('SQLite snapshot source and destination must differ')
  if (!existsSync(source)) throw new Error(`SQLite snapshot source does not exist: ${source}`)
  if (existsSync(target)) throw new Error(`SQLite snapshot destination must not exist: ${target}`)
  mkdirSync(dirname(target), { recursive: true })

  let sourceDb: Database | undefined
  try {
    sourceDb = new Database(source, { readonly: true })
    const sourceCheck = sourceDb.query('PRAGMA integrity_check').get() as { integrity_check?: string } | null
    if (sourceCheck?.integrity_check !== 'ok') {
      throw new Error(`SQLite source integrity_check failed: ${sourceCheck?.integrity_check ?? 'no result'}`)
    }
    sourceDb.query('VACUUM INTO ?').run(target)
  } catch (error) {
    try { if (existsSync(target)) rmSync(target, { force: true }) } catch { /* best effort */ }
    throw error
  } finally {
    sourceDb?.close()
  }

  // Do not hand an unchecked copy to a test, migration or crash worker.
  let copyDb: Database | undefined
  try {
    copyDb = new Database(target, { readonly: true })
    const copiedCheck = copyDb.query('PRAGMA integrity_check').get() as { integrity_check?: string } | null
    if (copiedCheck?.integrity_check !== 'ok') {
      throw new Error(`SQLite snapshot integrity_check failed: ${copiedCheck?.integrity_check ?? 'no result'}`)
    }
  } catch (error) {
    try { if (existsSync(target)) rmSync(target, { force: true }) } catch { /* best effort */ }
    throw error
  } finally {
    copyDb?.close()
  }
}
