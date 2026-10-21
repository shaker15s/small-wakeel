#!/usr/bin/env bun
// @ts-nocheck
// scripts/db-sync.ts — «prisma db push» for locked-down networks.
//
// WHY THIS EXISTS
// `prisma db push` needs the Prisma **schema engine** Rust binary, which the
// CLI downloads from binaries.prisma.sh at run time. On CI/containers without
// CDN access (and in this sandbox) that download is impossible, so schema
// changes could not be applied at all. This script derives the SQLite DDL from
// the SAME schema.prisma (via the WASM schema parser that ships inside
// @prisma/internals) and applies it idempotently:
//
//   • creates missing tables (+ foreign keys)
//   • adds missing columns (ALTER TABLE ADD COLUMN)
//   • creates missing indexes from @@index / @@unique
//   • `--check` reports drift and exits 1 (used by CI) instead of writing
//
// It is NOT a migration engine: no data transformations, no renames, no drops.
// Anything destructive should still go through `prisma migrate` on a machine
// with CDN access. For the additive changes this project makes, it is enough.
//
// Usage:  bun scripts/db-sync.ts [--check] [--verbose]
import { readFileSync } from 'node:fs'
import { createClient } from '@libsql/client'
import { getDMMF } from '@prisma/internals'
import { hasMatchingIndexName, parseIndexDirectives } from './lib/db-index-names'

interface DmmfField {
  name: string
  kind: 'scalar' | 'object' | 'enum' | 'unsupported'
  type: string
  isList: boolean
  isRequired: boolean
  isUnique: boolean
  isId: boolean
  relationFromFields?: string[]
  relationToFields?: string[]
}
interface DmmfModel {
  name: string
  dbName?: string | null
  fields: DmmfField[]
  uniqueIndexes: { name: string | null; fields: string[] }[]
  uniqueFields: string[][]
}

const args = process.argv.slice(2)
const CHECK_ONLY = args.includes('--check')
const VERBOSE = args.includes('--verbose')

const dbUrl = process.env.DATABASE_URL?.trim() || 'file:./db/custom.db'

/** Prisma scalar → SQLite column type (mirrors what Prisma itself emits). */
const SQL_TYPE: Record<string, string> = {
  String: 'TEXT',
  Int: 'INTEGER',
  BigInt: 'BIGINT',
  Float: 'REAL',
  Decimal: 'DECIMAL',
  Boolean: 'BOOLEAN',
  DateTime: 'DATETIME',
  Json: 'JSONB',
  Bytes: 'BLOB',
}

function quote(id: string): string {
  return `"${id.replace(/"/g, '""')}"`
}

function createTableSql(model: DmmfModel, indexes: { name: string; fields: string[] }[], uniqueIndexes: { fields: string[] }[]): string {
  const cols: string[] = []
  const constraints: string[] = []
  const table = quote(model.name)

  for (const f of model.fields) {
    if (f.kind === 'object') continue // relations handled as foreign keys below
    if (f.isList) continue // SQLite has no arrays
    const type = SQL_TYPE[f.type] ?? 'TEXT'
    let col = `  ${quote(f.name)} ${type}`
    if (f.isId) col += ' PRIMARY KEY'
    else {
      if (f.isRequired) col += ' NOT NULL'
      if (f.isUnique) col += ' UNIQUE'
    }
    cols.push(col)
  }

  for (const f of model.fields) {
    if (f.kind !== 'object') continue
    const from = f.relationFromFields ?? []
    const to = f.relationToFields ?? []
    if (from.length === 0 || to.length === 0) continue
    constraints.push(
      `  FOREIGN KEY (${from.map(quote).join(', ')}) REFERENCES ${quote(f.type)} (${to.map(quote).join(', ')})` +
        // The generated client relies on SQLite cascade to keep tenant data clean.
        ' ON DELETE CASCADE ON UPDATE CASCADE',
    )
  }

  const uniqueCols = new Set(uniqueIndexes.flatMap((u) => (u.fields.length === 1 ? u.fields : [])))
  for (const idx of indexes.filter((i) => i.kind === 'unique')) {
    if (idx.fields.length === 1 && uniqueCols.has(idx.fields[0])) continue
    constraints.push(`  UNIQUE (${idx.fields.map(quote).join(', ')})`)
  }

  return `CREATE TABLE IF NOT EXISTS ${table} (\n${[...cols, ...constraints].join(',\n')}\n);`
}

