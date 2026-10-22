import { db } from '@/lib/db'
import { createDraft } from '@/lib/domain/executors'
import { CASHBOOK_KINDS } from '@/lib/domain/cashbook'
import { normalizeAr } from '@/lib/agent/arabic'
import { AuthorizationError } from '@/lib/security/permissions'
import { OperationConflictError, OperationValidationError } from '@/lib/domain/errors'
import type { OpType } from '@/lib/types'

const MAX_MINOR = 2_147_483_647
const DRAFT_TYPES = new Set<OpType>([
  'sale', 'purchase', 'expense', 'collection', 'payment',
  'cashbook', 'membership', 'attendance',
])
const PENDING_STATUSES = new Set(['AWAITING_APPROVAL'])

export class WakilBridgeError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'WakilBridgeError'
    this.status = status
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WakilBridgeError(400, field + ' لازم يكون كائن بيانات')
  }
  return value as Record<string, unknown>
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key))
  if (extra.length) throw new WakilBridgeError(400, 'حقول غير مسموحة في ' + context + ': ' + extra.join(', '))
}

function requiredString(value: unknown, field: string, max = 200): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new WakilBridgeError(400, field + ' مطلوب أو أطول من المسموح')
  }
  return value.trim()
}

function optionalString(value: unknown, field: string, max = 200): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return requiredString(value, field, max)
}

function integer(value: unknown, field: string, min = 1, max = MAX_MINOR): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new WakilBridgeError(400, field + ' لازم يكون عددًا صحيحًا بين ' + min + ' و' + max)
  }
  return value
}

/** Convert a JSON decimal in EGP to integer piastres without binary-float rounding. */
export function egpToPiastres(value: unknown, field: string, allowZero = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new WakilBridgeError(400, field + ' لازم يكون رقمًا بالجنيه المصري')
  }
  const text = String(value)
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
    throw new WakilBridgeError(400, field + ' يقبل بحد أقصى منزلتين عشريتين')
  }
  const parts = text.split('.')
  const whole = parts[0]
  const fractional = parts[1] ?? ''
  const amount = Number(whole) * 100 + Number(fractional.padEnd(2, '0'))
  if (!Number.isSafeInteger(amount) || amount > MAX_MINOR || (allowZero ? amount < 0 : amount < 1)) {
    throw new WakilBridgeError(400, field + ' خارج النطاق المالي المسموح')
  }
  return amount
}

function money(minor: number | null | undefined) {
  if (minor == null) return null
  const sign = minor < 0 ? '-' : ''
  const abs = Math.abs(minor)
  return { piastres: minor, egp: sign + Math.floor(abs / 100) + '.' + String(abs % 100).padStart(2, '0') }
}

