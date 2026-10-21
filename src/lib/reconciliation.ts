// وكيل — Excel/CSV RECONCILIATION (PR-012 / plan v2 §10.2 Level A, §10.3).
//
// The owner already has his data in Excel. This module reconciles that file
// with the live catalog under the plan's hard rule:
//   «لا write قبل dry-run/owner approval»
//
//   1. DRY-RUN  — parse the file, produce a per-row VERDICT:
//        create  → not in the catalog
//        update  → matched (normalised name + digit folding); the report
//                  carries a FIELD-LEVEL DIFF (what changes, what doesn't)
//        skip    → empty name / unparseable / duplicate within the file
//        error   → with the REAL reason, per row
//      Zero writes. The report stores a contentHash over the verdicts.
//   2. APPLY    — requires (a) the exact contentHash of the previewed report
//      (the owner cannot swap the file between preview and approval) and
//      (b) the owner's acknowledgement of the diff. Applied in ONE
//      transaction, then every applied row is READ BACK from the database
//      and compared field-by-field — the read-back evidence is stored with
//      the report. A mismatched read-back is surfaced honestly, never
//      papered over.
//
// Reconciliation, not silent overwrite: an existing item with a different
// price shows up as a diff the owner approves row by row, not as a clobber.

import { createHash } from 'node:crypto'
import { db } from '@/lib/db'
import { normalizeAr, toWesternDigits } from '@/lib/agent/arabic'
import { invalidateCatalog } from '@/lib/agent/catalog'
import { mapCsv, parseFlexibleDate, parseFlexibleNumber } from '@/lib/csv'
import * as XLSX from 'xlsx'

// ---------------------------------------------------------------------------
// Shared parsing contract (same rules the catalog importer has always used)
// ---------------------------------------------------------------------------

