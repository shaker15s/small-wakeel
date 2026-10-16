// وكيل — deterministic domain executors.
// The LLM extracts intent; THESE functions are the only writers of business truth.
// Every write: idempotency key, state machine, verification read-back, audit event.

import type { Operation, Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import type { OpType } from '@/lib/types'
import { invalidateCatalog } from '@/lib/agent/catalog'
import { arUnit } from '@/lib/verticals'
import { egp, qty as fmtQty, arDate } from '@/lib/format'
import { computeRisk } from './risk'

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
async function nextRef(businessId: string): Promise<string> {
  const biz = await db.business.update({
    where: { id: businessId },
    data: { opSeq: { increment: 1 } },
    select: { opSeq: true },
  })
  return `WKL-${1000 + biz.opSeq}`
}

async function audit(businessId: string, actor: string, action: string, ref: string, detail: unknown) {
  await db.auditEvent.create({
    data: {
      businessId,
      actor,
      action,
      ref,
      detail: JSON.stringify(detail ?? {}),
    },
  })
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
}): Promise<Operation> {
  const existing = await db.operation.findUnique({ where: { idempotencyKey: params.idempotencyKey } })
  if (existing) return existing

  const risk = params.risk ?? computeRisk(params.type, (params.payload.total as number) ?? undefined)
  const ref = await nextRef(params.businessId)
  const op = await db.operation.create({
    data: {
      ref,
      businessId: params.businessId,
      type: params.type,
      status: 'AWAITING_APPROVAL',
      source: 'chat',
      userId: params.userId,
      risk,
      summary: params.summary,
      payload: JSON.stringify(params.payload),
      idempotencyKey: params.idempotencyKey,
      conversationId: params.conversationId ?? null,
    },
  })
  await audit(params.businessId, params.userId, 'operation.drafted', ref, { summary: params.summary, risk })
  return op
}

// ---------------------------------------------------------------------------
// The executor — approve a draft and apply effects deterministically
// ---------------------------------------------------------------------------
export async function executeOperation(opId: string, decidedBy: string): Promise<{ op: Operation; outcome: ExecOutcome }> {
  const op = await db.operation.findUnique({ where: { id: opId } })
  if (!op) throw new Error('العملية مش موجودة')

  // Atomic compare-and-set: the UPDATE only matches while the row is still
  // awaiting approval. Two approvals arriving together therefore cannot both
  // proceed — the loser gets count = 0 and is rejected. (A read-then-write
  // check would let the second caller execute the SAME operation twice:
  // double stock movement, double cash entry.)
  const claimed = await db.operation.updateMany({
    where: { id: opId, status: 'AWAITING_APPROVAL' },
    data: { status: 'EXECUTING', decidedAt: new Date() },
  })
  if (claimed.count === 0) {
    const current = await db.operation.findUnique({ where: { id: opId }, select: { status: true } })
    throw new Error(`العملية مش في حالة انتظار اعتماد (حالتها: ${current?.status ?? 'مش موجودة'})`)
  }

  const payload = JSON.parse(op.payload) as Record<string, unknown>
  let outcome: ExecOutcome

  try {
    outcome = await EXECUTORS[op.type as OpType](op.businessId, op.ref, payload)
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'فشل غير معروف'
    await db.operation.update({
      where: { id: opId },
      data: { status: 'FAILED_SAFE', failReason: reason, executedAt: new Date() },
    })
    await audit(op.businessId, decidedBy, 'operation.failed_safe', op.ref, { reason })
    return { op: await db.operation.findUniqueOrThrow({ where: { id: opId } }), outcome: { ok: false, checks: [], effects: [], failReason: reason } }
  }

  if (!outcome.ok) {
    await db.operation.update({
      where: { id: opId },
      data: { status: 'FAILED_SAFE', failReason: outcome.failReason ?? 'فشل التحقق', executedAt: new Date() },
    })
    await audit(op.businessId, decidedBy, 'operation.failed_safe', op.ref, { failReason: outcome.failReason })
  } else {
    await db.operation.update({
      where: { id: opId },
      data: { status: 'SUCCEEDED', result: JSON.stringify(outcome), executedAt: new Date() },
    })
    // The catalog just changed (stock/balances). Drop the 5-second cache so the
    // owner's very next message sees the post-sale numbers.
    invalidateCatalog(op.businessId)
    await audit(op.businessId, decidedBy, 'operation.succeeded', op.ref, { checks: outcome.checks.length })
  }
  return { op: await db.operation.findUniqueOrThrow({ where: { id: opId } }), outcome }
}