function parseJsonObject(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function safePayload(type: string, raw: string): Record<string, unknown> {
  const payload = parseJsonObject(raw)
  const keys = [
    'lines', 'itemId', 'itemName', 'qty', 'unitPrice', 'total', 'paid',
    'amount', 'customerId', 'customerName', 'supplierId', 'supplierName',
    'partyName', 'kind', 'occurredOn', 'dueOn', 'note', 'reason', 'months',
    'plan', 'expectedCash',
  ]
  const safe: Record<string, unknown> = {}
  for (const key of keys) {
    if (payload[key] !== undefined && payload[key] !== null) safe[key] = payload[key]
  }
  if ((type === 'sale' || type === 'purchase') && Array.isArray(safe.lines)) {
    safe.lines = (safe.lines as unknown[]).slice(0, 20).map((line) => {
      if (!line || typeof line !== 'object' || Array.isArray(line)) return {}
      const item = line as Record<string, unknown>
      return {
        ...(typeof item.itemId === 'string' ? { itemId: item.itemId } : {}),
        ...(typeof item.qty === 'number' ? { qty: item.qty } : {}),
        ...(typeof item.unitPrice === 'number' ? { unitPrice: item.unitPrice } : {}),
        ...(typeof item.total === 'number' ? { total: item.total } : {}),
      }
    })
  }
  return safe
}

function toLimit(raw: unknown, fallback = 20, maximum = 50): number {
  if (raw === undefined || raw === null) return fallback
  return integer(raw, 'limit', 1, maximum)
}

async function listCatalog(businessId: string, body: Record<string, unknown>) {
  onlyKeys(body, ['action', 'query', 'limit', 'requestId'], 'catalog')
  const query = optionalString(body.query, 'query', 100)
  const limit = toLimit(body.limit, 30, 100)
  const rows = await db.item.findMany({
    where: { businessId },
    orderBy: { name: 'asc' },
    take: 500,
    select: {
      id: true, name: true, aliases: true, unit: true, category: true,
      sellPrice: true, costPrice: true, stockQty: true, lowStockThreshold: true,
      barcode: true, expiresAt: true,
    },
  })
  const needle = query ? normalizeAr(query) : ''
  const matches = needle
    ? rows.filter((item) => normalizeAr(item.name + ' ' + item.aliases + ' ' + (item.barcode ?? '')).includes(needle))
    : rows
  return {
    count: matches.length,
    limit,
    items: matches.slice(0, limit).map((item) => ({
      id: item.id,
      name: item.name,
      aliases: item.aliases,
      unit: item.unit,
      category: item.category,
      sellPrice: money(item.sellPrice),
      costPrice: money(item.costPrice),
      stockQty: item.stockQty,
      stockKnown: item.stockQty !== null,
      lowStockThreshold: item.lowStockThreshold,
      barcode: item.barcode,
      expiresAt: item.expiresAt?.toISOString() ?? null,
    })),
    note: 'القيم null معناها غير مسجلة، وليست صفرًا. بيانات المخزون والأسعار للقراءة فقط.',
  }
}

async function listParties(businessId: string, body: Record<string, unknown>) {
  onlyKeys(body, ['action', 'partyType', 'query', 'limit', 'requestId'], 'parties')
  const partyType = body.partyType
  if (partyType !== 'customers' && partyType !== 'suppliers') {
    throw new WakilBridgeError(400, 'partyType لازم يكون customers أو suppliers')
  }
  const query = optionalString(body.query, 'query', 100)
  const limit = toLimit(body.limit, 30, 100)
  const needle = query ? normalizeAr(query) : ''

  if (partyType === 'customers') {
    const rows = await db.customer.findMany({
      where: { businessId }, orderBy: { name: 'asc' }, take: 500,
      select: { id: true, name: true, phone: true, balance: true, plan: true, expiresAt: true },
    })
    const matches = needle ? rows.filter((row) => normalizeAr(row.name + ' ' + (row.phone ?? '')).includes(needle)) : rows
    return {
      partyType, count: matches.length, limit,
      parties: matches.slice(0, limit).map((row) => ({
        id: row.id, name: row.name, phone: row.phone, balance: money(row.balance),
        plan: row.plan, expiresAt: row.expiresAt?.toISOString() ?? null,
      })),
      note: 'رصيد العميل الموجب يعني مبلغًا مستحقًا للنشاط حسب دفتر وكيل.',
    }
  }

  const rows = await db.supplier.findMany({
    where: { businessId }, orderBy: { name: 'asc' }, take: 500,
    select: { id: true, name: true, phone: true, balance: true },
  })
  const matches = needle ? rows.filter((row) => normalizeAr(row.name + ' ' + (row.phone ?? '')).includes(needle)) : rows
  return {
    partyType, count: matches.length, limit,
    parties: matches.slice(0, limit).map((row) => ({
      id: row.id, name: row.name, phone: row.phone, balance: money(row.balance),
    })),
    note: 'رصيد المورد الموجب يعني مبلغًا مستحقًا للمورد حسب دفتر وكيل.',
  }
}

async function listPending(businessId: string, body: Record<string, unknown>) {
  onlyKeys(body, ['action', 'limit', 'requestId'], 'pending operations')
  const limit = toLimit(body.limit, 20, 50)
  const rows = await db.operation.findMany({
    where: { businessId, status: 'AWAITING_APPROVAL' },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true, ref: true, type: true, status: true, summary: true, risk: true, payload: true, createdAt: true, expiresAt: true },
  })
  return {
    count: rows.length,
    operations: rows.map((op) => ({
      id: op.id,
      ref: op.ref,
      type: op.type,
      status: op.status,
      summary: op.summary,
      risk: op.risk,
      payload: safePayload(op.type, op.payload),
      createdAt: op.createdAt.toISOString(),
      expiresAt: op.expiresAt?.toISOString() ?? null,
    })),
    note: 'هذه مسودات معلقة فقط. وكيل عبر DSH لا يملك أداة اعتماد أو تنفيذ؛ المالك يعتمدها من واجهة وكيل.',
  }
}