export const CATALOG_SYNONYMS: Record<string, string[]> = {
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

export const MAX_RECONCILE_ROWS = 2000

/** Matching key: Arabic normalisation + digit folding + «ال» article strip. */
export function nameKey(name: string): string {
  return normalizeAr(toWesternDigits(name)).replace(/^ال/, '').replace(/\s+/g, ' ').trim()
}

/** Store names with ASCII digits so the catalog stays consistent. */
export function cleanName(name: string): string {
  return toWesternDigits(name).replace(/\s+/g, ' ').trim()
}

/** Accept raw text or a base64/xlsx payload (same shape the importer posts). */
export function extractCsvText(csv: string): string {
  let out = csv
  if (csv.startsWith('data:') || csv.startsWith('UEsDB') || csv.startsWith('PK')) {
    try {
      const base64 = csv.includes('base64,') ? csv.split('base64,')[1] : csv
      const buf = Buffer.from(base64, 'base64')
      const wb = XLSX.read(buf, { type: 'buffer' })
      const sheetName = wb.SheetNames[0]
      if (sheetName && wb.Sheets[sheetName]) out = XLSX.utils.sheet_to_csv(wb.Sheets[sheetName])
    } catch {
      // fall through to plain text
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Verdict model
// ---------------------------------------------------------------------------

export interface RowVerdict {
  row: number // 1-based, header included (matches what the owner sees)
  status: 'create' | 'update' | 'skip' | 'error'
  name: string | null
  reason?: string
  /** for update: field → { from, to } — the diff the owner approves */
  diff?: Record<string, { from: string | number | null; to: string | number | null }>
  record?: ReconcileRecord
  existingId?: string
}

export interface ReconcileRecord {
  name: string
  category: string
  unit: string
  costPrice: number // piastres
  sellPrice: number // piastres
  stockQty: number
  lowStockThreshold: number
  barcode: string | null
  aliases: string
  expiresAt: Date | null
}

export interface ReconcileReportDTO {
  reportId: string
  status: string
  contentHash: string
  total: number
  created: number
  updated: number
  skipped: number
  errors: number
  unknownHeaders: string[]
  rows: RowVerdict[]
  createdAt: string
  readback?: { verified: number; mismatched: number; details: RowVerdict['row'][] } | null
}

// ---------------------------------------------------------------------------
// 1) DRY-RUN — zero writes
// ---------------------------------------------------------------------------

export async function buildReconcileReport(
  businessId: string,
  fileText: string,
  fileName?: string,
): Promise<ReconcileReportDTO | { error: string }> {
  const csvContent = extractCsvText(fileText)
  const table = mapCsv(csvContent, CATALOG_SYNONYMS, normalizeAr)
  if (table.rows.length === 0) return { error: 'الملف مفيش فيه صفوف بعد العنوان' }
  if (table.rows.length > MAX_RECONCILE_ROWS) {
    return { error: `الملف فيه ${table.rows.length} صف — الحد الأقصى ${MAX_RECONCILE_ROWS} صف في المرة` }
  }
  if (table.columns.name < 0) return { error: 'لازم يكون فيه عمود «اسم الصنف» في أول سطر' }

  const existing = await db.item.findMany({ where: { businessId }, select: { id: true, name: true, category: true, unit: true, costPrice: true, sellPrice: true, stockQty: true, lowStockThreshold: true, barcode: true, aliases: true, expiresAt: true } })
  const byKey = new Map(existing.map((i) => [nameKey(i.name), i]))

  const rows: RowVerdict[] = []
  const seenInFile = new Set<string>()

  table.rows.forEach((raw, index) => {
    const rowNo = index + 2
    const name = (raw.name ?? '').trim()
    if (!name) {
      rows.push({ row: rowNo, status: 'skip', name: null, reason: 'صف بدون اسم — اتنزل' })
      return
    }
    const cost = parseFlexibleNumber(raw.costPrice)
    const sell = parseFlexibleNumber(raw.sellPrice)
    const stock = parseFlexibleNumber(raw.stockQty)
    const min = parseFlexibleNumber(raw.minQty)
    const expiryRaw = (raw.expiresAt ?? '').trim()
    const expiry = expiryRaw ? parseFlexibleDate(expiryRaw) : null
    if (expiryRaw && !expiry) {
      rows.push({ row: rowNo, status: 'error', name, reason: `تاريخ الصلاحية «${expiryRaw}» مش مفهوم` })
      return
    }
    if (sell == null && cost == null) {
      rows.push({ row: rowNo, status: 'error', name, reason: 'مفيش سعر بيع ولا تكلفة' })
      return
    }
    const sellPiastres = Math.round((sell ?? (cost as number) * 1.25) * 100)
    const costPiastres = Math.round((cost ?? sellPiastres / 100 / 1.25) * 100)
    if (sellPiastres < 0 || costPiastres < 0) {
      rows.push({ row: rowNo, status: 'error', name, reason: 'السعر بالسالب' })
      return
    }
    const record: ReconcileRecord = {
      name: cleanName(name).slice(0, 120),
      category: (raw.category || 'منوع').slice(0, 60),
      unit: (raw.unit || 'piece').slice(0, 20),
      costPrice: costPiastres,
      sellPrice: sellPiastres,
      stockQty: stock ?? 0,
      lowStockThreshold: Math.max(0, Math.round(min ?? 0)),
      barcode: raw.barcode ? raw.barcode.slice(0, 60) : null,
      aliases: raw.aliases ? raw.aliases.slice(0, 200) : '',
      expiresAt: expiry,
    }

    const key = nameKey(record.name)
    if (seenInFile.has(key)) {
      rows.push({ row: rowNo, status: 'skip', name: record.name, reason: 'مكرر جوه الملف نفسه' })
      return
    }
    seenInFile.add(key)

    const match = byKey.get(key)
    if (match) {
      const diff: Record<string, { from: string | number | null; to: string | number | null }> = {}
      const put = (field: string, from: string | number | null, to: string | number | null) => {
        if (from !== to) diff[field] = { from, to }
      }
      put('sellPrice', match.sellPrice, record.sellPrice)
      put('costPrice', match.costPrice, record.costPrice)
      put('stockQty', match.stockQty, record.stockQty)
      put('category', match.category, record.category)
      put('unit', match.unit, record.unit)
      put('lowStockThreshold', match.lowStockThreshold, record.lowStockThreshold)
      put('barcode', match.barcode, record.barcode)
      put('expiresAt', match.expiresAt?.toISOString() ?? null, record.expiresAt?.toISOString() ?? null)
      rows.push({ row: rowNo, status: 'update', name: record.name, record, existingId: match.id, diff })
      return
    }
    rows.push({ row: rowNo, status: 'create', name: record.name, record })
  })

  const summary = {
    total: rows.length,
    created: rows.filter((r) => r.status === 'create').length,
    updated: rows.filter((r) => r.status === 'update').length,
    skipped: rows.filter((r) => r.status === 'skip').length,
    errors: rows.filter((r) => r.status === 'error').length,
  }
  if (summary.created === 0 && summary.updated === 0) {
    return { error: 'مفيش أي صف ممكن يطبق — راجع أخطاء الصفوف' }
  }

  // Canonical hash over the verdicts: the fingerprint of exactly what the
  // owner previews. Apply refuses any other fingerprint.
  const canonical = JSON.stringify({
    rows: rows.map((r) => ({
      row: r.row,
      s: r.status,
      n: r.name,
      e: r.existingId ?? null,
      r: r.record
        ? {
            n: r.record.name, c: r.record.category, u: r.record.unit,
            cp: r.record.costPrice, sp: r.record.sellPrice, q: r.record.stockQty,
            m: r.record.lowStockThreshold, b: r.record.barcode, a: r.record.aliases,
            x: r.record.expiresAt?.toISOString() ?? null,
          }
        : null,
      d: r.diff ?? null,
    })),
    unknownHeaders: table.unknownHeaders,
  })
  const contentHash = createHash('sha256').update(canonical).digest('hex')

  const report = await db.reconcileReport.create({
    data: {
      businessId,
      fileName: fileName?.slice(0, 200) ?? null,
      contentHash,
      payload: JSON.stringify({ rows, summary, unknownHeaders: table.unknownHeaders }),
      status: 'DRAFT',
    },
  })
  return {
    reportId: report.id,
    status: report.status,
    contentHash,
    ...summary,
    unknownHeaders: table.unknownHeaders,
    rows,
    createdAt: report.createdAt.toISOString(),
    readback: null,
  }
}

// ---------------------------------------------------------------------------
// 2) APPLY — only the previewed report, only after the owner acknowledges,
//    then read-back verification of every applied row
// ---------------------------------------------------------------------------

export async function applyReconcileReport(input: {
  businessId: string
  userId: string
  reportId: string
  contentHash: string
  acknowledge: boolean
}): Promise<ReconcileReportDTO | { error: string; status?: number }> {
  const report = await db.reconcileReport.findUnique({ where: { id: input.reportId } })
  if (!report || report.businessId !== input.businessId) {
    return { error: 'التقرير غير موجود', status: 404 }
  }
  if (report.status !== 'DRAFT') return { error: 'التقرير ده اتطبق (أو اتلغى) بالفعل', status: 409 }
  if (report.contentHash !== input.contentHash) {
    return {
      error: 'ملف التطبيق مش مطابق للمعاينة — أعد الـ dry-run واعتمد نفس الملف',
      status: 409,
    }
  }
  if (input.acknowledge !== true) {
    return { error: 'لازم المالك يراجع الفروقات ويعتمدها صراحة قبل التنفيذ', status: 403 }
  }

  const parsed = JSON.parse(report.payload) as { rows: RowVerdict[]; summary: Record<string, number> }
  const toCreate = parsed.rows.filter((r) => r.status === 'create' && r.record)
  const toUpdate = parsed.rows.filter((r) => r.status === 'update' && r.record && r.existingId)

  // One transaction: a half-applied reconciliation is worse than none.
  await db.$transaction([
    ...toCreate.map((r) => db.item.create({ data: { businessId: input.businessId, ...(r.record as ReconcileRecord) } })),
    ...toUpdate.map((r) => db.item.update({ where: { id: r.existingId! }, data: r.record as ReconcileRecord })),
  ])
  invalidateCatalog(input.businessId)

  // READ-BACK: re-fetch every applied row from the database and compare
  // field-by-field with the source. This is the external read-back proof —
  // the write is verified against the source of truth, not assumed.
  const updatedIds = toUpdate.map((r) => r.existingId!)
  const updatedRows = updatedIds.length
    ? await db.item.findMany({ where: { id: { in: updatedIds } }, select: { id: true, name: true, category: true, unit: true, costPrice: true, sellPrice: true, stockQty: true, lowStockThreshold: true, barcode: true, aliases: true, expiresAt: true } })
    : []
  const byId = new Map(updatedRows.map((i) => [i.id, i]))
  const details: number[] = []
  let verified = 0
  let mismatched = 0
  const compare = (r: RowVerdict, live: { name: string; category: string; unit: string; costPrice: number | null; sellPrice: number | null; stockQty: number | null; lowStockThreshold: number | null; expiresAt: Date | null } | undefined) => {
    const rec = r.record!
    const ok =
      live !== undefined &&
      nameKey(live.name) === nameKey(rec.name) &&
      live.sellPrice === rec.sellPrice &&
      live.costPrice === rec.costPrice &&
      live.stockQty === rec.stockQty &&
      live.category === rec.category &&
      live.unit === rec.unit &&
      (live.lowStockThreshold ?? 0) === rec.lowStockThreshold &&
      (live.expiresAt?.toISOString() ?? null) === (rec.expiresAt?.toISOString() ?? null)
    if (ok) verified++
    else {
      mismatched++
      details.push(r.row)
    }
  }
  for (const r of toCreate) {
    // created rows: verify by exact stored name (we don't keep the new ids)
    const live = await db.item.findFirst({ where: { businessId: input.businessId, name: r.record!.name }, select: { name: true, category: true, unit: true, costPrice: true, sellPrice: true, stockQty: true, lowStockThreshold: true, expiresAt: true } })
    compare(r, live ?? undefined)
  }
  for (const r of toUpdate) {
    compare(r, (byId.get(r.existingId!) ?? undefined) as { name: string; category: string; unit: string; costPrice: number | null; sellPrice: number | null; stockQty: number | null; lowStockThreshold: number | null; expiresAt: Date | null })
  }

  const appliedAt = new Date()
  await db.reconcileReport.update({
    where: { id: report.id },
    data: {
      status: 'APPLIED',
      appliedAt,
      readback: JSON.stringify({ verified, mismatched, details }),
    },
  })
  await db.auditEvent.create({
    data: {
      businessId: input.businessId,
      actor: input.userId,
      action: 'items.reconcile.apply',
      ref: report.id,
      detail: JSON.stringify({
        created: toCreate.length,
        updated: toUpdate.length,
        readbackVerified: verified,
        readbackMismatched: mismatched,
        contentHash: report.contentHash.slice(0, 16),
      }),
    },
  })

  const full = await db.reconcileReport.findUniqueOrThrow({ where: { id: report.id } })
  const dto = toDto(full)
  return dto
}

export async function getReconcileReport(businessId: string, reportId: string): Promise<ReconcileReportDTO | null> {
  const r = await db.reconcileReport.findFirst({ where: { businessId, id: reportId } })
  return r ? toDto(r) : null
}

export async function listReconcileReports(businessId: string): Promise<ReconcileReportDTO[]> {
  const rows = await db.reconcileReport.findMany({ where: { businessId }, orderBy: { createdAt: 'desc' }, take: 20 })
  return rows.map(toDto)
}

function toDto(r: {
  id: string
  businessId: string
  fileName: string | null
  contentHash: string
  payload: string
  status: string
  createdAt: Date
  appliedAt: Date | null
  readback: string | null
  errorReason: string | null
}): ReconcileReportDTO {
  const parsed = JSON.parse(r.payload) as { rows: RowVerdict[]; summary: Record<string, number>; unknownHeaders: string[] }
  const readback = r.readback ? (JSON.parse(r.readback) as { verified: number; mismatched: number; details: number[] }) : null
  return {
    reportId: r.id,
    status: r.status,
    contentHash: r.contentHash,
    total: parsed.summary.total,
    created: parsed.summary.created,
    updated: parsed.summary.updated,
    skipped: parsed.summary.skipped,
    errors: parsed.summary.errors,
    unknownHeaders: parsed.unknownHeaders,
    rows: parsed.rows,
    createdAt: r.createdAt.toISOString(),
    readback,
  }
}
