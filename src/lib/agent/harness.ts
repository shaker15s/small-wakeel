// وكيل — THE AGENT HARNESS (multi-pass, deterministic, stream-first).
//
// Pass 1 (Understand): LLM extracts intent+fields as JSON (with a rule-based
//   Arabic fallback if the model is unreachable — the harness never dies).
// Pass 2 (Resolve): server resolves entities/units/prices from the REAL
//   database. The model is never trusted with money.
// Pass 3 (Act): read tools run directly (R0); writes become drafts awaiting
//   approval (R2/R3) with a full action card.
// Pass 4 (Explain): the reply streams letter-by-letter, grounded in what the
//   server actually did.

import type { Business, User, Item, Customer, Supplier, Message } from '@prisma/client'
import { db } from '@/lib/db'
import type { ActionCardDTO, ResultCardDTO, ThinkingStep, OpType, Risk } from '@/lib/types'
import { egp, qty as fmtQty } from '@/lib/format'
import { arUnit, getVertical } from '@/lib/verticals'
import { convertToBaseUnit, matchEntity, normalizeAr, parseQuantity, unitToCode } from './arabic'
import { createDraft } from '@/lib/domain/executors'
import { canDraft, computeRisk, RISK_META } from '@/lib/domain/risk'
import { completeChat, modelLabelFor, resolveModel, streamChat, type LLMMessage } from './llm'
import { buildReplyPrompt, buildSystemPrompt } from './prompt'
import { runReadTool, TYPE_AR, type ReadTool } from './tools'

export interface TurnEmit {
  (ev: { event: 'thinking'; steps: ThinkingStep[] } | { event: 'step'; label: string; state: 'active' | 'done' } | { event: 'card'; card: ActionCardDTO } | { event: 'cards'; cards: ResultCardDTO[] } | { event: 'delta'; text: string }): void
}

