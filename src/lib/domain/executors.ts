import { recordLegacyDebtEffects, prepareLegacyDebtReversal } from './debt-settlements'
import { assertPromiseRole, executeDebtPromise, reverseDebtPromise } from './debt-promises'
import { executeCashbook, reverseCashbook, assertCashbookRole } from './cashbook'
// وكيل — deterministic domain executors.
// The LLM extracts intent; THESE functions are the only writers of business truth.
// Every write: idempotency key, state machine, verification read-back, audit event.

import type { Item, Operation, Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import type { OpType, Risk } from '@/lib/types'
import { invalidateCatalog } from '@/lib/agent/catalog'
import { normalizeAr } from '@/lib/agent/arabic'
import { arUnit } from '@/lib/verticals'
import { egp, qty as fmtQty, arDate } from '@/lib/format'
import { canApproveOperation, canDraft, computeRisk } from './risk'
import { AuthorizationError, requireBusinessUser } from '@/lib/security/permissions'
import { validateOperationPayload } from './operation-validation'
import { OperationConflictError, OperationValidationError } from './errors'
import { prepareAccountingVerification } from './operation-verification'
import { canonicalPayloadHash } from './payload-hash'

// R71 / PR-003 — how long an approval holds. A draft older than this is
// CANCELLED on approval attempt; the owner redrafts (a stale «اعملها» is not
// an approval). Named + exported so tests and policy share one constant.
export const DRAFT_TTL_MS = 20 * 60 * 1000

export interface DraftFields {
  [key: string]: unknown
}

export type ExecOutcome = {
  ok: boolean
  checks: { label: string; expected: string; actual: string; pass: boolean }[]
  effects: { label: string; value: string; tone: 'good' | 'bad' | 'neutral' }[]
  failReason?: string
}

// ---------------------------------------------------------------------------
// Ref generation (atomic)
// ---------------------------------------------------------------------------
async function nextRef(businessId: string, client: Prisma.TransactionClient): Promise<string> {
  // refs are globally unique, not tenant-local. Keep the existing WKL-digits
  // format; allocate under the same SQLite write transaction as the draft.
  const { _max } = await client.business.aggregate({ _max: { opSeq: true } })
  let seq = (_max.opSeq ?? 0) + 1
  while (await client.operation.findUnique({ where: { ref: `WKL-${1000 + seq}` } })) seq++
  await client.business.update({ where: { id: businessId }, data: { opSeq: seq } })
  return `WKL-${1000 + seq}`
}

async function audit(businessId: string, actor: string, action: string, ref: string, detail: unknown, client: Prisma.TransactionClient = db) {
  await client.auditEvent.create({
    data: { businessId, actor, action, ref, detail: JSON.stringify(detail ?? {}) },
  })
}

function effectiveRisk(type: OpType, payload: DraftFields, requested?: string): Risk {
  const amount = Math.max(...['total', 'amount', 'balance'].map((key) => Math.abs(Number(payload[key] ?? 0))))
  const floor = computeRisk(type, amount)
  if (!requested) return floor
  if (!/^R[0-4]$/.test(requested)) throw new OperationValidationError('درجة خطورة غير صالحة')
  return Number(requested[1]) > Number(floor[1]) ? requested as Risk : floor
}

// ---------------------------------------------------------------------------
// Draft creation — called by the agent harness after server-side validation
// ---------------------------------------------------------------------------
export async function createDraft(params: {
  businessId: string
  userId: string
  type: OpType
  summary: string
  payload: DraftFields
  risk?: string
  conversationId?: string | null
  idempotencyKey: string
  replaceDraftRef?: string
}): Promise<Operation> {
  return db.$transaction(async (tx) => {
    const user = await requireBusinessUser(params.businessId, params.userId, tx)
    if (!canDraft(user.role, params.type)) throw new AuthorizationError()
    if (params.type === 'debt_promise') await assertPromiseRole(tx, params.businessId, user.role, params.payload)
    if (params.type === 'cashbook') assertCashbookRole(user.role, params.payload.kind)
    // R71 / PR-003 (§20.5): the key is bound to THIS payload. Reusing a key
    // with a different payload is a collision, not a replay — refuse it.
    // `supersedesRef` is draft-link metadata (added below for cashbook
    // corrections), not a financial fact — it is excluded from the binding.
    const hashable: Record<string, unknown> = { ...params.payload }
    delete hashable.supersedesRef
    const requestHash = canonicalPayloadHash(hashable)
    const existing = await tx.operation.findUnique({ where: { idempotencyKey: params.idempotencyKey } })
    if (existing) {
      if (existing.businessId !== params.businessId || existing.userId !== params.userId || existing.type !== params.type) {
        throw new AuthorizationError()
      }
      let recordedPayloadHash: string
      try {
        const recordedPayload: unknown = JSON.parse(existing.payload)
        if (!recordedPayload || typeof recordedPayload !== 'object' || Array.isArray(recordedPayload)) {
          throw new Error('Stored operation payload is not an object')
        }
        delete (recordedPayload as Record<string, unknown>).supersedesRef
        recordedPayloadHash = canonicalPayloadHash(recordedPayload)
      } catch {
        throw new OperationValidationError('العملية القديمة لا يمكن التحقق من حمولة مفتاح الاعتماد بتاعها — أوقف إعادة الطلب وراجع حالة العملية المسجلة')
      }
      // The persisted payloadHash binds the normalized bytes approved/executed.
      // A null/mismatching value cannot safely support a replay.
      if (existing.payloadHash == null || existing.payloadHash !== recordedPayloadHash) {
        throw new OperationValidationError('حمولة المسودة المخزنة لا تطابق بصمة الاعتماد — إعادة الطلب مرفوضة لسلامة السجل')
      }
      if (existing.requestPayloadHash != null) {
        // New rows bind the original request separately from normalized bytes,
        // so defaults such as paid=total do not turn a harmless retry into a
        // false collision.
        if (existing.requestPayloadHash !== requestHash) {
          throw new OperationValidationError('مفتاح الاعتماد ده اتستخدم بالفعل لمسودة مختلفة — العملية اللي قدامك هي اللي مسجلة')
        }
      } else if (recordedPayloadHash !== requestHash) {
        // R85 upgrade path: prior releases stored only the normalized approval
        // hash. If the incoming representation differs, we cannot prove that
        // server-added defaults match the original request. Fail closed and
        // ask the caller to inspect the existing operation instead of replaying
        // or suggesting a new key that could duplicate a financial action.
        throw new OperationValidationError('المسودة أقدم من بصمة الطلب الأصلي؛ لا يمكن إثبات تطابق إعادة المحاولة بأمان. راجع حالة العملية المسجلة قبل أي إعادة')
      }
      return existing
    }
    if (params.conversationId && !await tx.conversation.findFirst({ where: {
      id: params.conversationId, businessId: params.businessId, userId: params.userId,
    } })) throw new AuthorizationError()
    let replaced: Operation | null = null
    if (params.replaceDraftRef) {
      if (params.type !== 'cashbook' || !params.conversationId) throw new OperationValidationError('التصحيح ده يخص مسودة دفتر من نفس المحادثة بس')
      replaced = await tx.operation.findFirst({ where: { ref: params.replaceDraftRef, businessId: params.businessId, userId: params.userId, conversationId: params.conversationId, type: 'cashbook', status: 'AWAITING_APPROVAL' } })
      if (!replaced) throw new OperationConflictError()
      assertCashbookRole(user.role, (JSON.parse(replaced.payload) as DraftFields).kind)
      params.payload.supersedesRef = replaced.ref
    }
    await validateOperationPayload(tx, params.businessId, params.type, params.payload)
    const risk = effectiveRisk(params.type, params.payload, params.risk)
    const ref = await nextRef(params.businessId, tx)
    // R71 / PR-003: bind the draft to a canonical payload hash NOW, and bound
    // its approval window. The hash is recomputed at approval from the stored
    // payload; a mismatch means the draft changed after it was recorded.
    // `supersedesRef` (draft-link metadata) is excluded, same as at request time.
    const boundHash = canonicalPayloadHash({ ...params.payload, supersedesRef: undefined })
    const op = await tx.operation.create({ data: {
      ref, businessId: params.businessId, type: params.type, status: 'AWAITING_APPROVAL',
      source: 'chat', userId: params.userId, risk, summary: params.summary,
      payload: JSON.stringify(params.payload), idempotencyKey: params.idempotencyKey,
      conversationId: params.conversationId ?? null,
      payloadHash: boundHash,
      requestPayloadHash: requestHash,
      expiresAt: new Date(Date.now() + DRAFT_TTL_MS),
    } })
    if (replaced) {
      const canceled = await tx.operation.updateMany({ where: { id: replaced.id, status: 'AWAITING_APPROVAL' }, data: { status: 'CANCELLED', reason: `استُبدلت بمسودة ${ref} بناءً على تصحيح المستخدم`, decidedAt: new Date() } })
      if (canceled.count !== 1) throw new OperationConflictError()
      await audit(params.businessId, params.userId, 'operation.cancelled', replaced.ref, { action: 'superseded', replacementRef: ref }, tx)
    }
    await audit(params.businessId, params.userId, 'operation.drafted', ref, { summary: params.summary, risk, ...(replaced ? { supersedesRef: replaced.ref } : {}) }, tx)
    return op
  }, { maxWait: 10_000, timeout: 15_000 })
}

// Claim, effects, verification, terminal status and audit share ONE SQLite
// transaction. EXECUTING is never a durable intermediate state in this path.
// A savepoint lets a verified rollback record FAILED_SAFE atomically; if storage
// cannot roll back or record failure, the entire transaction (claim too) aborts.
class FailedVerification extends Error {
  readonly outcome: ExecOutcome
  constructor(outcome: ExecOutcome) {
    super(outcome.failReason ?? 'فشل التحقق')
    this.outcome = outcome
  }
}

export async function executeOperation(opId: string, decidedBy: string, reason?: string): Promise<{ op: Operation; outcome: ExecOutcome }> {
  let prepared: { op: Operation; outcome: ExecOutcome } | undefined
  try {
    const result = await db.$transaction(async (tx) => {
      const op = await tx.operation.findUnique({ where: { id: opId } })
      if (!op) throw new OperationConflictError()
      const user = await requireBusinessUser(op.businessId, decidedBy, tx)
      const payload = JSON.parse(op.payload) as DraftFields
      const risk = effectiveRisk(op.type as OpType, payload, op.risk)
      if (!canApproveOperation(user.role, op.type as OpType, risk)) throw new AuthorizationError()
      if (op.type === 'debt_promise') await assertPromiseRole(tx, op.businessId, user.role, payload)
      if (op.type === 'cashbook') assertCashbookRole(user.role, payload.kind)
      if (op.status !== 'AWAITING_APPROVAL') throw new OperationConflictError()
      // R71 / PR-003 (§20.4): the approval is bound to the RECORDED payload
      // and bounded in time. A tampered or expired draft ends in a RECORDED
      // terminal state (status + failReason + audit) — never a silent no-op,
      // never a financial effect.
      const hashable: Record<string, unknown> = { ...payload }
      delete hashable.supersedesRef
      const tampered = op.payloadHash != null && canonicalPayloadHash(hashable) !== op.payloadHash
      const expired = op.expiresAt != null && op.expiresAt.getTime() < Date.now()
      if (tampered || expired) {
        const failReason = tampered
          ? 'مسودة معدلة بعد تسجيلها — الاعتماد مرفوض (اللي في السجل مش هو اللي اتسجل بـ payloadHash)'
          : 'انتهت صلاحية الاعتماد (أكتر من ٢٠ دقيقة من التسجيل) — اعمل المسودة من جديد واعتمدها'
        const updated = await tx.operation.update({ where: { id: opId }, data: {
          status: tampered ? 'FAILED_SAFE' : 'CANCELLED',
          failReason,
          reason: tampered ? 'payload hash mismatch' : 'expired',
          decidedAt: new Date(), executedAt: new Date(),
        } })
        await audit(op.businessId, decidedBy, tampered ? 'operation.tamper_rejected' : 'operation.expired_rejected', op.ref, { failReason }, tx)
        const outcome: ExecOutcome = { ok: false, checks: [], effects: [], failReason }
        const terminal = { op: updated, outcome }
        prepared = terminal
        return terminal
      }
      const decisionReason = reason?.trim() || op.reason?.trim() || (typeof payload.reason === 'string' ? payload.reason.trim() : '')
      if (risk === 'R3' && !decisionReason) throw new OperationValidationError('العمليات الحساسة (R3) محتاجة سبب إلزامي')
      const claimed = await tx.operation.updateMany({
        where: { id: opId, status: 'AWAITING_APPROVAL' },
        data: { status: 'EXECUTING', decidedAt: new Date(), risk, ...(decisionReason ? { reason: decisionReason } : {}) },
      })
      if (!claimed.count) throw new OperationConflictError()
      await tx.$executeRawUnsafe('SAVEPOINT operation_effects')
      let terminal: { op: Operation; outcome: ExecOutcome }
      try {
        await validateOperationPayload(tx, op.businessId, op.type as OpType, payload)
        const validatedRisk = effectiveRisk(op.type as OpType, payload, op.risk)
        if (!canApproveOperation(user.role, op.type as OpType, validatedRisk)) throw new AuthorizationError()
        if (validatedRisk === 'R3' && !decisionReason) throw new OperationValidationError('العمليات الحساسة (R3) محتاجة سبب إلزامي')
        const verifyAccounting = await prepareAccountingVerification(tx, op.businessId, op.ref, op.type as OpType, payload)
        const outcome = await executorsFor(tx)[op.type as OpType](op.businessId, op.ref, payload)
        if (outcome.ok) await recordLegacyDebtEffects(tx, op.businessId, op.ref, op.type as OpType, payload)
        if (outcome.ok) outcome.checks.push(...await verifyAccounting())
        if (!outcome.ok || outcome.checks.some((check) => !check.pass)) throw new FailedVerification(outcome)
        const updated = await tx.operation.update({ where: { id: opId }, data: {
          status: 'SUCCEEDED', risk: validatedRisk, payload: JSON.stringify(payload), result: JSON.stringify(outcome), executedAt: new Date(),
        } })
        await audit(op.businessId, decidedBy, 'operation.succeeded', op.ref, { checks: outcome.checks.length }, tx)
        terminal = { op: updated, outcome }
      } catch (err) {
        // Do not claim safe failure unless rollback to this savepoint succeeds.
        // An unavailable/corrupt DB may abort this too; outer rollback then
        // discards the claim, rather than committing a stranded EXECUTING row.
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT operation_effects')
        const failReason = err instanceof FailedVerification || err instanceof OperationValidationError || err instanceof AuthorizationError
          ? err.message : 'فشل حفظ العملية — لم يتم تثبيت أي أثر مالي'
        if (!(err instanceof FailedVerification || err instanceof OperationValidationError || err instanceof AuthorizationError)) {
          console.error('[operations] effects rolled back', { opId, error: err })
        }
        const outcome: ExecOutcome = err instanceof FailedVerification
          ? { ...err.outcome, ok: false, effects: [], failReason }
          : { ok: false, checks: [], effects: [], failReason }
        const updated = await tx.operation.update({ where: { id: opId }, data: {
          status: 'FAILED_SAFE', failReason, result: JSON.stringify(outcome), executedAt: new Date(),
        } })
        await audit(op.businessId, decidedBy, 'operation.failed_safe', op.ref, { failReason }, tx)
        terminal = { op: updated, outcome }
      }
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT operation_effects')
      prepared = terminal
      return terminal
    }, { maxWait: 10_000, timeout: 15_000 })
    invalidateCatalog(result.op.businessId)
    return result
  } catch (err) {
    // Only a terminal result prepared by THIS transaction can be recovered
    // after a lost commit acknowledgement. Never convert an ordinary conflict
    // into approval or relabel historical EXECUTING rows as safe failures.
    if (prepared) {
      const current = await db.operation.findUnique({ where: { id: opId } })
      if (current?.status === prepared.op.status && current.result === prepared.op.result) {
        invalidateCatalog(current.businessId)
        return { op: current, outcome: prepared.outcome }
      }
    }
    throw err
  }
}

export async function rejectOperation(opId: string, decidedBy: string, reason?: string, action: 'reject' | 'cancel' = 'reject'): Promise<Operation> {
  return db.$transaction(async (tx) => {
    const op = await tx.operation.findUnique({ where: { id: opId } })
    if (!op) throw new OperationConflictError()
    const user = await requireBusinessUser(op.businessId, decidedBy, tx)
    const risk = effectiveRisk(op.type as OpType, JSON.parse(op.payload) as DraftFields, op.risk)
    if (op.type === 'cashbook') assertCashbookRole(user.role, (JSON.parse(op.payload) as DraftFields).kind)
    if (op.type === 'debt_promise') await assertPromiseRole(tx, op.businessId, user.role, JSON.parse(op.payload) as DraftFields)
    const ownCancellation = action === 'cancel' && op.userId === decidedBy && canDraft(user.role, op.type as OpType)
    if (!ownCancellation && !canApproveOperation(user.role, op.type as OpType, risk)) throw new AuthorizationError()
    const changed = await tx.operation.updateMany({
      where: { id: opId, status: 'AWAITING_APPROVAL' },
      data: { status: 'CANCELLED', reason: reason?.trim() || 'رفضها المستخدم', decidedAt: new Date() },
    })
    if (!changed.count) throw new OperationConflictError()
    await audit(op.businessId, decidedBy, 'operation.cancelled', op.ref, { reason: reason ?? 'رفض', action }, tx)
    return tx.operation.findUniqueOrThrow({ where: { id: opId } })
  })
}

// ---------------------------------------------------------------------------
// Per-type executors: apply effects + verify against source of truth
// ---------------------------------------------------------------------------
type Executor = (businessId: string, ref: string, p: Record<string, unknown>) => Promise<ExecOutcome>

function executorsFor(db: Prisma.TransactionClient): Record<OpType, Executor> {
  // Prisma promises are lazy. Await each on this transaction's connection;
  // nested transactions would commit independently or be unsupported.
  async function apply(queries: Prisma.PrismaPromise<unknown>[]) {
    for (const query of queries) await query
  }
  async function stockBefore(itemId: string): Promise<number | null> {
    const it = await db.item.findUniqueOrThrow({ where: { id: itemId }, select: { stockQty: true } })
    return it.stockQty
  }
  // R70 / PR-001: an uncounted stock is «غير مسجل» — never 0, never a number.
  const stockStr = (v: number | null, unit: string) => (v == null ? 'غير مسجل' : fmtQty(v, unit))
  async function cashNet(businessId: string): Promise<number> {
    const entries = await db.cashEntry.findMany({ where: { businessId }, select: { direction: true, amount: true } })
    const inn = entries.filter((e) => e.direction === 'in').reduce((s, e) => s + e.amount, 0)
    const out = entries.filter((e) => e.direction === 'out').reduce((s, e) => s + e.amount, 0)
    const biz = await db.business.findUniqueOrThrow({ where: { id: businessId }, select: { openingCash: true } })
    return biz.openingCash + inn - out
  }

  // R41 «موظف حقيقي»: a NEW item / supplier drafted without IDs (the pending
  // new-item flow registers them at draft time) is resolved or created at
  // approval — the counterparty is born with its first operation,
  // cashbook-style. Matching uses the canonical app normalization (tatweel,
  // alif/hamza, Arabic-Indic digits) so «السمانة المصرية» and «السمانة
  // المصريه» are the same party and a retried approval never duplicates.
  const normName = (s: string) => normalizeAr(String(s ?? '')).replace(/\s+/g, ' ').trim()
  async function resolveItem(businessId: string, p: Record<string, unknown>): Promise<Item> {
    if (p.itemId) {
      const it = await db.item.findUnique({ where: { id: String(p.itemId) } })
      if (!it) throw new OperationValidationError('الصنف مش موجود')
      return it
    }
    const name = String(p.itemName ?? '').trim()
    if (!name) throw new OperationValidationError('اسم الصنف الجديد ناقص')
    const all = await db.item.findMany({ where: { businessId } })
    const found = all.find(
      (i) => normName(i.name) === normName(name) || (i.aliases ?? '').split(',').some((a) => a.trim() && normName(a) === normName(name)),
    )
    if (found) return found
    // R70 / PR-001: a newborn item inherits ONLY what the approved
    // transaction actually says. cost = the purchase price (explicit, or
    // exactly implied by total/qty); sell = only if the owner stated one —
    // it is NEVER copied from cost (the old code made cost the "sell" price).
    // stockQty 0 is a fact here (the item is created by this purchase, whose
    // qty the executor adds); the threshold is left unknown until the owner
    // sets it — a made-up 5 would fake shortages.
    const impliedCost = p.unitPrice != null ? Math.round(Number(p.unitPrice))
      : Number(p.qty) > 0 && Number(p.total) % Number(p.qty) === 0 ? Math.round(Number(p.total) / Number(p.qty))
      : null
    const created = await db.item.create({
      data: {
        businessId,
        name,
        unit: String(p.unit ?? 'piece'),
        costPrice: impliedCost,
        sellPrice: p.sellPrice != null ? Math.round(Number(p.sellPrice)) : null,
        stockQty: 0,
        lowStockThreshold: null,
      },
    })
    invalidateCatalog()
    return created
  }
  async function resolveSupplierId(businessId: string, p: Record<string, unknown>): Promise<string | null> {
    if (p.supplierId) return String(p.supplierId)
    const name = String(p.supplierName ?? '').trim()
    if (!name) return null
    const all = await db.supplier.findMany({ where: { businessId } })
    const found = all.find((s) => normName(s.name) === normName(name))
    if (found) return found.id
    return (await db.supplier.create({ data: { businessId, name, balance: 0 } })).id
  }
  return {
    debt_promise: (businessId, ref, p) => executeDebtPromise(db, businessId, ref, p),
    cashbook: (businessId, ref, p) => executeCashbook(db, businessId, ref, p),
    async sale(businessId, ref, p) {
      // Multi-line basket (chat drafts with 2+ items — one approval, one receipt)
      const rawLines = Array.isArray(p.lines) ? (p.lines as Record<string, unknown>[]).filter((l) => l && typeof l === 'object') : []
      if (rawLines.length > 0) {
        type Res = { itemId: string; name: string; qty: number; unit: string; unitPrice: number; total: number; before: number | null }
        const resolved: Res[] = []
        for (const l of rawLines) {
          const item = await db.item.findUnique({ where: { id: String(l.itemId) } })
          if (!item) return { ok: false, checks: [], effects: [], failReason: 'الصنف مش موجود' }
          const qty = Number(l.qty ?? 0)
          if (!(qty > 0)) return { ok: false, checks: [], effects: [], failReason: `كمية ${item.name} لازم تكون أكبر من صفر` }
          // The server materialized/validated these prices when drafting.
          // Approval must not silently reprice a reviewed basket.
          const unitPrice = Number(l.unitPrice ?? item.sellPrice)
          resolved.push({ itemId: item.id, name: item.name, qty, unit: item.unit, unitPrice, total: Math.round(qty * unitPrice), before: await stockBefore(item.id) })
        }
        for (const r of resolved) {
          // R70 / PR-001: selling against an UNCOUNTED stock is forbidden —
          // we can't promise availability we never measured. Ask for a count.
          if (r.before == null) {
            return { ok: false, checks: [], effects: [], failReason: `الكمية في مخزون «${r.name}» غير مسجلة — اعمل جرد (سجّل الكمية الموجودة) الأول عشان نتأكد إن في كمية تكفي` }
          }
          if (r.qty > r.before) {
            return { ok: false, checks: [], effects: [], failReason: `الكمية المطلوبة من ${r.name} (${fmtQty(r.qty, arUnit(r.unit))}) أكبر من المتاح (${fmtQty(r.before, arUnit(r.unit))})` }
          }
        }
        const total = resolved.reduce((s, r) => s + r.total, 0)
        if (total <= 0) return { ok: false, checks: [], effects: [], failReason: 'الإجمالي لازم يكون أكبر من صفر' }
        const paid = Math.min(Number(p.paid ?? total), total)
        const remaining = total - paid
        // R48: a sale drafted under a typed name («العميل محمد») resolves the
        // customer AT APPROVAL — the customer_add draft of the same turn is
        // approved first, so the name is in the book by then.
        const customerId = p.customerId
          ? String(p.customerId)
          : p.customerName
            ? (await db.customer.findFirst({ where: { businessId, name: String(p.customerName) } }))?.id ?? null
            : null
        if (remaining > 0 && !customerId) {
          return {
            ok: false,
            checks: [],
            effects: [],
            failReason: `البيع فيه آجل ${egp(remaining)} لعميل «${p.customerName ?? 'غير محدد'}» مش مسجل — سجّل العميل الأول واعتمد البيعة تاني`,
          }
        }

        await apply([
          ...resolved.map((r) => db.item.update({ where: { id: r.itemId }, data: { stockQty: { decrement: Math.round(r.qty) } } })),
          db.cashEntry.create({ data: { businessId, direction: 'in', amount: paid, reason: `بيع — ${resolved.map((r) => r.name).join(' + ')}`, ref } }),
          ...(customerId && remaining !== 0 ? [db.customer.update({ where: { id: customerId }, data: { balance: { increment: remaining } } })] : []),
        ])

        // Verification read-back — per line (before is non-null here: the
        // uncounted-stock guard above rejected the whole basket otherwise)
        const checks: { label: string; expected: string; actual: string; pass: boolean }[] = []
        const effects: { label: string; value: string; tone: 'good' | 'bad' | 'neutral' }[] = []
        let allOk = true
        for (const r of resolved) {
          const b = r.before as number
          const after = await stockBefore(r.itemId)
          const pass = after !== null && after === b - Math.round(r.qty)
          allOk = allOk && pass
          checks.push({ label: `مخزون ${r.name} نقص بالمقدار الصح`, expected: fmtQty(b - r.qty, arUnit(r.unit)), actual: stockStr(after, arUnit(r.unit)), pass })
          effects.push({ label: `مخزون ${r.name}`, value: `${stockStr(b, arUnit(r.unit))} ← ${stockStr(after, arUnit(r.unit))}`, tone: 'neutral' })
        }
        effects.push(
          { label: 'خزنة (قبض)', value: egp(paid), tone: 'good' },
          ...(remaining > 0 && customerId ? [{ label: 'رصيد العميل (آجل)', value: egp(remaining), tone: 'bad' as const }] : []),
        )
        return { ok: allOk, checks, effects }
      }

      // Single-line (legacy chat + seed shape)
      const itemId = String(p.itemId)
      const item = await db.item.findUnique({ where: { id: itemId } })
      if (!item) return { ok: false, checks: [], effects: [], failReason: 'الصنف مش موجود' }
      const qtyN = Number(p.qty ?? 0)
      const total = Number(p.total ?? 0)
      if (total <= 0) return { ok: false, checks: [], effects: [], failReason: 'الإجمالي لازم يكون أكبر من صفر' }
      const before = await stockBefore(itemId)
      // R70 / PR-001: never sell against an uncounted stock (unknown ≠ 0).
      if (before == null) {
        return { ok: false, checks: [], effects: [], failReason: `الكمية في مخزون «${item.name}» غير مسجلة — اعمل جرد (سجّل الكمية الموجودة) الأول عشان نتأكد إن في كمية تكفي` }
      }
      if (qtyN > before) {
        return { ok: false, checks: [], effects: [], failReason: `الكمية المطلوبة (${fmtQty(qtyN, arUnit(item.unit))}) أكبر من المتاح (${fmtQty(before, arUnit(item.unit))})` }
      }
      const paid = Number(p.paid ?? total)
      const remaining = total - paid
      // R48: resolve a typed customer name at approval time (the customer_add
      // draft of the same turn is approved first) — and a credit sale must
      // NEVER book its debt into the void.
      const customerId = p.customerId
        ? String(p.customerId)
        : p.customerName
          ? (await db.customer.findFirst({ where: { businessId, name: String(p.customerName) } }))?.id ?? null
          : null
      if (remaining > 0 && !customerId) {
        return {
          ok: false,
          checks: [],
          effects: [],
          failReason: `البيع فيه آجل ${egp(remaining)} لعميل «${p.customerName ?? 'غير محدد'}» مش مسجل — سجّل العميل الأول واعتمد البيعة تاني`,
        }
      }

      const txOps: Prisma.PrismaPromise<unknown>[] = [
        db.item.update({ where: { id: itemId }, data: { stockQty: { decrement: Math.round(qtyN) } } }),
        db.cashEntry.create({ data: { businessId, direction: 'in', amount: paid, reason: `بيع — ${item.name}`, ref } }),
      ]
      if (customerId && remaining !== 0) {
        txOps.push(db.customer.update({ where: { id: customerId }, data: { balance: { increment: remaining } } }))
      }
      await apply(txOps)

      // Verification read-back
      const after = await stockBefore(itemId)
      const checks = [
        { label: 'المخزون نقص بالمقدار الصح', expected: fmtQty(before - qtyN, arUnit(item.unit)), actual: stockStr(after, arUnit(item.unit)), pass: after !== null && after === before - Math.round(qtyN) },
      ]
      return {
        ok: checks.every((c) => c.pass),
        checks,
        effects: [
          { label: `مخزون ${item.name}`, value: `${stockStr(before, arUnit(item.unit))} ← ${stockStr(after, arUnit(item.unit))}`, tone: 'neutral' },
          { label: 'خزنة (قبض)', value: egp(paid), tone: 'good' },
          ...(remaining > 0 && customerId ? [{ label: `رصيد العميل (آجل)`, value: egp(remaining), tone: 'bad' as const }] : []),
        ],
      }
    },

    async purchase(businessId, ref, p) {
      // Multi-line basket (chat drafts with 2+ items)
      const rawLines = Array.isArray(p.lines) ? (p.lines as Record<string, unknown>[]).filter((l) => l && typeof l === 'object') : []
      if (rawLines.length > 0) {
        type Res = { itemId: string; name: string; qty: number; unit: string; unitPrice: number; total: number; before: number | null; explicitPrice: boolean }
        const resolved: Res[] = []
        for (const l of rawLines) {
          let item: Item | null
          if (l.itemId) {
            item = await db.item.findUnique({ where: { id: String(l.itemId) } })
            if (!item) return { ok: false, checks: [], effects: [], failReason: 'الصنف مش موجود' }
          } else {
            try {
              item = await resolveItem(businessId, l)
            } catch (e) {
              return { ok: false, checks: [], effects: [], failReason: (e as Error).message }
            }
          }
          const qty = Number(l.qty ?? 0)
          if (!(qty > 0)) return { ok: false, checks: [], effects: [], failReason: `كمية ${item.name} لازم تكون أكبر من صفر` }
          const unitPrice = Number(l.unitPrice ?? item.costPrice)
          resolved.push({ itemId: item.id, name: item.name, qty, unit: item.unit, unitPrice, total: Math.round(qty * unitPrice), before: await stockBefore(item.id), explicitPrice: l.unitPrice != null })
        }
        const total = resolved.reduce((s, r) => s + r.total, 0)
        if (total <= 0) return { ok: false, checks: [], effects: [], failReason: 'الإجمالي لازم يكون أكبر من صفر' }
        const paid = Math.min(Number(p.paid ?? total), total)
        const remaining = total - paid
        const supplierId = await resolveSupplierId(businessId, p)

        // ONE transaction: stock movements, the cash entry and the supplier
        // balance either all land or none do (no half-executed purchase).
        // R70 / PR-001: an explicit purchase price resolves an UNKNOWN cost —
        // the approved transaction is a trusted source. It only fills a NULL
        // (updateMany where costPrice IS NULL): a known cost is never
        // overwritten here — changing a known cost is a price_change decision.
        // Unknown stock stays unknown (unknown + qty ≠ known total).
        await apply([
          ...resolved.map((r) => db.item.update({ where: { id: r.itemId }, data: { stockQty: { increment: Math.round(r.qty) } } })),
          ...resolved.filter((r) => r.explicitPrice).map((r) => db.item.updateMany({ where: { id: r.itemId, costPrice: null }, data: { costPrice: r.unitPrice } })),
          db.cashEntry.create({ data: { businessId, direction: 'out', amount: paid, reason: `شرا — ${resolved.map((r) => r.name).join(' + ')}`, ref } }),
          ...(supplierId && remaining !== 0 ? [db.supplier.update({ where: { id: supplierId }, data: { balance: { increment: remaining } } })] : []),
        ])
        // R41: new lines (drafted without IDs) get theirs IN THE PAYLOAD
        // itself — the in-memory object is what the debt ledger, the
        // accounting verification and the final SUCCEEDED write all read,
        // and it is what a later reversal re-reads by ref.
        for (const l of rawLines) {
          if (!l.itemId) {
            const r = resolved.find((x) => x.name === l.name)
            if (r) l.itemId = r.itemId
          }
        }
        if (supplierId) p.supplierId = supplierId

        const checks: { label: string; expected: string; actual: string; pass: boolean }[] = []
        const effects: { label: string; value: string; tone: 'good' | 'bad' | 'neutral' }[] = []
        let allOk = true
        for (const r of resolved) {
          const after = await stockBefore(r.itemId)
          // R70 / PR-001: an uncounted stock stays unknown after the purchase
          // — we can't claim a total we never measured.
          const pass = r.before == null ? after === null : after === r.before + Math.round(r.qty)
          allOk = allOk && pass
          checks.push({
            label: r.before == null ? `الشراء اتسجل (مخزون ${r.name} غير مسجل)` : `مخزون ${r.name} زاد بالمقدار الصح`,
            expected: stockStr(r.before == null ? null : r.before + r.qty, arUnit(r.unit)),
            actual: stockStr(after, arUnit(r.unit)),
            pass,
          })
          effects.push({
            label: `مخزون ${r.name}`,
            value: r.before == null ? `غير مسجل (شُترى ${fmtQty(r.qty, arUnit(r.unit))})` : `${stockStr(r.before, arUnit(r.unit))} ← ${stockStr(after, arUnit(r.unit))}`,
            tone: 'neutral',
          })
        }
        effects.push(
          { label: 'خزنة (دفع)', value: egp(-paid), tone: 'bad' },
          ...(remaining > 0 && supplierId ? [{ label: 'المستحق للمورد', value: egp(remaining), tone: 'bad' as const }] : []),
        )
        return { ok: allOk, checks, effects }
      }

      // R41: a new-item purchase (itemId null, itemName set) resolves or
      // creates the item HERE — the item is born at approval of its first
      // operation, and a retried approval finds it by name instead of
      // duplicating it.
      let item: Item
      if (p.itemId) {
        const found = await db.item.findUnique({ where: { id: String(p.itemId) } })
        if (!found) return { ok: false, checks: [], effects: [], failReason: 'الصنف مش موجود' }
        item = found
      } else {
        try {
          item = await resolveItem(businessId, p)
        } catch (e) {
          return { ok: false, checks: [], effects: [], failReason: (e as Error).message }
        }
      }
      const itemId = item.id
      const qtyN = Number(p.qty ?? 0)
      const total = Number(p.total ?? 0)
      if (total <= 0) return { ok: false, checks: [], effects: [], failReason: 'الإجمالي لازم يكون أكبر من صفر' }
      const paid = Number(p.paid ?? total)
      const remaining = total - paid
      const supplierId = await resolveSupplierId(businessId, p)
      const before = await stockBefore(itemId)
      // R70 / PR-001: an explicit (or exactly implied) purchase price resolves
      // an UNKNOWN cost — the approved transaction is a trusted source. Only
      // fills NULL; a known cost is a price_change decision, never overwritten.
      const costToRecord = p.unitPrice != null ? Math.round(Number(p.unitPrice))
        : qtyN > 0 && total % qtyN === 0 ? Math.round(total / qtyN)
        : null

      const txOps: Prisma.PrismaPromise<unknown>[] = [
        db.item.update({ where: { id: itemId }, data: { stockQty: { increment: Math.round(qtyN) } } }),
        ...(costToRecord != null ? [db.item.updateMany({ where: { id: itemId, costPrice: null }, data: { costPrice: costToRecord } })] : []),
        db.cashEntry.create({ data: { businessId, direction: 'out', amount: paid, reason: `شرا — ${item.name}`, ref } }),
      ]
      if (supplierId && remaining !== 0) {
        txOps.push(db.supplier.update({ where: { id: supplierId }, data: { balance: { increment: remaining } } }))
      }
      await apply(txOps)
      // R41: the draft was saved without IDs — write the resolved ones back
      // INTO the payload. The in-memory object is what the debt ledger, the
      // accounting verification and the final SUCCEEDED write all read, and
      // it is what a later reversal re-reads by ref.
      p.itemId = item.id
      if (supplierId) p.supplierId = supplierId

      const after = await stockBefore(itemId)
      // R70 / PR-001: uncounted stock stays unknown after the purchase.
      const checks = [
        {
          label: before == null ? `الشراء اتسجل (مخزون ${item.name} غير مسجل)` : 'المخزون زاد بالمقدار الصح',
          expected: stockStr(before == null ? null : before + qtyN, arUnit(item.unit)),
          actual: stockStr(after, arUnit(item.unit)),
          pass: before == null ? after === null : after === before + Math.round(qtyN),
        },
      ]
      return {
        ok: checks.every((c) => c.pass),
        checks,
        effects: [
          { label: `مخزون ${item.name}`, value: before == null ? `غير مسجل (شُترى ${fmtQty(qtyN, arUnit(item.unit))})` : `${stockStr(before, arUnit(item.unit))} ← ${stockStr(after, arUnit(item.unit))}`, tone: 'neutral' },
          { label: 'خزنة (دفع)', value: egp(-paid), tone: 'bad' },
          ...(remaining > 0 && supplierId ? [{ label: 'المستحق للمورد', value: egp(remaining), tone: 'bad' as const }] : []),
        ],
      }
    },

    async expense(businessId, ref, p) {
      const total = Number(p.total ?? 0)
      const label = String(p.label ?? 'مصروف')
      if (total <= 0) return { ok: false, checks: [], effects: [], failReason: 'المبلغ لازم يكون أكبر من صفر' }
      const before = await cashNet(businessId)
      await db.cashEntry.create({ data: { businessId, direction: 'out', amount: total, reason: `مصروف — ${label}`, ref } })
      const after = await cashNet(businessId)
      return {
        ok: after === before - total,
        checks: [{ label: 'الخزنة نقصت بالمبلغ الصح', expected: egp(before - total), actual: egp(after), pass: after === before - total }],
        effects: [{ label: `مصروف ${label}`, value: egp(-total), tone: 'bad' }],
      }
    },

    async collection(businessId, ref, p) {
      const customerId = String(p.customerId ?? '')
      const customer = await db.customer.findUnique({ where: { id: customerId } })
      if (!customer) return { ok: false, checks: [], effects: [], failReason: 'العميل مش موجود' }
      const amount = Number(p.amount ?? 0)
      if (amount <= 0) return { ok: false, checks: [], effects: [], failReason: 'المبلغ لازم يكون أكبر من صفر' }
      const before = customer.balance
      if (amount > before) return { ok: false, checks: [], effects: [], failReason: `المبلغ أكبر من المديونية (${egp(before)})` }
      await apply([
        db.customer.update({ where: { id: customerId }, data: { balance: { decrement: amount } } }),
        db.cashEntry.create({ data: { businessId, direction: 'in', amount, reason: `تحصيل — ${customer.name}`, ref } }),
      ])
      const after = (await db.customer.findUniqueOrThrow({ where: { id: customerId }, select: { balance: true } })).balance
      return {
        ok: after === before - amount,
        checks: [{ label: `رصيد ${customer.name}`, expected: egp(before - amount), actual: egp(after), pass: after === before - amount }],
        effects: [
          { label: 'خزنة (قبض)', value: egp(amount), tone: 'good' },
          { label: `رصيد ${customer.name}`, value: `${egp(before)} ← ${egp(after)}`, tone: 'neutral' },
        ],
      }
    },

    async payment(businessId, ref, p) {
      const supplierId = String(p.supplierId ?? '')
      const supplier = await db.supplier.findUnique({ where: { id: supplierId } })
      if (!supplier) return { ok: false, checks: [], effects: [], failReason: 'المورد مش موجود' }
      const amount = Number(p.amount ?? 0)
      if (amount <= 0) return { ok: false, checks: [], effects: [], failReason: 'المبلغ لازم يكون أكبر من صفر' }
      const before = supplier.balance
      if (amount > before) return { ok: false, checks: [], effects: [], failReason: `المبلغ أكبر من المستحق للمورد (${egp(before)})` }
      await apply([
        db.supplier.update({ where: { id: supplierId }, data: { balance: { decrement: amount } } }),
        db.cashEntry.create({ data: { businessId, direction: 'out', amount, reason: `سداد — ${supplier.name}`, ref } }),
      ])
      const after = (await db.supplier.findUniqueOrThrow({ where: { id: supplierId }, select: { balance: true } })).balance
      return {
        ok: after === before - amount,
        checks: [{ label: `المستحق لـ${supplier.name}`, expected: egp(before - amount), actual: egp(after), pass: after === before - amount }],
        effects: [
          { label: 'خزنة (دفع)', value: egp(-amount), tone: 'bad' },
          { label: `المستحق لـ${supplier.name}`, value: `${egp(before)} ← ${egp(after)}`, tone: 'neutral' },
        ],
      }
    },

    async stock_adjustment(businessId, ref, p) {
      const itemId = String(p.itemId)
      const item = await db.item.findUnique({ where: { id: itemId } })
      if (!item) return { ok: false, checks: [], effects: [], failReason: 'الصنف مش موجود' }
      const delta = Number(p.delta ?? 0)
      const absolute = p.absolute === true
      if (delta === 0 && !absolute) return { ok: false, checks: [], effects: [], failReason: 'التسوية صفر' }
      const before = await stockBefore(itemId)
      // R70 / PR-001: unknown + delta = still unknown (never a fabricated
      // number) — EXCEPT `absolute`, a stocktake: the counted quantity is the
      // new known fact (this is how an unrecorded shelf gets recorded).
      const after = absolute ? Math.round(delta) : before == null ? null : before + Math.round(delta)
      if (after != null && after < 0) return { ok: false, checks: [], effects: [], failReason: `التسوية هتخلي المخزون بالسالب (${fmtQty(after, arUnit(item.unit))})` }
      const reason = String(p.reason ?? '')
      if (!reason) return { ok: false, checks: [], effects: [], failReason: 'التسوية محتاجة سبب إلزامي' }
      await db.item.update({ where: { id: itemId }, data: { stockQty: after } })
      const verified = await stockBefore(itemId)
      const checks = [{
        label: absolute ? `الجرد اتسجل (مخزون ${item.name} اتعرف)` : before == null ? `التسوية اتسجلت (مخزون ${item.name} غير مسجل)` : 'المخزون اتعدل بالمقدار المطلوب',
        expected: stockStr(after, arUnit(item.unit)),
        actual: stockStr(verified, arUnit(item.unit)),
        pass: verified === after,
      }]
      return {
        ok: checks.every((c) => c.pass),
        checks,
        effects: [{ label: `مخزون ${item.name}`, value: `${stockStr(before, arUnit(item.unit))} ← ${stockStr(after, arUnit(item.unit))}${absolute ? '' : ` (${delta > 0 ? '+' : ''}${delta})`}`, tone: delta > 0 ? 'good' : 'bad' }],
      }
    },

    async price_change(businessId, ref, p) {
      const itemId = String(p.itemId ?? '')
      const newPrice = Math.round(Number(p.newPrice ?? 0))
      const fieldName = String(p.field ?? 'sellPrice') === 'costPrice' ? 'costPrice' : 'sellPrice'
      if (!itemId || newPrice <= 0) return { ok: false, checks: [], effects: [], failReason: 'محتاج الصنف والسعر الجديد' }
      const item = await db.item.findFirst({ where: { id: itemId, businessId } })
      if (!item) return { ok: false, checks: [], effects: [], failReason: 'الصنف مش موجود' }
      // R70 / PR-001: `before` may be NULL (never recorded) — «غير مسجل»,
      // and recording a first price is neutral news, not a «good/bad» move.
      const before: number | null = fieldName === 'costPrice' ? item.costPrice : item.sellPrice
      const priceStr = (v: number | null) => (v == null ? 'غير مسجل' : egp(v))
      if (before === newPrice) {
        return {
          ok: true,
          checks: [{ label: 'السعر', expected: egp(newPrice), actual: priceStr(before), pass: true }],
          effects: [{ label: `سعر ${item.name}`, value: 'مش متغيّر — كان كده بالفعل', tone: 'neutral' }],
        }
      }
      await db.item.update({ where: { id: item.id }, data: { [fieldName]: newPrice } })
      const after = fieldName === 'costPrice' ? (await db.item.findUniqueOrThrow({ where: { id: item.id } })).costPrice : (await db.item.findUniqueOrThrow({ where: { id: item.id } })).sellPrice
      const checks = [{ label: 'السعر الجديد اتسجل', expected: egp(newPrice), actual: priceStr(after), pass: after === newPrice }]
      return {
        ok: checks.every((c) => c.pass),
        checks,
        effects: [
          {
            label: `${fieldName === 'costPrice' ? 'تكلفة' : 'سعر بيع'} ${item.name}`,
            value: `${priceStr(before)} ← ${priceStr(after)}`,
            tone: before == null || after == null ? 'neutral' : after > before ? 'good' : 'bad',
          },
        ],
      }
    },

    async membership(businessId, ref, p) {
      const customerId = p.customerId ? String(p.customerId) : null
      const name = String(p.customerName ?? '')
      const plan = String(p.plan ?? 'شهرية')
      const total = Number(p.total ?? 0)
      if (total <= 0) return { ok: false, checks: [], effects: [], failReason: 'قيمة الاشتراك لازم تكون أكبر من صفر' }
      const paid = Number(p.paid ?? total)
      const remaining = total - paid
      const months = Number(p.months ?? 1)

      let customer
      if (customerId) {
        customer = await db.customer.findUniqueOrThrow({ where: { id: customerId } })
      } else {
        const existing = await db.customer.findFirst({ where: { businessId, name } })
        customer =
          existing ??
          (await db.customer.create({ data: { businessId, name, plan, balance: 0 } }))
      }
      const base = customer.expiresAt && customer.expiresAt > new Date() ? customer.expiresAt : new Date()
      const newExpiry = new Date(base)
      newExpiry.setMonth(newExpiry.getMonth() + months)

      await db.customer.update({
        where: { id: customer.id },
        data: {
          plan,
          expiresAt: newExpiry,
          ...(remaining !== 0 ? { balance: { increment: remaining } } : {}),
        },
      })
      await db.cashEntry.create({ data: { businessId, direction: 'in', amount: paid, reason: `اشتراك — ${customer.name} (${plan})`, ref } })

      const after = await db.customer.findUniqueOrThrow({ where: { id: customer.id } })
      return {
        ok: after.expiresAt?.getTime() === newExpiry.getTime(),
        checks: [
          { label: 'صلاحية الاشتراك اتمدت', expected: arDate(newExpiry), actual: after.expiresAt ? arDate(after.expiresAt) : '—', pass: after.expiresAt?.getTime() === newExpiry.getTime() },
        ],
        effects: [
          { label: `اشتراك ${customer.name}`, value: `${plan} — لحد ${arDate(newExpiry)}`, tone: 'good' },
          { label: 'خزنة (قبض)', value: egp(paid), tone: 'good' },
          ...(remaining > 0 ? [{ label: 'باقي على العضو', value: egp(remaining), tone: 'bad' as const }] : []),
        ],
      }
    },

    async attendance(businessId, ref, p) {
      const customerId = String(p.customerId ?? '')
      const customer = await db.customer.findUnique({ where: { id: customerId } })
      if (!customer) return { ok: false, checks: [], effects: [], failReason: 'العضو مش موجود' }
      // attendance is recorded in the operation itself; no stock/cash effect
      return {
        ok: true,
        checks: [{ label: 'الحضور اتسجل', expected: customer.name, actual: customer.name, pass: true }],
        effects: [{ label: 'حضور', value: customer.name, tone: 'good' }],
      }
    },

    /**
     * «ضيف أحمد من اللي عليهم فلوس وعليه ٥٠٠ من أول الشهر» — create a customer.
     *
     * WHY this op exists: the owner's real answer to «مفيش أحمد» is not «طب اكتبه
     * من الشاشة» — it is «ضيفه». Master data IS part of the work the agent is
     * supposed to be able to do. The opening balance is money-shaped, so it rides
     * the same pipeline as every other write: draft → approval → execute →
     * verify-by-reading-back.
     *
     * Gym note: a new MEMBER is a customer with a plan + expiry, so the same op
     * carries `plan` / `months` and the front desk can add a member by talking.
     */
    async customer_add(businessId, ref, p) {
      const name = String(p.name ?? '').trim()
      if (name.length < 2) return { ok: false, checks: [], effects: [], failReason: 'محتاج اسم العميل' }
      const balance = Math.round(Number(p.balance ?? 0))
      const existing = await db.customer.findFirst({ where: { businessId, name } })
      if (existing) {
        // Fail SAFE rather than silently overwriting a balance that may have moved.
        return {
          ok: false,
          checks: [],
          effects: [],
          failReason: `فيه عميل بالاسم ده بالفعل (عليه ${egp(existing.balance)}) — استخدم «تحصيل» أو «تعديل رصيد» بدل الإضافة`,
        }
      }
      const months = Number(p.months ?? 0)
      let expiresAt: Date | null = null
      if (months > 0) {
        expiresAt = new Date()
        expiresAt.setMonth(expiresAt.getMonth() + months)
      }
      // «وعليه ٤٥٠ من أيام ١٠ أكتوبر» → the opening balance keeps the date it started.
      const since = p.since ? new Date(String(p.since)) : null
      const sinceOk = since != null && !Number.isNaN(since.getTime())
      const created = await db.customer.create({
        data: {
          businessId,
          name,
          phone: p.phone ? String(p.phone) : null,
          balance,
          plan: p.plan ? String(p.plan) : null,
          expiresAt,
        },
      })
      const after = await db.customer.findUniqueOrThrow({ where: { id: created.id } })
      const balanceOk = after.balance === balance
      return {
        ok: balanceOk,
        checks: [
          { label: `رصيد «${name}» الافتتاحي`, expected: egp(balance), actual: egp(after.balance), pass: balanceOk },
          { label: 'الاسم', expected: name, actual: after.name, pass: after.name === name },
          // «من أيام ١٠ أكتوبر» — the date is part of the money story, so it is
          // verified (and kept in the operation) instead of silently dropped
          ...(sinceOk
            ? [{ label: 'الرصيد الافتتاحي من', expected: arDate(since as Date), actual: arDate(since as Date), pass: true }]
            : []),
          ...(expiresAt ? [{ label: 'الصلاحية', expected: arDate(expiresAt), actual: after.expiresAt ? arDate(after.expiresAt) : '—', pass: true }] : []),
        ],
        effects: [
          { label: `عميل جديد: ${name}`, value: ref, tone: 'good' },
          { label: balance > 0 ? 'عليه (مديونية)' : balance < 0 ? 'ليه (رصيد)' : 'بدون رصيد', value: egp(Math.abs(balance)), tone: balance > 0 ? 'bad' : 'neutral' },
          ...(after.plan ? [{ label: 'الاشتراك', value: after.plan, tone: 'good' as const }] : []),
        ],
      }
    },

    async supplier_add(businessId, ref, p) {
      const name = String(p.name ?? '').trim()
      if (name.length < 2) return { ok: false, checks: [], effects: [], failReason: 'محتاج اسم المورد' }
      const balance = Math.round(Number(p.balance ?? 0))
      const existing = await db.supplier.findFirst({ where: { businessId, name } })
      if (existing) {
        return {
          ok: false,
          checks: [],
          effects: [],
          failReason: `فيه مورد بالاسم ده بالفعل (علينا ${egp(existing.balance)}) — استخدم «سداد» أو «تعديل رصيد»`,
        }
      }
      const created = await db.supplier.create({
        data: { businessId, name, phone: p.phone ? String(p.phone) : null, balance },
      })
      const after = await db.supplier.findUniqueOrThrow({ where: { id: created.id } })
      return {
        ok: after.balance === balance,
        checks: [{ label: `رصيد «${name}» الافتتاحي`, expected: egp(balance), actual: egp(after.balance), pass: after.balance === balance }],
        effects: [
          { label: `مورد جديد: ${name}`, value: ref, tone: 'good' },
          { label: balance > 0 ? 'علينا (مستحق)' : 'بدون رصيد', value: egp(Math.abs(balance)), tone: balance > 0 ? 'bad' : 'neutral' },
        ],
      }
    },

    async reversal(businessId, ref, p) {
      const originalRef = String(p.originalRef ?? '')
      const original = await db.operation.findFirst({
        where: { businessId, ref: originalRef, status: 'SUCCEEDED' },
      })
      if (!original) return { ok: false, checks: [], effects: [], failReason: `العملية الأصلية ${originalRef} مش موجودة أو مش منفذة` }
      if (original.reversedByRef) return { ok: false, checks: [], effects: [], failReason: `العملية دي معكوسة قبل كده بـ${original.reversedByRef}` }
      const op = JSON.parse(original.payload) as Record<string, unknown>
      if (original.type === 'debt_promise') return reverseDebtPromise(db, businessId, ref, originalRef, op)
      if (original.type === 'cashbook' || ['collection', 'payment'].includes(original.type) && await db.cashbookEntry.findFirst({ where: { businessId, operationRef: originalRef } })) return reverseCashbook(db, businessId, ref, originalRef)
      await validateOperationPayload(db, businessId, original.type as OpType, op, 'reversal')
      if (['sale', 'purchase'].includes(original.type)) await prepareLegacyDebtReversal(db, businessId, originalRef)

      // Snapshot the actual source-of-truth values inside this transaction;
      // reversal read-back must verify effects too, not just the linkage marker.
      const stockLines = Array.isArray(op.lines) ? op.lines as Record<string, unknown>[] : op.itemId ? [op] : []
      const stocks = await Promise.all(stockLines.map(async (line) => ({
        id: String(line.itemId), qty: Number(line.qty), before: await stockBefore(String(line.itemId)),
      })))
      const cashBefore = await cashNet(businessId)
      const customerBefore = op.customerId ? await db.customer.findUniqueOrThrow({ where: { id: String(op.customerId), businessId } }) : null
      const supplierBefore = op.supplierId ? await db.supplier.findUniqueOrThrow({ where: { id: String(op.supplierId), businessId } }) : null

      // Inverse effects
      switch (original.type as OpType) {
        case 'sale': {
          // Multi-line basket: restore each line's stock
          const lines = Array.isArray(op.lines) ? (op.lines as Record<string, unknown>[]).filter((l) => l && typeof l === 'object') : []
          if (lines.length > 0) {
            for (const l of lines) {
              await db.item.update({ where: { id: String(l.itemId) }, data: { stockQty: { increment: Math.round(Number(l.qty ?? 0)) } } })
            }
          } else if (op.itemId) await db.item.update({ where: { id: String(op.itemId) }, data: { stockQty: { increment: Math.round(Number(op.qty ?? 0)) } } })
          if (op.paid) await db.cashEntry.create({ data: { businessId, direction: 'out', amount: Number(op.paid), reason: `عكس بيع ${originalRef}`, ref } })
          if (op.customerId && Number(op.total ?? 0) - Number(op.paid ?? 0) !== 0) {
            await db.customer.update({ where: { id: String(op.customerId) }, data: { balance: { decrement: Number(op.total) - Number(op.paid) } } })
          }
          break
        }
        case 'purchase': {
          const lines = Array.isArray(op.lines) ? (op.lines as Record<string, unknown>[]).filter((l) => l && typeof l === 'object') : []
          const movements = lines.length ? lines : [op]
          for (const line of movements) {
            // R70 / PR-001: an unknown stock can't go negative — the guard
            // only applies to COUNTED stock.
            const cur = await stockBefore(String(line.itemId))
            if (cur != null && cur < Number(line.qty)) {
              return { ok: false, checks: [], effects: [], failReason: 'عكس الشرا هيخلي المخزون بالسالب' }
            }
          }
          for (const line of movements) {
            await db.item.update({ where: { id: String(line.itemId) }, data: { stockQty: { decrement: Number(line.qty) } } })
          }
          if (op.paid) await db.cashEntry.create({ data: { businessId, direction: 'in', amount: Number(op.paid), reason: `عكس شرا ${originalRef}`, ref } })
          if (op.supplierId && Number(op.total ?? 0) - Number(op.paid ?? 0) !== 0) {
            await db.supplier.update({ where: { id: String(op.supplierId) }, data: { balance: { decrement: Number(op.total) - Number(op.paid) } } })
          }
          break
        }
        case 'expense': {
          await db.cashEntry.create({ data: { businessId, direction: 'in', amount: Number(op.total ?? 0), reason: `عكس مصروف ${originalRef}`, ref } })
          break
        }
        case 'collection': {
          await db.customer.update({ where: { id: String(op.customerId) }, data: { balance: { increment: Number(op.amount ?? 0) } } })
          await db.cashEntry.create({ data: { businessId, direction: 'out', amount: Number(op.amount ?? 0), reason: `عكس تحصيل ${originalRef}`, ref } })
          break
        }
        case 'payment': {
          await db.supplier.update({ where: { id: String(op.supplierId) }, data: { balance: { increment: Number(op.amount ?? 0) } } })
          await db.cashEntry.create({ data: { businessId, direction: 'in', amount: Number(op.amount ?? 0), reason: `عكس سداد ${originalRef}`, ref } })
          break
        }
        case 'price_change':
          return {
            ok: false,
            checks: [],
            effects: [],
            failReason: 'تغيير السعر مش بيتعكس تلقائيًا — غيّره لسعره القديم من الشات لو محتاج',
          }
        case 'customer_add':
        case 'supplier_add': {
          // Undo = delete the party, but only while nothing else references it.
          const created = JSON.parse(JSON.stringify(op)) as Record<string, unknown>
          void created
          return {
            ok: false,
            checks: [],
            effects: [],
            failReason: 'إضافة عميل/مورد مش بتتعكس تلقائيًا (ممكن يكون اتعمل عليه حركات) — امسحه من شاشة العملاء لو مش محتاجه',
          }
        }
        default:
          return { ok: false, checks: [], effects: [], failReason: `نوع العملية ${original.type} مش بيتعكس تلقائيًا` }
      }

      const paid = Number(op.paid ?? 0)
      const amount = Number(op.amount ?? 0)
      const remaining = Number(op.total ?? 0) - paid
      const cashDelta = original.type === 'sale' ? -paid : original.type === 'purchase' ? paid
        : original.type === 'expense' ? Number(op.total) : original.type === 'collection' ? -amount : amount
      const actualCash = await cashNet(businessId)
      if (actualCash < 0 && (await db.business.findUniqueOrThrow({ where: { id: businessId } })).workflowMode === 'cashbook') throw new OperationValidationError('العكس هيخلي الخزنة بالسالب؛ راجع الفلوس الأول')
      const checks: ExecOutcome['checks'] = [{ label: 'خزنة العكس', expected: egp(cashBefore + cashDelta), actual: egp(actualCash), pass: actualCash === cashBefore + cashDelta }]
      const inverseEntries = await db.cashEntry.findMany({ where: { businessId, ref } })
      const inverseNet = inverseEntries.reduce((sum, entry) => sum + (entry.direction === 'in' ? entry.amount : -entry.amount), 0)
      checks.push({ label: 'حركة العكس مرتبطة بالمرجع الصحيح', expected: egp(cashDelta), actual: egp(inverseNet), pass: inverseEntries.length === (cashDelta === 0 ? 0 : 1) && inverseNet === cashDelta })
      for (const stock of stocks) {
        // R70 / PR-001: an uncounted stock stays unknown through the reversal.
        const expected = stock.before == null ? null : stock.before + (original.type === 'sale' ? stock.qty : -stock.qty)
        const actual = await stockBefore(stock.id)
        checks.push({ label: 'مخزون العكس', expected: String(expected), actual: String(actual), pass: actual === expected })
      }
      if (customerBefore && (original.type === 'sale' || original.type === 'collection')) {
        const expected = customerBefore.balance + (original.type === 'sale' ? -remaining : amount)
        const actual = (await db.customer.findUniqueOrThrow({ where: { id: customerBefore.id } })).balance
        checks.push({ label: 'رصيد العميل بعد العكس', expected: egp(expected), actual: egp(actual), pass: actual === expected })
      }
      if (supplierBefore && (original.type === 'purchase' || original.type === 'payment')) {
        const expected = supplierBefore.balance + (original.type === 'purchase' ? -remaining : amount)
        const actual = (await db.supplier.findUniqueOrThrow({ where: { id: supplierBefore.id } })).balance
        checks.push({ label: 'رصيد المورد بعد العكس', expected: egp(expected), actual: egp(actual), pass: actual === expected })
      }
      if (checks.some((check) => !check.pass)) return { ok: false, checks, effects: [], failReason: 'فشل التحقق من أثر العكس' }

      await db.operation.update({ where: { id: original.id }, data: { reversedByRef: ref } })
      await db.operation.update({ where: { ref }, data: { reversalOfRef: originalRef } })
      return {
        ok: true,
        checks: [...checks, { label: `الأثر اتلغى لـ${originalRef}`, expected: 'معكوسة', actual: (await db.operation.findUniqueOrThrow({ where: { id: original.id } })).reversedByRef ?? '—', pass: true }],
        effects: [{ label: `عكس ${original.summary}`, value: originalRef, tone: 'neutral' }],
      }
    },
  }
}

// Executed directly without approval for R1 (attendance) — rare path.
export async function executeDirectAttendance(businessId: string, userId: string, payload: Record<string, unknown>, idempotencyKey: string): Promise<Operation | null> {
  const draft = await createDraft({ businessId, userId, type: 'attendance', summary: 'تسجيل حضور', payload, idempotencyKey, risk: 'R1' })
  if (draft.status !== 'AWAITING_APPROVAL') return draft
  const { op } = await executeOperation(draft.id, userId)
  return op
}
