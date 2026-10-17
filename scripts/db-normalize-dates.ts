// scripts/db-normalize-dates.ts — one storage class for every DateTime column.
//
// Why this exists (a real bug found by the screens audit): after R19 switched
// Prisma to the driver adapter (`@prisma/adapter-libsql`), NEW rows store
// DateTime as ISO TEXT (`2026-10-17T07:33:40.953+00:00`) while rows written by
// the older engine (the seeded demo history) are INTEGER milliseconds. SQLite
// compares INTEGER and TEXT by storage class, so `WHERE createdAt >= '2026-09-…'`
// silently matched ZERO integer rows. Effect the owner saw: the dashboard,
// stats and reports screens of the gym, pharmacy and attar showed zeros for a
// month that was fully recorded — a «شاشة بايضة» with data behind it.
//
// The canonical form is TEXT ISO (what the current client writes). This script
// converts every non-text value in every DateTime column, in every table.
//
//   bun run db:normalize-dates            # report only
//   bun run db:normalize-dates -- --apply # write
import { Prisma } from '@prisma/client'
import { db } from '../src/lib/db'

const apply = process.argv.includes('--apply')
/** CI mode: exit 1 when any DateTime column is not TEXT ISO. */
const check = process.argv.includes('--check')

type Field = { name: string; type: string; kind: string }
type Model = { name: string; fields: Field[] }

/** SQLite table name Prisma uses (model name by default; @@map is respected). */
function tableFor(model: Model): string {
  const mapped = (model as unknown as { dbName?: string }).dbName
  return mapped ?? model.name
}

/** Milliseconds from whatever SQLite stored. */
function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value
  if (typeof value === 'number' && Number.isFinite(value)) {
    // seconds vs milliseconds: anything below ~1973 in ms is really seconds
    return new Date(value < 1e11 ? value * 1000 : value)
  }
  if (typeof value === 'bigint') return new Date(Number(value))
  if (typeof value === 'string') {
    const asNumber = Number(value)
    if (value.trim() !== '' && Number.isFinite(asNumber)) {
      return new Date(asNumber < 1e11 ? asNumber * 1000 : asNumber)
    }
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

let totalFixed = 0
let totalBad = 0

for (const model of Prisma.dmmf.datamodel.models as unknown as Model[]) {
  const dateFields = model.fields.filter((f) => f.type === 'DateTime' && f.kind === 'scalar')
  if (dateFields.length === 0) continue
  const table = tableFor(model)

  for (const field of dateFields) {
    let rows: { rowid: number | bigint; v: unknown; t: string }[]
    try {
      rows = await db.$queryRawUnsafe(
        `SELECT rowid, "${field.name}" AS v, typeof("${field.name}") AS t FROM "${table}" WHERE "${field.name}" IS NOT NULL AND typeof("${field.name}") <> 'text'`,
      )
    } catch {
      continue // table not created yet in this database
    }
    if (rows.length === 0) continue
    totalFixed += rows.length
    console.log(`⚠️  ${table}.${field.name}: ${rows.length} صف مش نص (${[...new Set(rows.map((r) => r.t))].join(', ')})`)
    for (const row of rows) {
      const d = toDate(row.v)
      if (!d) {
        totalBad++
        console.log(`   ✗ rowid=${row.rowid} قيمة مش مفهومة: ${String(row.v).slice(0, 40)}`)
        continue
      }
      if (apply) {
        await db.$executeRawUnsafe(`UPDATE "${table}" SET "${field.name}" = ? WHERE rowid = ?`, d.toISOString(), row.rowid)
      }
    }
  }
}

if (totalFixed === 0) {
  console.log('✅ كل أعمدة التواريخ بنفس الشكل (نص ISO) — مفيش حاجة تتصحح.')
} else if (apply) {
  console.log(`✅ اتصلّح ${totalFixed - totalBad} صف${totalBad > 0 ? ` · ${totalBad} صف محتاج مراجعة يدوية` : ''}.`)
} else {
  console.log(`ℹ️  ${totalFixed} صف محتاج تصحيح — شغّل بـ --apply.`)
}
// A mixed-storage database is a DATA BUG, not a warning: date filters silently
// return nothing for the integer rows (that is how the stats screens died).
process.exit(check && totalFixed > 0 ? 1 : 0)