interface TurnContext {
  business: Business
  user: User
  conversationId: string
  text: string
  modelKey: string | null
  history: { role: string; text: string }[]
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Rule-based intent fallback (keeps the agent alive even with zero LLM)
// ---------------------------------------------------------------------------
interface ExtractedIntent {
  intent: 'read' | 'write' | 'chat'
  tool?: string
  opType?: OpType
  fields: Record<string, unknown>
  question?: string
  replyHint?: string
}

function ruleBasedIntent(text: string, businessType: string): ExtractedIntent {
  const s = normalizeAr(text)
  const isGym = businessType === 'gym'

  if (/(السلام|اهلا|هلا|صباح|مساء|ازيك|عامل ايه|شكرا)/.test(s) && s.length < 25) {
    return { intent: 'chat', fields: {}, replyHint: 'تحية' }
  }
  if (/(وضع|رصيد|حاله) الخزنه|الخزنه|كاش/.test(s)) return { intent: 'read', tool: 'get_cash_position', fields: {} }
  if (/(مخزون|ناقص|استوك)/.test(s) && !/(بعت|بيع|شرا|اشتري)/.test(s)) return { intent: 'read', tool: 'list_low_stock', fields: {} }
  if (/(صلاحيه|منتهيه|قربت)/.test(s)) return { intent: 'read', tool: 'list_expiring', fields: {} }
  if (/(مديون|اللي ليا|تحصيلات|عليهم|العملاء|الاجل)/.test(s)) return { intent: 'read', tool: 'list_receivables', fields: {} }
  if (/(اللي علينا|للمورد|الموردين|مستحق)/.test(s)) return { intent: 'read', tool: 'list_payables', fields: {} }
  if (/(ملخص|كويس اليوم|حال اليوم|عملت ايه النهارده)/.test(s)) return { intent: 'read', tool: 'get_daily_summary', fields: {} }
  if (/حضور/.test(s)) return { intent: 'write', opType: 'attendance', fields: {} }
  if (/(اشتراك|تجديد|جديد لـ)/.test(s) && isGym) return { intent: 'write', opType: 'membership', fields: {} }
  if (/(مصروف|دفعت|صرفت)/.test(s)) return { intent: 'write', opType: 'expense', fields: { label: 'مصروف' } }
  if (/(تحصيل|خلص|سدد|دفع)/.test(s) && /(من|لـ)/.test(s)) {
    return { intent: 'write', opType: isGym ? 'collection' : 'collection', fields: {} }
  }
  if (/(بعت|بيع|خرج|سلفت)/.test(s)) return { intent: 'write', opType: 'sale', fields: {} }
  if (/(اشتريت|شرا|جبت|دخلت)/.test(s)) return { intent: 'write', opType: 'purchase', fields: {} }
  return { intent: 'chat', fields: {} }
}

function parseIntentJson(raw: string): ExtractedIntent | null {
  const cleaned = raw.replace(/```json|```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const json = JSON.parse(cleaned.slice(start, end + 1)) as Partial<ExtractedIntent>
    if (!json.intent) return null
    return {
      intent: json.intent === 'read' || json.intent === 'write' || json.intent === 'chat' ? json.intent : 'chat',
      tool: json.tool,
      opType: json.opType as OpType | undefined,
      fields: (json.fields as Record<string, unknown>) ?? {},
      question: json.question,
      replyHint: json.replyHint,
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Field resolution — all money from the REAL database
// ---------------------------------------------------------------------------
interface ResolvedWrite {
  ok: boolean
  opType: OpType
  payload: Record<string, unknown>
  summary: string
  card: ActionCardDTO
  missing?: string
  failMessage?: string
}

function fieldsToCard(ref: string, type: OpType, risk: Risk, summary: string, fields: { label: string; value: string; hint?: string }[], effects: { label: string; value: string; tone?: 'good' | 'bad' | 'neutral' }[], dangerNote?: string): ActionCardDTO {
  return {
    kind: 'draft',
    ref,
    type,
    risk,
    title: TYPE_AR[type] ?? type,
    summary,
    fields,
    effects,
    status: 'AWAITING_APPROVAL',
    dangerNote,
  }
}

async function resolveWrite(ctx: TurnContext, intent: ExtractedIntent, emit: TurnEmit): Promise<ResolvedWrite> {
  const { business, user } = ctx
  const type = (intent.opType ?? 'sale') as OpType
  const f = intent.fields ?? {}
  const items: Item[] = await db.item.findMany({ where: { businessId: business.id } })
  const customers: Customer[] = await db.customer.findMany({ where: { businessId: business.id } })
  const suppliers: Supplier[] = await db.supplier.findMany({ where: { businessId: business.id } })

  const text = ctx.text
  const norm = normalizeAr(text)

  switch (type) {
    case 'sale':
    case 'purchase': {
      // Item
      const rawItemName = String(f.itemName ?? '')
      const itemMatch = rawItemName ? matchEntity(rawItemName, items) : null
      const item = itemMatch?.entity ?? matchEntity(text, items)?.entity ?? null
      if (!item) {
        return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'الصنف', failMessage: `مش لاقي الصنف — ممكن تكتبه بالاسم اللي في الكتالوج؟` }
      }
      // Quantity + unit
      let { qty, unit } = parseQuantity(`${f.qty ?? ''} ${f.unit ?? ''}`.trim() || text, null)
      if (qty == null) {
        const q = parseQuantity(text, null)
        qty = q.qty
        unit = unit ?? q.unit
      }
      if (qty == null || qty <= 0) return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'الكمية', failMessage: 'الكمية قد إيه بالظبط؟' }
      // Arabic unit words from the LLM (e.g. «جرام») → canonical codes
      const rawUnit = unitToCode(unit) ?? unitToCode(f.unit as string) ?? (unit ?? null)
      if (!rawUnit) return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'الوحدة', failMessage: 'الوحدة إيه؟ (جرام / كيلو / مللي / علبة...)' }
      const baseQty = convertToBaseUnit(qty, rawUnit, item.unit)
      if (baseQty == null) return { ok: false, opType: type, payload: {}, summary: '', card: null as never, failMessage: `الوحدة «${rawUnit}» مش متوافقة مع وحدة ${item.name} (${arUnit(item.unit)})` }
      const qtyN = Math.round(baseQty * 1000) / 1000
      if (type === 'sale' && qtyN > item.stockQty) {
        return { ok: false, opType: type, payload: {}, summary: '', card: null as never, failMessage: `المتاح من ${item.name} ${fmtQty(item.stockQty, arUnit(item.unit))} بس — انت طلبت ${fmtQty(qtyN, arUnit(item.unit))}` }
      }
      // Total from REAL price
      const unitPrice = type === 'sale' ? item.sellPrice : item.costPrice
      const total = Math.round(qtyN * unitPrice)
      // Paid
      let paid = total
      const paidWord = norm.match(/(?:دفعت|خلاص|ادفع)\s*(?:الي\s*)?([٠-٩0-9.,]+|\S+)?/)
      if (typeof f.paid === 'number' && f.paid > 0) paid = Math.round(f.paid * 100)
      else if (paidWord?.[1]) {
        const n = parseQuantity(paidWord[1], null).qty
        if (n != null && n > 0) paid = Math.round(n * 100)
      }
      paid = Math.min(paid, total)
      // Party
      const customerName = String(f.customerName ?? '')
      const customer = customerName ? matchEntity(customerName, customers)?.entity : null
      const supplierName = String(f.supplierName ?? '')
      const supplier = supplierName ? matchEntity(supplierName, suppliers)?.entity : null

      const payload: Record<string, unknown> = {
        itemId: item.id,
        itemName: item.name,
        qty: qtyN,
        unit: item.unit,
        unitPrice,
        total,
        paid,
        ...(type === 'sale' && customer ? { customerId: customer.id, customerName: customer.name } : {}),
        ...(type === 'purchase' && supplier ? { supplierId: supplier.id, supplierName: supplier.name } : {}),
      }
      const ref = `WKL-DRAFT` // replaced by real ref from createDraft
      const risk = computeRisk(type, total)
      const summary = `${type === 'sale' ? 'بيع' : 'شرا'} ${fmtQty(qtyN, arUnit(item.unit))} ${item.name} بـ${egp(total)}${type === 'sale' && customer ? ` — ${customer.name}` : ''}${type === 'purchase' && supplier ? ` — من ${supplier.name}` : ''}`
      const card = fieldsToCard(ref, type, risk, summary, [
        { label: 'الصنف', value: item.name },
        { label: 'الكمية', value: fmtQty(qtyN, arUnit(item.unit)) },
        { label: `سعر ${type === 'sale' ? 'البيع' : 'الشرا'} (للوحدة)`, value: egp(unitPrice) },
        { label: 'الإجمالي', value: egp(total) },
        { label: 'مدفوع', value: egp(paid) },
        ...(total - paid > 0 ? [{ label: 'باقي (آجل)', value: egp(total - paid) }] : []),
        ...(type === 'sale' && customer ? [{ label: 'العميل', value: customer.name }] : []),
        ...(type === 'purchase' && supplier ? [{ label: 'المورد', value: supplier.name }] : []),
      ], [
        { label: `مخزون ${item.name}`, value: `${fmtQty(item.stockQty, arUnit(item.unit))} ← ${fmtQty(item.stockQty + (type === 'sale' ? -qtyN : qtyN), arUnit(item.unit))}`, tone: 'neutral' },
        { label: 'الخزنة', value: egp(type === 'sale' ? paid : -paid), tone: type === 'sale' ? 'good' : 'bad' },
      ], RISK_META[risk].hint)
      return { ok: true, opType: type, payload, summary, card }
    }

    case 'expense': {
      const amountRaw = f.amount as number | undefined
      let amount = amountRaw && amountRaw > 0 ? Math.round(amountRaw * 100) : null
      if (amount == null) {
        const m = norm.match(/([٠-٩0-9]+(?:[.,][٠-٩0-9]+)?)/)
        if (m) {
          const western = m[1].replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(',', '.')
          const parsed = parseFloat(western)
          if (!Number.isNaN(parsed)) amount = Math.round(parsed * 100)
        }
      }
      if (amount == null || amount <= 0) return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'المبلغ', failMessage: 'المبلغ قد إيه؟' }
      const label = String(f.label ?? '') || (norm.includes('كهربا') ? 'كهربا' : norm.includes('ايجار') ? 'إيجار' : norm.includes('تليفون') ? 'تليفون' : 'مصروف')
      const payload = { label, total: amount }
      const risk = computeRisk(type, amount)
      const summary = `مصروف ${label} بـ${egp(amount)}`
      const card = fieldsToCard('', type, risk, summary, [
        { label: 'البند', value: label },
        { label: 'المبلغ', value: egp(amount) },
      ], [{ label: 'الخزنة', value: egp(-amount), tone: 'bad' }], RISK_META[risk].hint)
      return { ok: true, opType: type, payload, summary, card }
    }

    case 'collection': {
      const customersAll = customers.length > 0 ? customers : []
      const customerName = String(f.customerName ?? '')
      const customer = matchEntity(customerName || text, customersAll)?.entity ?? null
      if (!customer) return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'العميل', failMessage: 'تحصيل من مين بالظبط؟' }
      let amount = (f.amount as number | undefined) && (f.amount as number) > 0 ? Math.round((f.amount as number) * 100) : null
      if (amount == null) {
        const m = norm.match(/([٠-٩0-9]+(?:[.,][٠-٩0-9]+)?)/)
        if (m) {
          const western = m[1].replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
          amount = Math.round(parseFloat(western.replace(',', '.')) * 100)
        }
      }
      if (amount == null || amount <= 0) return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'المبلغ', failMessage: `هتحصّل قد إيه من ${customer.name}؟` }
      if (amount > customer.balance) {
        return { ok: false, opType: type, payload: {}, summary: '', card: null as never, failMessage: `${customer.name} عليه ${egp(customer.balance)} بس — مش ممكن تحصّل ${egp(amount)}` }
      }
      const payload = { customerId: customer.id, customerName: customer.name, amount }
      const risk = computeRisk(type, amount)
      const summary = `تحصيل ${egp(amount)} من ${customer.name}`
      const card = fieldsToCard('', type, risk, summary, [
        { label: 'العميل', value: customer.name },
        { label: 'المبلغ', value: egp(amount) },
        { label: 'المديونية الحالية', value: egp(customer.balance) },
        { label: 'بعد التحصيل', value: egp(customer.balance - amount) },
      ], [{ label: 'الخزنة', value: egp(amount), tone: 'good' }], RISK_META[risk].hint)
      return { ok: true, opType: type, payload, summary, card }
    }

    case 'payment': {
      const supplierName = String(f.supplierName ?? '')
      const supplier = matchEntity(supplierName || text, suppliers)?.entity ?? null
      if (!supplier) return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'المورد', failMessage: 'هسدد لمين؟' }
      let amount = (f.amount as number | undefined) && (f.amount as number) > 0 ? Math.round((f.amount as number) * 100) : null
      if (amount == null) {
        const m = norm.match(/([٠-٩0-9]+(?:[.,][٠-٩0-9]+)?)/)
        if (m) {
          const western = m[1].replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
          amount = Math.round(parseFloat(western.replace(',', '.')) * 100)
        }
      }
      if (amount == null || amount <= 0) return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'المبلغ', failMessage: `هسدد قد إيه لـ${supplier.name}؟` }
      if (amount > supplier.balance) {
        return { ok: false, opType: type, payload: {}, summary: '', card: null as never, failMessage: `المستحق لـ${supplier.name} ${egp(supplier.balance)} بس` }
      }
      const payload = { supplierId: supplier.id, supplierName: supplier.name, amount }
      const risk = computeRisk(type, amount)
      const summary = `سداد ${egp(amount)} لـ${supplier.name}`
      const card = fieldsToCard('', type, risk, summary, [
        { label: 'المورد', value: supplier.name },
        { label: 'المبلغ', value: egp(amount) },
        { label: 'المستفق الحالي', value: egp(supplier.balance) },
        { label: 'بعد السداد', value: egp(supplier.balance - amount) },
      ], [{ label: 'الخزنة', value: egp(-amount), tone: 'bad' }], RISK_META[risk].hint)
      return { ok: true, opType: type, payload, summary, card }
    }

    case 'membership': {
      const isRenewal = norm.includes('تجديد') || norm.includes('جدد')
      const customerName = String(f.customerName ?? '')
      const customer = matchEntity(customerName || text, customers)?.entity ?? null
      if (!customer && isRenewal) return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'العضو', failMessage: 'تجديد لمين؟' }
      const plan = String(f.plan ?? 'شهرية')
      const months = Math.max(1, Math.min(12, Math.round(Number(f.months ?? 1))))
      // plan price from items (gym plans are items) or fallback 35000
      const planItem = items.find((i) => normalizeAr(i.name).includes(normalizeAr(plan)))
      const total = Math.round((planItem?.sellPrice ?? 35000) * months)
      let paid = total
      if (typeof f.paid === 'number' && f.paid > 0) paid = Math.round(f.paid * 100)
      paid = Math.min(paid, total)
      const name = customer?.name ?? String(f.customerName ?? 'عضو جديد')
      const payload = {
        ...(customer ? { customerId: customer.id } : { customerName: name }),
        plan,
        months,
        total,
        paid,
      }
      const risk = computeRisk(type, total)
      const summary = `${isRenewal ? 'تجديد' : 'اشتراك جديد'} ${plan} لـ${name} — ${egp(total)}`
      const card = fieldsToCard('', type, risk, summary, [
        { label: 'العضو', value: name },
        { label: 'الخطة', value: plan },
        { label: 'المدة', value: `${months} شهر` },
        { label: 'الإجمالي', value: egp(total) },
        { label: 'مدفوع', value: egp(paid) },
      ], [
        { label: 'الخزنة', value: egp(paid), tone: 'good' },
        ...(total - paid > 0 ? [{ label: 'باقي على العضو', value: egp(total - paid), tone: 'bad' as const }] : []),
      ], RISK_META[risk].hint)
      return { ok: true, opType: type, payload, summary, card }
    }

    case 'attendance': {
      const customerName = String(f.customerName ?? '')
      const customer = matchEntity(customerName || text, customers)?.entity ?? null
      if (!customer) return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'العضو', failMessage: 'حضور مين؟' }
      const payload = { customerId: customer.id, customerName: customer.name }
      const risk = computeRisk(type)
      const summary = `حضور ${customer.name}`
      const card = fieldsToCard('', type, risk, summary, [
        { label: 'العضو', value: customer.name },
        { label: 'اليوم', value: 'النهاردة' },
        ...(customer.expiresAt ? [{ label: 'الاشتراك لحد', value: customer.expiresAt.toISOString().slice(0, 10) }] : []),
      ], [], RISK_META[risk].hint)
      return { ok: true, opType: type, payload, summary, card }
    }

    case 'stock_adjustment': {
      const rawItemName = String(f.itemName ?? '')
      const item = matchEntity(rawItemName || text, items)?.entity ?? null
      if (!item) return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'الصنف', failMessage: 'تسوية مخزون لأنهي صنف؟' }
      let delta = (f.delta as number | undefined) ?? null
      if (delta == null && typeof f.qty === 'number') delta = f.qty - item.stockQty
      if (delta == null) return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'الكمية الجديدة/الفرق', failMessage: `المخزون الحالي ${fmtQty(item.stockQty, arUnit(item.unit))} — عايزه يبقى قد إيه؟` }
      const reason = String(f.reason ?? '') || 'تسوية جرد'
      const payload = { itemId: item.id, itemName: item.name, delta, reason, unit: item.unit }
      const risk = computeRisk(type)
      const summary = `تسوية مخزون ${item.name}: ${fmtQty(item.stockQty, arUnit(item.unit))} ← ${fmtQty(item.stockQty + delta, arUnit(item.unit))}`
      const card = fieldsToCard('', type, risk, summary, [
        { label: 'الصنف', value: item.name },
        { label: 'الحالي', value: fmtQty(item.stockQty, arUnit(item.unit)) },
        { label: 'الجديد', value: fmtQty(item.stockQty + delta, arUnit(item.unit)) },
        { label: 'السبب', value: reason },
      ], [{ label: `مخزون ${item.name}`, value: `${fmtQty(item.stockQty, arUnit(item.unit))} ← ${fmtQty(item.stockQty + delta, arUnit(item.unit))}`, tone: delta >= 0 ? 'good' : 'bad' }], 'تسوية المخزون عملية حساسة (R3) — محتاجة سبب واعتماد')
      return { ok: true, opType: type, payload, summary, card }
    }

    case 'reversal': {
      const ref = String(f.ref ?? '') || (norm.match(/WKL-\d+/)?.[0] ?? '')
      if (!ref) return { ok: false, opType: type, payload: {}, summary: '', card: null as never, missing: 'رقم العملية', failMessage: 'عايز تعكس أنهي عملية؟ اكتب رقمها (زي WKL-1006)' }
      const original = await db.operation.findFirst({ where: { businessId: business.id, ref } })
      if (!original) return { ok: false, opType: type, payload: {}, summary: '', card: null as never, failMessage: `ملقيتش عملية رقم ${ref}` }
      if (original.reversedByRef) return { ok: false, opType: type, payload: {}, summary: '', card: null as never, failMessage: `العملية ${ref} معكوسة قبل كده بـ${original.reversedByRef}` }
      const reason = String(f.reason ?? '') || 'تصحيح خطأ'
      const payload = { originalRef: ref, reason }
      const risk = computeRisk(type)
      const summary = `عكس العملية ${ref} (${original.summary})`
      const card = fieldsToCard('', type, risk, summary, [
        { label: 'العملية الأصلية', value: `${ref} — ${TYPE_AR[original.type] ?? original.type}` },
        { label: 'ملخصها', value: original.summary },
        { label: 'السبب', value: reason },
      ], [{ label: 'الأثر', value: 'هيتلغى بالكامل بعملية عكسية موثقة', tone: 'neutral' }], 'عكس عملية مالية حساس (R3) — التاريخ مش بيتمسح، بيتصحح')
      return { ok: true, opType: type, payload, summary, card }
    }

    default:
      return { ok: false, opType: type, payload: {}, summary: '', card: null as never, failMessage: 'نوع العملية مش مدعوم' }
  }
}