async function overview(businessId: string, body: Record<string, unknown>) {
  onlyKeys(body, ['action', 'requestId'], 'overview')
  const business = await db.business.findUnique({ where: { id: businessId }, select: { id: true, name: true, type: true, workflowMode: true, currency: true, timezone: true, openingCash: true } })
  if (!business) throw new WakilBridgeError(503, 'إعداد النشاط التجاري غير صالح؛ راجع WAKIL_DSH_BUSINESS_ID')
  const [cashEntries, itemCount, unknownStockCount, customerRows, supplierRows, pendingCount, recent] = await Promise.all([
    db.cashEntry.findMany({ where: { businessId }, select: { direction: true, amount: true } }),
    db.item.count({ where: { businessId } }),
    db.item.count({ where: { businessId, stockQty: null } }),
    db.customer.findMany({ where: { businessId }, select: { balance: true } }),
    db.supplier.findMany({ where: { businessId }, select: { balance: true } }),
    db.operation.count({ where: { businessId, status: 'AWAITING_APPROVAL' } }),
    db.operation.findMany({ where: { businessId }, orderBy: { createdAt: 'desc' }, take: 5, select: { ref: true, type: true, status: true, summary: true, createdAt: true } }),
  ])
  const cashDelta = cashEntries.reduce((sum, entry) => sum + (entry.direction === 'in' ? entry.amount : -entry.amount), 0)
  const receivable = customerRows.reduce((sum, row) => sum + Math.max(0, row.balance), 0)
  const payable = supplierRows.reduce((sum, row) => sum + Math.max(0, row.balance), 0)
  const ledgerCash = business.openingCash + cashDelta
  return {
    business: { id: business.id, name: business.name, type: business.type, workflowMode: business.workflowMode, currency: business.currency, timezone: business.timezone },
    ledgerCash: money(ledgerCash),
    cashIsPhysicalCount: false,
    receivables: money(receivable),
    payables: money(payable),
    catalog: { itemCount, stockUnknownCount: unknownStockCount },
    pendingApprovalCount: pendingCount,
    recentOperations: recent.map((op) => ({ ...op, createdAt: op.createdAt.toISOString() })),
    note: 'الأرصدة من دفتر وكيل وليست جردًا ماديًا. لا تعتبر الفرق ربحًا أو مبيعات. الأرقام null تعني غير مسجلة وليست صفرًا.',
  }
}

