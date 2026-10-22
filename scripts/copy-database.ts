#!/usr/bin/env bun
import { snapshotSqlite } from './lib/sqlite-snapshot'

function arg(name: string): string {
  const i = process.argv.indexOf(name)
  const value = i >= 0 ? process.argv[i + 1] : undefined
  if (!value || value.startsWith('--')) throw new Error(`Missing required ${name} argument`)
  return value
}

snapshotSqlite(arg('--source'), arg('--output'))
console.log('[sqlite-snapshot] verified, consistent SQLite snapshot created')