// ---------------------------------------------------------------------------
// The turn runner
// ---------------------------------------------------------------------------
export interface TurnResult {
  replyText: string
  card?: ActionCardDTO | null
  cards?: ResultCardDTO[] | null
  thinking: ThinkingStep[]
  modelLabel: string
  opId?: string
}

export async function runAgentTurn(ctx: TurnContext, emit: TurnEmit): Promise<TurnResult> {
  const { business, user, text } = ctx
  const v = getVertical(business.type)
  const model = await resolveModel(ctx.modelKey)
  const modelLabel = modelLabelFor(model)

  // Load context once
  const [items, customers, suppliers, memories] = await Promise.all([
    db.item.findMany({ where: { businessId: business.id } }),
    db.customer.findMany({ where: { businessId: business.id } }),
    db.supplier.findMany({ where: { businessId: business.id } }),
    db.agentMemory.findMany({ where: { businessId: business.id, userId: user.id }, orderBy: { createdAt: 'desc' }, take: 6 }),
  ])

  const steps: ThinkingStep[] = [
    { label: 'بفهم طلبك', detail: 'بحلل الجملة وأستخرج القصد والحقول', state: 'active', icon: 'understand' },
    { label: 'بدوّر في سجلك', detail: 'بدوّر على الأصناف والأسماء الحقيقية', state: 'pending', icon: 'search' },
    { label: 'بتحقق من الأرقام', detail: 'بحسب من الأسعار الفعلية مش من دماغي', state: 'pending', icon: 'verify' },
    { label: 'بجهّز الرد', detail: '', state: 'pending', icon: 'plan' },
  ]
  const pushThinking = () => emit({ event: 'thinking', steps: steps.map((s) => ({ ...s })) })
  const done = (i: number, detail?: string) => {
    if (steps[i]) {
      steps[i].state = 'done'
      if (detail) steps[i].detail = detail
    }
    pushThinking()
  }
  pushThinking()

  // ---- PASS 1: Understand (LLM with rule-based fallback) ----
  let intent: ExtractedIntent
  try {
    const system = buildSystemPrompt({ business, user, items, customers, suppliers, memories, history: ctx.history })
    const raw = await completeChat(model, [
      { role: 'system', content: system },
      { role: 'user', content: text },
    ])
    intent = parseIntentJson(raw) ?? ruleBasedIntent(text, business.type)
    done(0, intent.replyHint ? `فهمت: ${intent.replyHint}` : 'فهمت الطلب')
  } catch (err) {
    console.error('[harness] intent pass failed → rule-based fallback:', err)
    intent = ruleBasedIntent(text, business.type)
    done(0, 'فهمت الطلب بالقواعد المحلية (الموديل مش متاح)')
  }

  // ---- PASS 2+3: Act ----
  let situation = ''
  let card: ActionCardDTO | null = null
  let cards: ResultCardDTO[] | null = null
  let opId: string | undefined
  let replyInstruction = ''
  let questionMode = false

  if (intent.intent === 'read' && intent.tool) {
    emit({ event: 'step', label: `بشغّل أداة ${intent.tool}`, state: 'active' })
    done(1, 'لقيت البيانات في السجل')
    cards = await runReadTool(intent.tool as ReadTool, business.id, intent.fields ?? {})
    emit({ event: 'cards', cards })
    emit({ event: 'step', label: `بشغّل أداة ${intent.tool}`, state: 'done' })
    done(2, 'الأرقام جاية من قاعدة البيانات مباشرة')
    situation = `شغّلت أداة القراءة ${intent.tool} ودي النتايج:\n${JSON.stringify(cards, null, 1).slice(0, 1600)}`
    replyInstruction = 'لخّص النتيجة للمستخدم بالمصري بأرقامها الصحيحة من الجدول فوق. لو مفيش بيانات قول كده بصراحة.'
  } else if (intent.intent === 'write' && intent.opType) {
    const opType = intent.opType as OpType
    if (!canDraft(user.role, opType)) {
      situation = `المستخدم (${user.role}) مش مسموحله يسجّل ${TYPE_AR[opType] ?? opType}.`
      replyInstruction = 'وضّح بذوق إن العملية دي محتاجة صلاحية أعلى (المالك أو المشرف) ومتشغلش أي أداة.'
    } else {
      done(1, 'بمشي على الأصناف والأسماء الحقيقية')
      const resolved = await resolveWrite(ctx, intent, emit)
      if (!resolved.ok) {
        done(2, resolved.failMessage ?? '')
        situation = `معلومات ناقصة: ${resolved.missing ?? ''} — ${resolved.failMessage ?? ''}`
        replyInstruction = 'اسأل سؤال واحد قصير يطلب أهم حقل ناقص. متاخدش أي قرار.'
        questionMode = true
      } else {
        done(2, `حسبت الإجمالي من السعر الحقيقي: ${resolved.summary}`)
        emit({ event: 'step', label: `بجهّز مسودة ${TYPE_AR[resolved.opType]}`, state: 'active' })
        const idem = `${business.id}:${user.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
        const draft = await createDraft({
          businessId: business.id,
          userId: user.id,
          type: resolved.opType,
          summary: resolved.summary,
          payload: resolved.payload,
          conversationId: ctx.conversationId,
          idempotencyKey: idem,
        })
        opId = draft.id
        card = { ...resolved.card, ref: draft.ref, opId: draft.id }
        emit({ event: 'card', card })
        emit({ event: 'step', label: `بجهّز مسودة ${TYPE_AR[resolved.opType]}`, state: 'done' })
        situation = `اتعملت مسودة عملة رقم ${draft.ref} (${resolved.summary}) مستنية اعتماد المستخدم. درجة الخطورة ${draft.risk}. مفيش حاجة اتنفذت في الخزنة أو المخزون لسه.`
        replyInstruction = `اكتب تأكيد قصير إن المسودة جاهزة بالأرقام الصح وإنها مستنية اعتماده${draft.risk === 'R3' ? '، وذكّره إنها عملية حساسة محتاجة سبب' : ''}. خليك مختصر.`
      }
    }
  } else {
    // chat
    done(1, 'كلام عام')
    done(2, '')
    situation = `رسالة عامة (تحية/سؤال خارج الأدوات). سياق الشغل: ${v.label} — ${business.name}.`
    replyInstruction = `ردّ بالمصري بلطف وقصر. لو مناسب اعرض 2-3 من الأوامر اللي بتنفع ${v.shortLabel}: ${v.chips.slice(0, 3).join(' · ')}`
  }

  done(3)

  // ---- PASS 4: Explain (letter-by-letter streaming) ----
  let replyText = ''
  const messages: LLMMessage[] = [
    { role: 'system', content: buildReplyPrompt({ business: { name: business.name, type: business.type }, userName: user.name, situation, instruction: replyInstruction }) },
  ]
  try {
    for await (const chunk of streamChat(model, messages)) {
      if (chunk.type !== 'content') continue
      replyText += chunk.text
      // Re-pace into tiny letter-by-letter deltas
      const pieces = chunk.text.match(/.{1,2}/g) ?? []
      for (const piece of pieces) {
        emit({ event: 'delta', text: piece })
        await sleep(10 + Math.random() * 18)
      }
    }
  } catch (err) {
    console.error('[harness] reply stream failed:', err)
    if (!replyText) {
      const fallback = card
        ? `جهزتلك مسودة «${card.title}» — ${card.summary}. راجعها واعتمدها لو تمام.`
        : cards
          ? 'دي النتايج من السجل فوق.'
          : questionMode
            ? (situation.match(/— (.+)$/)?.[1] ?? 'محتاج تفاصيل أكتر لو سمحت.')
            : 'تمام، تحت أمرك.'
      for (const ch of fallback.match(/.{1,2}/g) ?? []) {
        replyText += ch
        emit({ event: 'delta', text: ch })
        await sleep(24)
      }
    }
  }

  if (!replyText.trim()) {
    const fallback = card ? `جهزت المسودة — ${card.summary}` : 'تمام.'
    for (const ch of fallback.match(/.{1,2}/g) ?? []) {
      replyText += ch
      emit({ event: 'delta', text: ch })
      await sleep(20)
    }
  }

  return { replyText, card, cards, thinking: steps, modelLabel, opId }
}