async function uniquePartyId(
  businessId: string,
  kind: 'customer' | 'supplier',
  id: unknown,
  name: unknown,
): Promise<string> {
  const suppliedId = typeof id === 'string' ? id.trim() : ''
  if (kind === 'customer') {
    if (suppliedId) {
      const row = await db.customer.findFirst({ where: { id: suppliedId, businessId }, select: { id: true, name: true } })
      if (!row) throw new WakilBridgeError(400, 'الحساب المحدد غير موجود داخل النشاط الحالي: customer')
      const suppliedName = optionalString(name, 'customerName', 100)
      if (suppliedName && normalizeAr(suppliedName) !== normalizeAr(row.name)) {
        throw new WakilBridgeError(400, 'معرّف الحساب لا يطابق اسمه؛ راجع المسودة')
      }
      return row.id
    }
    const suppliedName = requiredString(name, 'customerName', 100)
    const rows = await db.customer.findMany({ where: { businessId }, select: { id: true, name: true } })
    const matches = rows.filter((row) => normalizeAr(row.name) === normalizeAr(suppliedName))
    if (matches.length === 0) throw new WakilBridgeError(400, 'العميل «' + suppliedName + '» غير موجود. اعرض العملاء ثم حدّد الحساب الصحيح؛ لن أنشئ حسابًا ضمنيًا للتحصيل.')
    if (matches.length > 1) throw new WakilBridgeError(409, 'أكثر من عميل يطابق «' + suppliedName + '»؛ استخدم معرف الحساب الصحيح.')
    return matches[0].id
  }

  if (suppliedId) {
    const row = await db.supplier.findFirst({ where: { id: suppliedId, businessId }, select: { id: true, name: true } })
    if (!row) throw new WakilBridgeError(400, 'الحساب المحدد غير موجود داخل النشاط الحالي: supplier')
    const suppliedName = optionalString(name, 'supplierName', 100)
    if (suppliedName && normalizeAr(suppliedName) !== normalizeAr(row.name)) {
      throw new WakilBridgeError(400, 'معرّف الحساب لا يطابق اسمه؛ راجع المسودة')
    }
    return row.id
  }
  const suppliedName = requiredString(name, 'supplierName', 100)
  const rows = await db.supplier.findMany({ where: { businessId }, select: { id: true, name: true } })
  const matches = rows.filter((row) => normalizeAr(row.name) === normalizeAr(suppliedName))
  if (matches.length === 0) throw new WakilBridgeError(400, 'المورد «' + suppliedName + '» غير موجود. اعرض الموردين ثم حدّد الحساب الصحيح؛ لن أنشئ حسابًا ضمنيًا للسداد.')
  if (matches.length > 1) throw new WakilBridgeError(409, 'أكثر من مورد يطابق «' + suppliedName + '»؛ استخدم معرف الحساب الصحيح.')
  return matches[0].id
}

