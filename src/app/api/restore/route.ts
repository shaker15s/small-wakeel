// POST /api/restore — restore a catalog backup produced by GET /api/export.
//
// SAFETY RAILS (why this is not a blind «load JSON into the DB»):
//   • only the CATALOG is restored — items, customers, suppliers. The ledger
//     (operations, cash entries, audit events) is append-only by design and is
//     never rewritten from a file: a tampered backup must not be able to
//     restate history that the owner already saw.
//   • everything happens in ONE transaction, so a bad file leaves no half state
//   • mode='preview' (default) reports what WOULD change and writes nothing
//   • mode='merge' upserts by id, falling back to normalised name
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { z } from 'zod'
import { normalizeAr } from '@/lib/agent/arabic'
import { guard } from '../_lib/guard'
import { badRequest, serverError } from '../_lib/http'
import { parseBody } from '@/lib/security/validate'

export const dynamic = 'force-dynamic'

const money = z.coerce.number().int().min(-100_000_000).max(100_000_000)
const text = (max: number) => z.string().trim().max(max)

// Mirrors what GET /api/export writes (plus the additive `barcode` column), so
// a file that round-trips through export → restore never loses a field.
const itemSchema = z.object({
  id: text(64).optional(),
  name: text(120).min(1),
  category: text(60).optional().default('منوع'),
  unit: text(20).optional().default('piece'),
  costPrice: money.optional().default(0),
  sellPrice: money.optional().default(0),
  stockQty: z.coerce.number().min(-1_000_000).max(1_000_000).optional().default(0),
  lowStockThreshold: z.coerce.number().min(0).max(1_000_000).optional().default(0),
  barcode: text(60).nullish(),
  batchNo: text(60).nullish(),
  aliases: text(200).nullish(),
  expiresAt: z.coerce.date().nullish(),
  createdAt: z.coerce.date().optional(),
  valueAtCost: z.coerce.number().optional(),
  daysToExpiry: z.coerce.number().nullish(),
})

const customerSchema = z.object({
  id: text(64).optional(),
  name: text(120).min(1),
  phone: text(30).nullish(),
  balance: money.optional().default(0),
  plan: text(60).nullish(),
  expiresAt: z.coerce.date().nullish(),
  daysLeft: z.coerce.number().nullish(),
  createdAt: z.coerce.date().optional(),
})

const supplierSchema = z.object({
  id: text(64).optional(),
  name: text(120).min(1),
  phone: text(30).nullish(),
  balance: money.optional().default(0),
  createdAt: z.coerce.date().optional(),
})

const restoreSchema = z.object({
  businessId: z.string().trim().min(1).max(64),
  userId: z.string().trim().min(1).max(64),
  mode: z.enum(['preview', 'merge']).default('preview'),
  items: z.array(itemSchema).max(5000).optional().default([]),
  customers: z.array(customerSchema).max(5000).optional().default([]),
  suppliers: z.array(supplierSchema).max(2000).optional().default([]),
})

const key = (s: string) => normalizeAr(s).replace(/^ال/, '').replace(/\s+/g, ' ').trim()

export async function POST(req: Request) {
  try {
    const parsed = await parseBody(req, restoreSchema)
    if (!parsed.ok) return badRequest(parsed.message)
    const body = parsed.data

    const gate = await guard(req, { businessId: body.businessId, userId: body.userId })
    if (!gate.ok) return gate.res

    const [existingItems, existingCustomers, existingSuppliers] = await Promise.all([
      db.item.findMany({ where: { businessId: body.businessId }, select: { id: true, name: true } }),
      db.customer.findMany({ where: { businessId: body.businessId }, select: { id: true, name: true } }),
      db.supplier.findMany({ where: { businessId: body.businessId }, select: { id: true, name: true } }),
    ])

    type Planned<Row> = { create: number; update: number; creates: Row[]; updates: { id: string; row: Row }[] }
    const plan = <Row extends { id?: string; name: string }>(
      rows: Row[],
      existing: { id: string; name: string }[],
    ): Planned<Row> => {
      const byId = new Map(existing.map((e) => [e.id, e]))
      const byName = new Map(existing.map((e) => [key(e.name), e]))
      const out: Planned<Row> = { create: 0, update: 0, creates: [], updates: [] }
      for (const row of rows) {
        const hit = (row.id ? byId.get(row.id) : undefined) ?? byName.get(key(row.name))
        if (hit) {
          out.update += 1
          out.updates.push({ id: hit.id, row })
        } else {
          out.create += 1
          out.creates.push(row)
        }
      }
      return out
    }

    const items = plan(body.items, existingItems)
    const customers = plan(body.customers, existingCustomers)
    const suppliers = plan(body.suppliers, existingSuppliers)

    const summary = {
      mode: body.mode,
      items: { create: items.create, update: items.update },
      customers: { create: customers.create, update: customers.update },
      suppliers: { create: suppliers.create, update: suppliers.update },
      note: 'السجل (عمليات، خزنة، تدقيق) ما بيتغيرش من النسخة الاحتياطية — بيتقرا بس.',
    }

    if (body.mode === 'preview') return NextResponse.json({ preview: true, ...summary })

    // `id` from the file is only honoured when it exists in THIS business —
    // a backup from another shop can never overwrite a foreign row.
    // Computed/derived fields (valueAtCost, daysToExpiry, daysLeft) are dropped:
    // they are outputs of the export, never inputs to the database. Nullable
    // string columns that the schema declares NOT NULL default to ''.
    const prune = (row: Record<string, unknown>, nullableStrings: string[]) => {
      const copy = { ...row }
      delete copy.id
      delete copy.valueAtCost
      delete copy.daysToExpiry
      delete copy.daysLeft
      for (const k of nullableStrings) if (copy[k] === null || copy[k] === undefined) copy[k] = ''
      for (const k of Object.keys(copy)) if (copy[k] === undefined) delete copy[k]
      return copy
    }

    await db.$transaction([
      ...items.creates.map((row) =>
        db.item.create({ data: { businessId: body.businessId, aliases: '', ...prune(row, ['aliases']) } as never }),
      ),
      ...items.updates.map((u) => db.item.update({ where: { id: u.id }, data: prune(u.row, ['aliases']) as never })),
      ...customers.creates.map((row) => db.customer.create({ data: { businessId: body.businessId, ...prune(row, []) } as never })),
      ...customers.updates.map((u) => db.customer.update({ where: { id: u.id }, data: prune(u.row, []) as never })),
      ...suppliers.creates.map((row) => db.supplier.create({ data: { businessId: body.businessId, ...prune(row, []) } as never })),
      ...suppliers.updates.map((u) => db.supplier.update({ where: { id: u.id }, data: prune(u.row, []) as never })),
      db.auditEvent.create({
        data: {
          businessId: body.businessId,
          actor: body.userId,
          action: 'catalog.restore',
          ref: null,
          detail: JSON.stringify(summary),
        },
      }),
    ])

    return NextResponse.json({ restored: true, ...summary })
  } catch (e) {
    return serverError('restore', e)
  }
}