export async function rejectOperation(opId: string, decidedBy: string, reason?: string): Promise<Operation> {
  const op = await db.operation.findUniqueOrThrow({ where: { id: opId } })
  if (op.status !== 'AWAITING_APPROVAL') throw new Error('العملية مش في حالة انتظار اعتماد')
  const updated = await db.operation.update({
    where: { id: opId },
    data: { status: 'CANCELLED', reason: reason ?? 'رفضها المستخدم', decidedAt: new Date() },
  })
  await audit(op.businessId, decidedBy, 'operation.cancelled', op.ref, { reason: reason ?? 'رفض' })
  return updated
}

// ---------------------------------------------------------------------------
// Per-type executors: apply effects + verify against source of truth
// ---------------------------------------------------------------------------
type Executor = (businessId: string, ref: string, p: Record<string, unknown>) => Promise<ExecOutcome>

async function stockBefore(itemId: string): Promise<number> {
  const it = await db.item.findUniqueOrThrow({ where: { id: itemId }, select: { stockQty: true } })
  return it.stockQty
}
async function cashNet(businessId: string): Promise<number> {
  const agg = await db.cashEntry.aggregate({ where: { businessId }, _sum: { amount: true } })
  const entries = await db.cashEntry.findMany({ where: { businessId }, select: { direction: true, amount: true } })
  const inn = entries.filter((e) => e.direction === 'in').reduce((s, e) => s + e.amount, 0)
  const out = entries.filter((e) => e.direction === 'out').reduce((s, e) => s + e.amount, 0)
  void agg
  const biz = await db.business.findUniqueOrThrow({ where: { id: businessId }, select: { openingCash: true } })
  return biz.openingCash + inn - out
}