async function normalizeDraftPayload(type: OpType, sourceValue: unknown, businessId: string): Promise<Record<string, unknown>> {
  const source = record(sourceValue, 'payload')

  if (type === 'sale' || type === 'purchase') {
    onlyKeys(source, ['lines', 'paidEgp', 'customerId', 'customerName', 'supplierId', 'supplierName', 'note'], type)
    if (!Array.isArray(source.lines) || source.lines.length < 1 || source.lines.length > 20) {
      throw new WakilBridgeError(400, 'مسودة البيع أو الشراء تحتاج من بند إلى 20 بندًا')
    }

    // Materialize every fact that createDraft's validator would otherwise add.
    // This makes the idempotency hash stable on retries: input and persisted
    // payload are byte-equivalent in meaning before the domain executor runs.
    const lines: Record<string, unknown>[] = []
    let total = 0
    for (let index = 0; index < source.lines.length; index++) {
      const line = record(source.lines[index], 'lines[' + index + ']')
      onlyKeys(line, ['itemId', 'qty', 'unitPriceEgp'], 'lines[' + index + ']')
      const itemId = requiredString(line.itemId, 'lines[' + index + '].itemId', 100)
      const qty = integer(line.qty, 'lines[' + index + '].qty', 1, 1_000_000)
      const item = await db.item.findFirst({
        where: { id: itemId, businessId },
        select: { id: true, name: true, stockQty: true, sellPrice: true, costPrice: true },
      })
      if (!item) throw new WakilBridgeError(400, 'الصنف المحدد غير موجود في كتالوج النشاط الحالي')
      if (type === 'sale') {
        if (item.stockQty === null) {
          throw new WakilBridgeError(422, 'رصيد مخزون «' + item.name + '» غير مسجل. سجّل الجرد أولًا قبل تجهيز مسودة بيع.')
        }
        if (qty > item.stockQty) {
          throw new WakilBridgeError(422, 'الكمية المطلوبة من «' + item.name + '» أكبر من الرصيد المسجل (' + item.stockQty + '). راجع المخزون قبل تجهيز المسودة.')
        }
      }
      const catalogPrice = type === 'sale' ? item.sellPrice : item.costPrice
      if (line.unitPriceEgp == null && catalogPrice === null) {
        throw new WakilBridgeError(422, (type === 'sale' ? 'سعر بيع ' : 'تكلفة شراء ') + '«' + item.name + '» غير مسجلة. اسأل المالك عن السعر قبل تجهيز المسودة.')
      }
      const unitPrice = line.unitPriceEgp == null
        ? catalogPrice!
        : egpToPiastres(line.unitPriceEgp, 'lines[' + index + '].unitPriceEgp')
      if (!Number.isSafeInteger(unitPrice) || unitPrice < 1 || unitPrice > MAX_MINOR) {
        throw new WakilBridgeError(400, 'سعر الوحدة خارج النطاق المالي المسموح')
      }
      const lineTotal = qty * unitPrice
      if (!Number.isSafeInteger(lineTotal) || lineTotal < 1 || lineTotal > MAX_MINOR) {
        throw new WakilBridgeError(400, 'إجمالي البند خارج النطاق المالي المسموح')
      }
      total += lineTotal
      if (!Number.isSafeInteger(total) || total > MAX_MINOR) {
        throw new WakilBridgeError(400, 'إجمالي العملية خارج النطاق المالي المسموح')
      }
      lines.push({ itemId, qty, unitPrice, total: lineTotal })
    }

    const paid = source.paidEgp == null ? total : egpToPiastres(source.paidEgp, 'paidEgp', true)
    if (paid > total) throw new WakilBridgeError(400, 'المدفوع أكبر من إجمالي العملية')
    const payload: Record<string, unknown> = { lines, total, paid }
    if (source.note != null) {
      const note = optionalString(source.note, 'note', 1000)
      if (note) payload.note = note
    }
    if (type === 'sale') {
      if (source.supplierId != null || source.supplierName != null) throw new WakilBridgeError(400, 'مسودة البيع لا تقبل بيانات مورد')
      if (source.customerId != null) {
        const customerId = requiredString(source.customerId, 'customerId', 100)
        const customer = await db.customer.findFirst({ where: { id: customerId, businessId }, select: { id: true, name: true } })
        if (!customer) throw new WakilBridgeError(400, 'العميل المحدد غير موجود داخل النشاط الحالي')
        payload.customerId = customer.id
        const customerName = optionalString(source.customerName, 'customerName', 100)
        if (customerName && normalizeAr(customerName) !== normalizeAr(customer.name)) {
          throw new WakilBridgeError(400, 'معرّف العميل لا يطابق اسمه؛ راجع الحساب قبل تجهيز المسودة')
        }
        payload.customerName = customer.name
      } else if (source.customerName != null) {
        payload.customerName = requiredString(source.customerName, 'customerName', 100)
      }
    } else {
      if (source.customerId != null || source.customerName != null) throw new WakilBridgeError(400, 'مسودة الشراء لا تقبل بيانات عميل')
      if (source.supplierId != null) {
        const supplierId = requiredString(source.supplierId, 'supplierId', 100)
        const supplier = await db.supplier.findFirst({ where: { id: supplierId, businessId }, select: { id: true, name: true } })
        if (!supplier) throw new WakilBridgeError(400, 'المورد المحدد غير موجود داخل النشاط الحالي')
        payload.supplierId = supplier.id
        const supplierName = optionalString(source.supplierName, 'supplierName', 100)
        if (supplierName && normalizeAr(supplierName) !== normalizeAr(supplier.name)) {
          throw new WakilBridgeError(400, 'معرّف المورد لا يطابق اسمه؛ راجع الحساب قبل تجهيز المسودة')
        }
        payload.supplierName = supplier.name
      } else if (source.supplierName != null) {
        payload.supplierName = requiredString(source.supplierName, 'supplierName', 100)
        payload.newSupplier = true
      }
    }
    if (paid < total) {
      if (type === 'sale' && !payload.customerId && !payload.customerName) {
        throw new WakilBridgeError(422, 'البيع الآجل يحتاج تحديد حساب العميل أو اسمه قبل تجهيز المسودة.')
      }
      if (type === 'purchase' && !payload.supplierId && !payload.supplierName) {
        throw new WakilBridgeError(422, 'الشراء الآجل يحتاج تحديد حساب المورد أو اسمه قبل تجهيز المسودة.')
      }
    }
    return payload
  }

  if (type === 'expense') {
    onlyKeys(source, ['totalEgp', 'reason', 'note'], type)
    const total = egpToPiastres(source.totalEgp, 'totalEgp')
    const reason = requiredString(source.reason, 'reason', 160)
    const note = optionalString(source.note, 'note', 1000)
    return { total, reason, ...(note ? { note } : {}) }
  }

  if (type === 'collection' || type === 'payment') {
    onlyKeys(source, ['amountEgp', 'customerId', 'customerName', 'supplierId', 'supplierName', 'note'], type)
    const amount = egpToPiastres(source.amountEgp, 'amountEgp')
    const note = optionalString(source.note, 'note', 1000)
    if (type === 'collection') {
      if (source.supplierId != null || source.supplierName != null) throw new WakilBridgeError(400, 'التحصيل يخص عميلًا لا موردًا')
      return { amount, customerId: await uniquePartyId(businessId, 'customer', source.customerId, source.customerName), ...(note ? { note } : {}) }
    }
    if (source.customerId != null || source.customerName != null) throw new WakilBridgeError(400, 'السداد يخص موردًا لا عميلًا')
    return { amount, supplierId: await uniquePartyId(businessId, 'supplier', source.supplierId, source.supplierName), ...(note ? { note } : {}) }
  }

  if (type === 'membership') {
    onlyKeys(source, ['totalEgp', 'paidEgp', 'customerId', 'customerName', 'months', 'plan', 'note'], type)
    const total = egpToPiastres(source.totalEgp, 'totalEgp')
    const paid = source.paidEgp == null ? total : egpToPiastres(source.paidEgp, 'paidEgp', true)
    if (paid > total) throw new WakilBridgeError(400, 'المدفوع أكبر من إجمالي الاشتراك')
    const customerId = optionalString(source.customerId, 'customerId', 100)
    const customerName = optionalString(source.customerName, 'customerName', 100)
    const months = source.months == null ? undefined : integer(source.months, 'months', 1, 120)
    const plan = optionalString(source.plan, 'plan', 100)
    const note = optionalString(source.note, 'note', 1000)
    return { total, paid, ...(customerId ? { customerId } : {}), ...(customerName ? { customerName } : {}), ...(months ? { months } : {}), ...(plan ? { plan } : {}), ...(note ? { note } : {}) }
  }

  if (type === 'attendance') {
    onlyKeys(source, ['customerId', 'customerName', 'note'], type)
    const customerId = await uniquePartyId(businessId, 'customer', source.customerId, source.customerName)
    const note = optionalString(source.note, 'note', 1000)
    return { customerId, ...(note ? { note } : {}) }
  }

  if (type === 'cashbook') {
    onlyKeys(source, ['kind', 'amountEgp', 'occurredOn', 'dueOn', 'note', 'partyName', 'customerId', 'supplierId', 'expectedCashEgp', 'reason'], type)
    if (!CASHBOOK_KINDS.includes(String(source.kind) as typeof CASHBOOK_KINDS[number])) {
      throw new WakilBridgeError(400, 'نوع حركة دفتر الكاش غير معروف')
    }
    const kind = source.kind as typeof CASHBOOK_KINDS[number]
    const amount = egpToPiastres(source.amountEgp, 'amountEgp', kind === 'cash_count')
    const occurredOn = requiredString(source.occurredOn, 'occurredOn', 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(occurredOn) || Number.isNaN(Date.parse(occurredOn + 'T00:00:00.000Z')) || new Date(occurredOn + 'T00:00:00.000Z').toISOString().slice(0, 10) !== occurredOn) {
      throw new WakilBridgeError(400, 'occurredOn لازم يكون تاريخًا صحيحًا بصيغة YYYY-MM-DD')
    }
    const dueOn = optionalString(source.dueOn, 'dueOn', 10)
    if (dueOn && (!/^\d{4}-\d{2}-\d{2}$/.test(dueOn) || Number.isNaN(Date.parse(dueOn + 'T00:00:00.000Z')) || new Date(dueOn + 'T00:00:00.000Z').toISOString().slice(0, 10) !== dueOn)) {
      throw new WakilBridgeError(400, 'dueOn لازم يكون تاريخًا صحيحًا بصيغة YYYY-MM-DD')
    }
    const note = source.note == null ? '' : requiredString(source.note, 'note', 1000)
    let partyName = optionalString(source.partyName, 'partyName', 100)
    let customerId = optionalString(source.customerId, 'customerId', 100)
    let supplierId = optionalString(source.supplierId, 'supplierId', 100)
    const expectedCash = source.expectedCashEgp == null ? undefined : egpToPiastres(source.expectedCashEgp, 'expectedCashEgp', true)
    const reason = optionalString(source.reason, 'reason', 160)
    if (kind === 'cash_count' && expectedCash === undefined) throw new WakilBridgeError(400, 'expectedCashEgp مطلوب لمقارنة عدّ الخزنة')
    if (kind !== 'cash_count' && expectedCash !== undefined) throw new WakilBridgeError(400, 'expectedCashEgp يخص عدّ الخزنة فقط')

    const customerKinds = new Set(['credit_sale', 'lend', 'receive'])
    const supplierKinds = new Set(['credit_purchase', 'cash_purchase', 'borrow', 'pay'])
    if (customerKinds.has(kind)) {
      if (supplierId) throw new WakilBridgeError(400, 'نوع الحركة يحتاج حساب عميل وليس موردًا')
      if (customerId) {
        const row = await db.customer.findFirst({ where: { id: customerId, businessId }, select: { id: true, name: true } })
        if (!row) throw new WakilBridgeError(400, 'العميل المحدد غير موجود داخل النشاط الحالي')
        if (partyName && normalizeAr(partyName) !== normalizeAr(row.name)) throw new WakilBridgeError(400, 'اسم العميل لا يطابق المعرف المحدد')
        customerId = row.id
        partyName = row.name
      } else if (partyName) {
        const rows = await db.customer.findMany({ where: { businessId }, select: { id: true, name: true } })
        const found = rows.filter((row) => normalizeAr(row.name) === normalizeAr(partyName!))
        if (found.length > 1) throw new WakilBridgeError(409, 'هناك أكثر من عميل بنفس الاسم؛ حدّد المعرف الصحيح.')
        if (found.length === 1) {
          customerId = found[0].id
          partyName = found[0].name
        } else if (kind === 'receive') {
          throw new WakilBridgeError(400, 'العميل غير موجود للتحصيل؛ لا يمكن تسجيل تحصيل على حساب غير معروف.')
        }
      }
    } else if (supplierKinds.has(kind)) {
      if (customerId) throw new WakilBridgeError(400, 'نوع الحركة يحتاج حساب مورد وليس عميلًا')
      if (supplierId) {
        const row = await db.supplier.findFirst({ where: { id: supplierId, businessId }, select: { id: true, name: true } })
        if (!row) throw new WakilBridgeError(400, 'المورد المحدد غير موجود داخل النشاط الحالي')
        if (partyName && normalizeAr(partyName) !== normalizeAr(row.name)) throw new WakilBridgeError(400, 'اسم المورد لا يطابق المعرف المحدد')
        supplierId = row.id
        partyName = row.name
      } else if (partyName) {
        const rows = await db.supplier.findMany({ where: { businessId }, select: { id: true, name: true } })
        const found = rows.filter((row) => normalizeAr(row.name) === normalizeAr(partyName!))
        if (found.length > 1) throw new WakilBridgeError(409, 'هناك أكثر من مورد بنفس الاسم؛ حدّد المعرف الصحيح.')
        if (found.length === 1) {
          supplierId = found[0].id
          partyName = found[0].name
        } else if (kind === 'pay') {
          throw new WakilBridgeError(400, 'المورد غير موجود للسداد؛ لا يمكن تسجيل سداد على حساب غير معروف.')
        }
      }
    } else if (partyName || customerId || supplierId) {
      throw new WakilBridgeError(400, 'الحركة دي لا تقبل حساب عميل أو مورد')
    }
    return {
      kind, amount, occurredOn, dateSource: 'user_day', note,
      ...(dueOn ? { dueOn } : {}), ...(partyName ? { partyName } : {}),
      ...(customerId ? { customerId } : {}), ...(supplierId ? { supplierId } : {}),
      ...(expectedCash === undefined ? {} : { expectedCash }), ...(reason ? { reason } : {}),
    }
  }

  throw new WakilBridgeError(400, 'نوع العملية غير مدعوم في إضافة DSH')
}

