// POST /api/items/import — bulk catalog onboarding from a CSV/TSV export.
//
// WHY: a shop with 300 items will never type them one by one, and the owner
// already has the data in Excel or in his old POS. This endpoint accepts the
// raw file content (the UI reads the file and posts the text), understands
// Arabic headers, Arabic-Indic digits, «،» decimals and currency noise, and
// reports per-row problems instead of failing the whole import.
//
//   { businessId, userId, csv, updateExisting?, dryRun? }
//   → { created, updated, skipped, total, unknownHeaders, errors[] }
//
// Guarantees:
//   • matching is by normalised name (أحمد ≡ احمد, «ال» article ignored)
//   • existing items are NEVER overwritten unless updateExisting=true
//   • dryRun validates + reports without writing
//   • one audit event for the whole import (who imported what, when)
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { normalizeAr, toWesternDigits } from '@/lib/agent/arabic'
import { invalidateCatalog } from '@/lib/agent/catalog'
import { mapCsv, parseFlexibleDate, parseFlexibleNumber } from '@/lib/csv'
import { guard } from '../../_lib/guard'
import { badRequest, notFound, serverError } from '../../_lib/http'
import { itemImportSchema, parseBody } from '@/lib/security/validate'

export const dynamic = 'force-dynamic'

/** Header synonyms the importer understands (first match wins). */
const SYNONYMS: Record<string, string[]> = {
  name: ['اسم الصنف', 'اسم المنتج', 'الاسم', 'اسم', 'الصنف', 'صنف', 'المنتج', 'name', 'item', 'product'],
  category: ['التصنيف', 'تصنيف', 'القسم', 'الفئة', 'قسم', 'category'],
  unit: ['الوحدة', 'وحدة', 'الوحده', 'unit'],
  costPrice: ['سعر الشراء', 'التكلفة', 'تكلفة', 'سعر التكلفة', 'cost', 'costprice'],
  sellPrice: ['سعر البيع', 'سعر بيع', 'السعر', 'سعر', 'sellprice', 'price'],
  stockQty: ['الكمية', 'كمية', 'الرصيد', 'رصيد', 'المخزون', 'stock', 'qty', 'quantity'],
  minQty: ['حد الطلب', 'الحد الأدنى', 'اقل كمية', 'minqty', 'min'],
  barcode: ['الباركود', 'باركود', 'الكود', 'كود', 'barcode', 'sku'],
  aliases: ['اسماء بديلة', 'أسماء بديلة', 'مرادفات', 'مرادف', 'aliases', 'alias'],
  expiresAt: ['تاريخ الصلاحية', 'الصلاحية', 'صلاحية', 'ينتهي', 'expires', 'expiry', 'expirydate'],
}

const MAX_ROWS = 2000

/**
 * Matching key for an item name.
 *
 * Digit folding matters as much as letter folding: a spreadsheet with «شاي
 * العروسة ٢٥٠ جرام» and an existing row «شاي العروسة 250 جرام» are the SAME
 * product — without folding we imported a duplicate catalog entry (found while
 * smoke-testing the importer against the demo data).
 */
function nameKey(name: string): string {
  return normalizeAr(toWesternDigits(name)).replace(/^ال/, '').replace(/\s+/g, ' ').trim()
}

/** Store names with ASCII digits so the catalog stays consistent. */
function cleanName(name: string): string {
  return toWesternDigits(name).replace(/\s+/g, ' ').trim()
}

