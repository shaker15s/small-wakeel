#!/usr/bin/env bun
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readCommittedSyntheticSqlite } from './lib/synthetic-db-fixture.mjs'

function arg(name: string): string {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value || value.startsWith('--')) throw new Error(`Missing required ${name} argument`)
  return value
}

const output = resolve(arg('--output'))
const bytes = readCommittedSyntheticSqlite(process.cwd())
writeFileSync(output, bytes, { flag: 'wx', mode: 0o600 })
console.log(`[synthetic-fixture] copied immutable HEAD:db/custom.db to a private disposable target (${bytes.byteLength} bytes)`)