export async function runWakilDshAction(input: {
  action: string
  body: Record<string, unknown>
  businessId: string
  userId: string
}) {
  const { action, body, businessId, userId } = input
  if (['approve', 'execute', 'confirm', 'reject', 'delete'].includes(action)) {
    throw new WakilBridgeError(403, 'إضافة DSH لا تملك صلاحية اعتماد أو تنفيذ أو حذف عمليات وكيل؛ استخدم واجهة وكيل الخاصة بالمالك')
  }

  switch (action) {
    case 'overview':
      return overview(businessId, body)
    case 'catalog':
      return listCatalog(businessId, body)
    case 'parties':
      return listParties(businessId, body)
    case 'pending_operations':
      return listPending(businessId, body)
    case 'prepare_draft': {
      onlyKeys(body, ['action', 'requestId', 'operationType', 'summary', 'payload'], 'prepare_draft')
      if (!DRAFT_TYPES.has(body.operationType as OpType)) {
        throw new WakilBridgeError(400, 'نوع العملية غير مدعوم؛ الأنواع المتاحة: ' + [...DRAFT_TYPES].join(', '))
      }
      const requestId = requiredString(body.requestId, 'requestId', 64)
      if (!/^[a-f0-9]{64}$/.test(requestId)) throw new WakilBridgeError(400, 'requestId غير صالح')
      const type = body.operationType as OpType
      const summary = requiredString(body.summary, 'summary', 240)
      const payload = await normalizeDraftPayload(type, body.payload, businessId)
      const op = await createDraft({
        businessId,
        userId,
        type,
        summary,
        payload,
        idempotencyKey: 'dsh:' + requestId,
      })
      const pending = PENDING_STATUSES.has(op.status)
      return {
        draft: {
          id: op.id, ref: op.ref, type: op.type, status: op.status,
          summary: op.summary, risk: op.risk, payload: safePayload(op.type, op.payload),
          createdAt: op.createdAt.toISOString(), expiresAt: op.expiresAt?.toISOString() ?? null,
        },
        mutationExecuted: false,
        ownerApprovalRequired: pending,
        message: pending
          ? 'تم تجهيز المسودة ' + op.ref + ' فقط. لم يتغير المخزون أو الخزنة أو أرصدة العملاء والموردين. اعتماد المالك مطلوب من واجهة وكيل.'
          : 'الطلب ده موجود بالفعل بحالة ' + op.status + '. لم تنشأ مسودة جديدة ولم يُنفَّذ أي شيء من إضافة DSH.',
      }
    }
    default:
      throw new WakilBridgeError(400, 'إجراء غير معروف')
  }
}

export const __bridgeTest = {
  record,
  onlyKeys,
}