export async function POST(req: Request) {
  try {
    const parsed = await parseBody(req, itemImportSchema)
    if (!parsed.ok) return badRequest(parsed.message)
    const { businessId, userId, csv, updateExisting, dryRun } = parsed.data

    const gate = await guard(req, { businessId, userId })
    if (!gate.ok) return gate.res

    const business = await db.business.findUnique({ where: { id: businessId } })
    if (!business) return notFound('النشاط التجاري غير موجود')

    const table = mapCsv(csv, SYNONYMS, normalizeAr)
    if (table.rows.length === 0) return badRequest('الملف مفيش فيه صفوف بعد العنوان')
    if (table.rows.length > MAX_ROWS) {
      return badRequest(`الملف فيه ${table.rows.length} صف — الحد الأقصى ${MAX_ROWS} صف في المرة`)
    }
    if (table.columns.name < 0) {
      return badRequest('لازم يكون فيه عمود «اسم الصنف» — اتأكد من صف العناوين في أول سطر')
    }

    const existing = await db.item.findMany({ where: { businessId }, select: { id: true, name: true } })
    const byKey = new Map(existing.map((i) => [nameKey(i.name), i.id]))
    const errors: { row: number; message: string }[] = []
    const toCreate: {
      name: string
      category: string
      unit: string
      costPrice: number
      sellPrice: number
      stockQty: number
      lowStockThreshold: number
      barcode: string | null
      aliases: string
      expiresAt: Date | null
    }[] = []
    const toUpdate: { id: string; data: Record<string, unknown> }[] = []
    let skipped = 0

    table.rows.forEach((row, index) => {
      const humanRow = index + 2 // 1-based + header row
      const name = (row.name ?? '').trim()
      if (!name) {
        skipped += 1
        return
      }
      const cost = parseFlexibleNumber(row.costPrice)
      const sell = parseFlexibleNumber(row.sellPrice)
      const stock = parseFlexibleNumber(row.stockQty)
      const min = parseFlexibleNumber(row.minQty)
      const expiryRaw = (row.expiresAt ?? '').trim()
      const expiry = expiryRaw ? parseFlexibleDate(expiryRaw) : null
      if (expiryRaw && !expiry) errors.push({ row: humanRow, message: `تاريخ الصلاحية «${expiryRaw}» مش مفهوم` })

      if (sell == null && cost == null) {
        errors.push({ row: humanRow, message: 'مفيش سعر بيع ولا تكلفة — الصف اتجاهل' })
        return
      }
      const sellPiastres = Math.round((sell ?? (cost as number) * 1.25) * 100)
      const costPiastres = Math.round((cost ?? sellPiastres / 100 / 1.25) * 100)
      if (sellPiastres < 0 || costPiastres < 0) {
        errors.push({ row: humanRow, message: 'السعر بالسالب — الصف اتجاهل' })
        return
      }
      const record = {
        name: cleanName(name).slice(0, 120),
        category: (row.category || 'منوع').slice(0, 60),
        unit: (row.unit || 'piece').slice(0, 20),
        costPrice: costPiastres,
        sellPrice: sellPiastres,
        stockQty: stock ?? 0,
        lowStockThreshold: Math.max(0, Math.round(min ?? 0)),
        barcode: row.barcode ? row.barcode.slice(0, 60) : null,
        aliases: row.aliases ? row.aliases.slice(0, 200) : '',
        expiresAt: expiry,
      }

      const key = nameKey(record.name)
      const existingId = byKey.get(key)
      if (existingId) {
        if (!updateExisting) {
          skipped += 1
          return
        }
        toUpdate.push({ id: existingId, data: record })
        return
      }
      byKey.set(key, 'pending')
      toCreate.push(record)
    })

    if (dryRun) {
      return NextResponse.json({
        dryRun: true,
        total: table.rows.length,
        created: toCreate.length,
        updated: toUpdate.length,
        skipped,
        unknownHeaders: table.unknownHeaders,
        errors,
        preview: toCreate.slice(0, 10).map((r) => ({ name: r.name, sellPrice: r.sellPrice, stockQty: r.stockQty })),
      })
    }

    // One transaction for the whole file: a half-imported catalog is worse than
    // a failed import (the owner can fix the file and retry).
    await db.$transaction([
      ...toCreate.map((data) => db.item.create({ data: { businessId, ...data } })),
      ...toUpdate.map((u) => db.item.update({ where: { id: u.id }, data: u.data })),
    ])

    invalidateCatalog(businessId)

    await db.auditEvent.create({
      data: {
        businessId,
        actor: userId,
        action: 'items.import',
        ref: null,
        detail: JSON.stringify({
          created: toCreate.length,
          updated: toUpdate.length,
          skipped,
          errors: errors.length,
          unknownHeaders: table.unknownHeaders,
        }),
      },
    })

    return NextResponse.json({
      total: table.rows.length,
      created: toCreate.length,
      updated: toUpdate.length,
      skipped,
      unknownHeaders: table.unknownHeaders,
      errors: errors.slice(0, 50),
    })
  } catch (e) {
    return serverError('items/import', e)
  }
}