const EXECUTORS: Record<OpType, Executor> = {
  async sale(businessId, ref, p) {
    // Multi-line basket (chat drafts with 2+ items — one approval, one receipt)
    const rawLines = Array.isArray(p.lines) ? (p.lines as Record<string, unknown>[]).filter((l) => l && typeof l === 'object') : []
    if (rawLines.length > 0) {
      type Res = { itemId: string; name: string; qty: number; unit: string; unitPrice: number; total: number; before: number }
      const resolved: Res[] = []
      for (const l of rawLines) {
        const item = await db.item.findUnique({ where: { id: String(l.itemId) } })
        if (!item) return { ok: false, checks: [], effects: [], failReason: 'الصنف مش موجود' }
        const qty = Number(l.qty ?? 0)
        if (!(qty > 0)) return { ok: false, checks: [], effects: [], failReason: `كمية ${item.name} لازم تكون أكبر من صفر` }
        // Money from the LIVE item price — the payload is never trusted with money
        const unitPrice = item.sellPrice
        resolved.push({ itemId: item.id, name: item.name, qty, unit: item.unit, unitPrice, total: Math.round(qty * unitPrice), before: await stockBefore(item.id) })
      }
      for (const r of resolved) {
        if (r.qty > r.before) {
          return { ok: false, checks: [], effects: [], failReason: `الكمية المطلوبة من ${r.name} (${fmtQty(r.qty, arUnit(r.unit))}) أكبر من المتاح (${fmtQty(r.before, arUnit(r.unit))})` }
        }
      }
      const total = resolved.reduce((s, r) => s + r.total, 0)
      if (total <= 0) return { ok: false, checks: [], effects: [], failReason: 'الإجمالي لازم يكون أكبر من صفر' }
      const paid = Math.min(Number(p.paid ?? total), total)
      const remaining = total - paid
      const customerId = p.customerId ? String(p.customerId) : null

      await db.$transaction([
        ...resolved.map((r) => db.item.update({ where: { id: r.itemId }, data: { stockQty: { decrement: Math.round(r.qty) } } })),
        db.cashEntry.create({ data: { businessId, direction: 'in', amount: paid, reason: `بيع — ${resolved.map((r) => r.name).join(' + ')}`, ref } }),
        ...(customerId && remaining !== 0 ? [db.customer.update({ where: { id: customerId }, data: { balance: { increment: remaining } } })] : []),
      ])

      // Verification read-back — per line
      const checks: { label: string; expected: string; actual: string; pass: boolean }[] = []
      const effects: { label: string; value: string; tone: 'good' | 'bad' | 'neutral' }[] = []
      let allOk = true
      for (const r of resolved) {
        const after = await stockBefore(r.itemId)
        const pass = after === r.before - Math.round(r.qty)
        allOk = allOk && pass
        checks.push({ label: `مخزون ${r.name} نقص بالمقدار الصح`, expected: fmtQty(r.before - r.qty, arUnit(r.unit)), actual: fmtQty(after, arUnit(r.unit)), pass })
        effects.push({ label: `مخزون ${r.name}`, value: `${fmtQty(r.before, arUnit(r.unit))} ← ${fmtQty(after, arUnit(r.unit))}`, tone: 'neutral' })
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
    if (qtyN > before) {
      return { ok: false, checks: [], effects: [], failReason: `الكمية المطلوبة (${fmtQty(qtyN, arUnit(item.unit))}) أكبر من المتاح (${fmtQty(before, arUnit(item.unit))})` }
    }
    const paid = Number(p.paid ?? total)
    const remaining = total - paid
    const customerId = p.customerId ? String(p.customerId) : null

    const txOps: Prisma.PrismaPromise<unknown>[] = [
      db.item.update({ where: { id: itemId }, data: { stockQty: { decrement: Math.round(qtyN) } } }),
      db.cashEntry.create({ data: { businessId, direction: 'in', amount: paid, reason: `بيع — ${item.name}`, ref } }),
    ]
    if (customerId && remaining !== 0) {
      txOps.push(db.customer.update({ where: { id: customerId }, data: { balance: { increment: remaining } } }))
    }
    await db.$transaction(txOps)

    // Verification read-back
    const after = await stockBefore(itemId)
    const checks = [
      { label: 'المخزون نقص بالمقدار الصح', expected: fmtQty(before - qtyN, arUnit(item.unit)), actual: fmtQty(after, arUnit(item.unit)), pass: after === before - Math.round(qtyN) },
    ]
    return {
      ok: checks.every((c) => c.pass),
      checks,
      effects: [
        { label: `مخزون ${item.name}`, value: `${fmtQty(before, arUnit(item.unit))} ← ${fmtQty(after, arUnit(item.unit))}`, tone: 'neutral' },
        { label: 'خزنة (قبض)', value: egp(paid), tone: 'good' },
        ...(remaining > 0 && customerId ? [{ label: `رصيد العميل (آجل)`, value: egp(remaining), tone: 'bad' as const }] : []),
      ],
    }
  },

  async purchase(businessId, ref, p) {
    // Multi-line basket (chat drafts with 2+ items)
    const rawLines = Array.isArray(p.lines) ? (p.lines as Record<string, unknown>[]).filter((l) => l && typeof l === 'object') : []
    if (rawLines.length > 0) {
      type Res = { itemId: string; name: string; qty: number; unit: string; unitPrice: number; total: number; before: number }
      const resolved: Res[] = []
      for (const l of rawLines) {
        const item = await db.item.findUnique({ where: { id: String(l.itemId) } })
        if (!item) return { ok: false, checks: [], effects: [], failReason: 'الصنف مش موجود' }
        const qty = Number(l.qty ?? 0)
        if (!(qty > 0)) return { ok: false, checks: [], effects: [], failReason: `كمية ${item.name} لازم تكون أكبر من صفر` }
        const unitPrice = item.costPrice
        resolved.push({ itemId: item.id, name: item.name, qty, unit: item.unit, unitPrice, total: Math.round(qty * unitPrice), before: await stockBefore(item.id) })
      }
      const total = resolved.reduce((s, r) => s + r.total, 0)
      if (total <= 0) return { ok: false, checks: [], effects: [], failReason: 'الإجمالي لازم يكون أكبر من صفر' }
      const paid = Math.min(Number(p.paid ?? total), total)
      const remaining = total - paid
      const supplierId = p.supplierId ? String(p.supplierId) : null

      // ONE transaction: stock movements, the cash entry and the supplier
      // balance either all land or none do (no half-executed purchase).
      await db.$transaction([
        ...resolved.map((r) => db.item.update({ where: { id: r.itemId }, data: { stockQty: { increment: Math.round(r.qty) } } })),
        db.cashEntry.create({ data: { businessId, direction: 'out', amount: paid, reason: `شرا — ${resolved.map((r) => r.name).join(' + ')}`, ref } }),
        ...(supplierId && remaining !== 0 ? [db.supplier.update({ where: { id: supplierId }, data: { balance: { increment: remaining } } })] : []),
      ])

      const checks: { label: string; expected: string; actual: string; pass: boolean }[] = []
      const effects: { label: string; value: string; tone: 'good' | 'bad' | 'neutral' }[] = []
      let allOk = true
      for (const r of resolved) {
        const after = await stockBefore(r.itemId)
        const pass = after === r.before + Math.round(r.qty)
        allOk = allOk && pass
        checks.push({ label: `مخزون ${r.name} زاد بالمقدار الصح`, expected: fmtQty(r.before + r.qty, arUnit(r.unit)), actual: fmtQty(after, arUnit(r.unit)), pass })
        effects.push({ label: `مخزون ${r.name}`, value: `${fmtQty(r.before, arUnit(r.unit))} ← ${fmtQty(after, arUnit(r.unit))}`, tone: 'neutral' })
      }
      effects.push(
        { label: 'خزنة (دفع)', value: egp(-paid), tone: 'bad' },
        ...(remaining > 0 && supplierId ? [{ label: 'المستحق للمورد', value: egp(remaining), tone: 'bad' as const }] : []),
      )
      return { ok: allOk, checks, effects }
    }

    const itemId = String(p.itemId)
    const item = await db.item.findUnique({ where: { id: itemId } })
    if (!item) return { ok: false, checks: [], effects: [], failReason: 'الصنف مش موجود' }
    const qtyN = Number(p.qty ?? 0)
    const total = Number(p.total ?? 0)
    if (total <= 0) return { ok: false, checks: [], effects: [], failReason: 'الإجمالي لازم يكون أكبر من صفر' }
    const paid = Number(p.paid ?? total)
    const remaining = total - paid
    const supplierId = p.supplierId ? String(p.supplierId) : null
    const before = await stockBefore(itemId)

    const txOps: Prisma.PrismaPromise<unknown>[] = [
      db.item.update({ where: { id: itemId }, data: { stockQty: { increment: Math.round(qtyN) } } }),
      db.cashEntry.create({ data: { businessId, direction: 'out', amount: paid, reason: `شرا — ${item.name}`, ref } }),
    ]
    if (supplierId && remaining !== 0) {
      txOps.push(db.supplier.update({ where: { id: supplierId }, data: { balance: { increment: remaining } } }))
    }
    await db.$transaction(txOps)

    const after = await stockBefore(itemId)
    const checks = [
      { label: 'المخزون زاد بالمقدار الصح', expected: fmtQty(before + qtyN, arUnit(item.unit)), actual: fmtQty(after, arUnit(item.unit)), pass: after === before + Math.round(qtyN) },
    ]
    return {
      ok: checks.every((c) => c.pass),
      checks,
      effects: [
        { label: `مخزون ${item.name}`, value: `${fmtQty(before, arUnit(item.unit))} ← ${fmtQty(after, arUnit(item.unit))}`, tone: 'neutral' },
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
    await db.$transaction([
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
    await db.$transaction([
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
    if (delta === 0) return { ok: false, checks: [], effects: [], failReason: 'التسوية صفر' }
    const before = await stockBefore(itemId)
    const after = before + Math.round(delta)
    if (after < 0) return { ok: false, checks: [], effects: [], failReason: `التسوية هتخلي المخزون بالسالب (${fmtQty(after, arUnit(item.unit))})` }
    const reason = String(p.reason ?? '')
    if (!reason) return { ok: false, checks: [], effects: [], failReason: 'التسوية محتاجة سبب إلزامي' }
    await db.item.update({ where: { id: itemId }, data: { stockQty: after } })
    const checks = [{ label: 'المخزون اتعدل بالمقدار المطلوب', expected: fmtQty(after, arUnit(item.unit)), actual: fmtQty(await stockBefore(itemId), arUnit(item.unit)), pass: true }]
    return {
      ok: checks.every((c) => c.pass),
      checks,
      effects: [{ label: `مخزون ${item.name}`, value: `${fmtQty(before, arUnit(item.unit))} ← ${fmtQty(after, arUnit(item.unit))}`, tone: delta > 0 ? 'good' : 'bad' }],
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

  async reversal(businessId, ref, p) {
    const originalRef = String(p.originalRef ?? '')
    const original = await db.operation.findFirst({
      where: { businessId, ref: originalRef, status: 'SUCCEEDED' },
    })
    if (!original) return { ok: false, checks: [], effects: [], failReason: `العملية الأصلية ${originalRef} مش موجودة أو مش منفذة` }
    if (original.reversedByRef) return { ok: false, checks: [], effects: [], failReason: `العملية دي معكوسة قبل كده بـ${original.reversedByRef}` }
    const op = JSON.parse(original.payload) as Record<string, unknown>

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
        if (lines.length > 0) {
          for (const l of lines) {
            await db.item.update({ where: { id: String(l.itemId) }, data: { stockQty: { decrement: Math.round(Number(l.qty ?? 0)) } } })
          }
        } else if (op.itemId) await db.item.update({ where: { id: String(op.itemId) }, data: { stockQty: { decrement: Math.round(Number(op.qty ?? 0)) } } })
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
      default:
        return { ok: false, checks: [], effects: [], failReason: `نوع العملية ${original.type} مش بيتعكس تلقائيًا` }
    }

    await db.operation.update({ where: { id: original.id }, data: { reversedByRef: ref } })
    await db.operation.update({ where: { ref }, data: { reversalOfRef: originalRef } })
    return {
      ok: true,
      checks: [{ label: `الأثر اتلغى لـ${originalRef}`, expected: 'معكوسة', actual: (await db.operation.findUniqueOrThrow({ where: { id: original.id } })).reversedByRef ?? '—', pass: true }],
      effects: [{ label: `عكس ${original.summary}`, value: originalRef, tone: 'neutral' }],
    }
  },
}

// Executed directly without approval for R1 (attendance) — rare path.
export async function executeDirectAttendance(businessId: string, userId: string, payload: Record<string, unknown>, idempotencyKey: string): Promise<Operation | null> {
  const draft = await createDraft({ businessId, userId, type: 'attendance', summary: 'تسجيل حضور', payload, idempotencyKey, risk: 'R1' })
  if (draft.status !== 'AWAITING_APPROVAL') return draft
  const { op } = await executeOperation(draft.id, userId)
  return op
}