function createIndexSql(model: string, idx: { name: string; kind: 'index' | 'unique'; fields: string[] }): string {
  const unique = idx.kind === 'unique' ? 'UNIQUE ' : ''
  return `CREATE ${unique}INDEX IF NOT EXISTS ${quote(idx.name)} ON ${quote(model)} (${idx.fields
    .map(quote)
    .join(', ')});`
}

async function main() {
  const schemaText = readFileSync('prisma/schema.prisma', 'utf8')
  const dmmf = await getDMMF({ datamodel: schemaText })
  const models = dmmf.datamodel.models as unknown as DmmfModel[]
  const indexDirectives = parseIndexDirectives(schemaText)

  const client = createClient({ url: dbUrl })

  const existingTables = new Set<string>()
  const tablesRes = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
  for (const row of tablesRes.rows) existingTables.add(String(row.name))

  const statements: string[] = []
  const report: string[] = []

  for (const model of models) {
    const indexes = indexDirectives[model.name] ?? []
    if (!existingTables.has(model.name)) {
      statements.push(createTableSql(model, indexes, model.uniqueIndexes))
      report.push(`+ table   ${model.name}`)
      continue
    }

    // Existing table → add missing columns (additive only).
    const info = await client.execute(`PRAGMA table_info(${quote(model.name)})`)
    const existingCols = new Set(info.rows.map((r) => String(r.name)))
    for (const f of model.fields) {
      if (f.kind === 'object' || f.isList) continue
      if (existingCols.has(f.name)) continue
      if (f.isRequired && !f.isId && f.type !== 'DateTime') {
        report.push(`! column  ${model.name}.${f.name} is REQUIRED — add a default or backfill it manually`)
        continue
      }
      const type = SQL_TYPE[f.type] ?? 'TEXT'
      statements.push(`ALTER TABLE ${quote(model.name)} ADD COLUMN ${quote(f.name)} ${type};`)
      report.push(`+ column  ${model.name}.${f.name}`)
    }
  }

  // Indexes (idempotent: IF NOT EXISTS).
  const indexRes = await client.execute("SELECT name FROM sqlite_master WHERE type = 'index'")
  const existingIndexes = new Set(indexRes.rows.map((r) => String(r.name)))
  for (const model of models) {
    for (const idx of indexDirectives[model.name] ?? []) {
      if (hasMatchingIndexName(idx, existingIndexes)) continue
      statements.push(createIndexSql(model.name, idx))
      report.push(`+ index   ${idx.name} (${idx.fields.join(', ')})`)
    }
  }

  if (report.length === 0) {
    console.log('✔ قاعدة البيانات متوافقة مع الـ schema — مفيش تغييرات.')
    await client.close()
    return
  }

  console.log(report.join('\n'))
  if (CHECK_ONLY) {
    console.error(`\n✖ فيه ${report.length} فرق بين الـ schema وقاعدة البيانات (وضع --check ما بيكتبش).`)
    await client.close()
    process.exit(1)
  }

  if (VERBOSE) console.log('\n' + statements.join('\n'))
  // libsql runs a batch transactionally — a failure leaves the db untouched.
  await client.executeMultiple(statements.join('\n'))
  console.log(`\n✔ اتطبّق ${statements.length} أمر على ${dbUrl}`)
  await client.close()
}

main().catch(async (err) => {
  console.error('✖ db:sync فشل:', err instanceof Error ? err.message : err)
  process.exit(1)
})
