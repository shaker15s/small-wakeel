// وكيل — «موظف حقيقي» (R41): pending multi-turn requests.
//
// A real employee does not restart the conversation when the information
// arrives in pieces. «جبت 100 صفيحة سمنة ودفعتله 1000» starts the request;
// «المورد شركة السمانه المصرية والحساب 2000» finishes it. This module holds
// the open request per conversation (20-minute grace, like CashbookDialogue)
// and fills its slots deterministically.
//
// Clarification budget (researched, see docs/R41_EMPLOYEE_ACCEPTANCE):
//   • infer from what is already said — never re-ask a known slot
//   • ask ONE targeted question for what changes the draft
//   • propose (from memory) instead of asking when a stable pattern exists
//   • the user's latest message always overrides memory
import { db } from '../db'
import { arUnit } from '../verticals'
import { normalizeAr, toWesternDigits, unitToCode } from './arabic'

export interface NewItemSlots {
  /** Set for a KNOWN-catalog item («purchase_known_item»); null for a new one. */
  itemId: string | null
  itemName: string
  qty: number | null
  unit: string | null // canonical code (piece/kg/…)
  unitLabel: string | null // the owner's own word («صفيحة»)
  paid: number | null // EGP
  supplierName: string | null
  suggestedSupplier: string | null // from memory — proposed, not assumed
  total: number | null // EGP — may stay null for a known item (catalog price applies)
  unitPrice: number | null // EGP
  note?: string
  /** R48 credit_new_customer: the unregistered customer the credit sale heads to. */
  customerName?: string | null
  /** R48 credit_new_customer: pre-existing debt the owner stated («عليه ٢٠» / «جديد»→0). */
  openingBalance?: number | null
  /** R48 credit_new_customer: the ORIGINAL sale sentence — the draft is built from it. */
  sourceText?: string
}

export type PendingKind = 'purchase_new_item' | 'purchase_known_item' | 'credit_new_customer'

const PENDING_TTL_MS = 20 * 60 * 1000 // same grace as CashbookDialogue

// Words that terminate a name/unit capture — a real owner's sentence anatomy.
const STOP_WORDS =
  /^(و|في|من|لل|بس|فقط|نهارده|النهارده|امبارح|امبارح|بكرة|بكرا|دفع|دفعت|عليه|لهم|جنيه|ج\.م|فلس|الكل|الكامل|الحساب|والحساب|والسعر|سعر|بكام|كام|ليه|لو|اذا|ايه|إيه|؟|،|,)$/

function words(norm: string): string[] {
  return norm
    .replace(/[؟?!.،,]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/** Western digits, Arabic-Indic folded. */
function numsIn(norm: string): number[] {
  const western = toWesternDigits(norm)
  return (western.match(/\d+(?:\.\d+)?/g) ?? []).map(Number).filter((n) => Number.isFinite(n))
}

export function parseSlots(raw: string): NewItemSlots {
  try {
    const o = JSON.parse(raw) as Partial<NewItemSlots>
    return {
      itemId: typeof o.itemId === 'string' ? o.itemId : null,
      itemName: String(o.itemName ?? ''),
      qty: typeof o.qty === 'number' ? o.qty : null,
      unit: typeof o.unit === 'string' ? o.unit : null,
      unitLabel: typeof o.unitLabel === 'string' ? o.unitLabel : null,
      paid: typeof o.paid === 'number' ? o.paid : null,
      supplierName: typeof o.supplierName === 'string' ? o.supplierName : null,
      suggestedSupplier: typeof o.suggestedSupplier === 'string' ? o.suggestedSupplier : null,
      total: typeof o.total === 'number' ? o.total : null,
      unitPrice: typeof o.unitPrice === 'number' ? o.unitPrice : null,
      note: typeof o.note === 'string' ? o.note : undefined,
      customerName: typeof o.customerName === 'string' ? o.customerName : null,
      openingBalance: typeof o.openingBalance === 'number' ? o.openingBalance : null,
      sourceText: typeof o.sourceText === 'string' ? o.sourceText : '',
    }
  } catch {
    return {
      itemId: null,
      itemName: '',
      qty: null,
      unit: null,
      unitLabel: null,
      paid: null,
      supplierName: null,
      suggestedSupplier: null,
      total: null,
      unitPrice: null,
      customerName: null,
      openingBalance: null,
      sourceText: '',
    }
  }
}

export function slotsJson(slots: NewItemSlots): string {
  return JSON.stringify(slots)
}

/** Upsert the open request for a conversation (one at a time). */
export async function savePendingRequest(params: {
  businessId: string
  conversationId: string
  userId: string
  kind: PendingKind
  slots: NewItemSlots
  question: string
}): Promise<void> {
  const { businessId, conversationId, userId, kind, slots, question } = params
  const now = new Date()
  const expiresAt = new Date(now.getTime() + PENDING_TTL_MS)
  const existing = await db.pendingRequest.findUnique({ where: { conversationId } })
  if (existing) {
    await db.pendingRequest.update({
      where: { conversationId },
      data: { businessId, userId, kind, slots: slotsJson(slots), question, status: 'awaiting', createdAt: now, expiresAt },
    })
  } else {
    await db.pendingRequest.create({
      data: {
        businessId,
        conversationId,
        userId,
        kind,
        slots: slotsJson(slots),
        question,
        status: 'awaiting',
        createdAt: now,
        expiresAt,
      },
    })
  }
}

/** The open request for this conversation, or null (absent/expired/settled). */
export async function getActivePendingRequest(
  businessId: string,
  conversationId: string,
): Promise<{ id: string; kind: PendingKind; slots: NewItemSlots; question: string } | null> {
  const row = await db.pendingRequest.findUnique({ where: { conversationId } })
  if (!row || row.businessId !== businessId || row.status !== 'awaiting') return null
  if (row.expiresAt.getTime() < Date.now()) {
    await db.pendingRequest.update({ where: { conversationId }, data: { status: 'cancelled' } })
    return null
  }
  return { id: row.id, kind: row.kind as PendingKind, slots: parseSlots(row.slots), question: row.question }
}

export async function markPendingDone(conversationId: string, status: 'resolved' | 'cancelled'): Promise<void> {
  await db.pendingRequest
    .update({ where: { conversationId }, data: { status } })
    .catch(() => null)
}

/**
 * From a purchase sentence whose item is NOT in the catalog, extract the new
 * item: quantity + the owner's unit word + the item name.
 * «جبت 100 صفيحه سمنه ودفعتله 1000 بس النهارده» → {100, «صفيحه», «سمنه», paid:1000}
 */
export function extractNewItemCandidate(text: string, norm: string): NewItemSlots | null {
  const western = toWesternDigits(norm)
  // 1) Paid clause — «دفع/دفعت/دفعتله/خلاص + N (بس)»
  let paid: number | null = null
  const paidMatch = western.match(/(?:دفع|دفعت|دفعتله|دفعتها|دفعتو|خلاص|ادفع)\s*(\d+(?:\.\d+)?)\s*(?:بس|فقط|تمام)?/)
  if (paidMatch) paid = Number(paidMatch[1])
  const noPaid = western.replace(/(?:دفع|دفعت|دفعتله|دفعتها|دفعتو|خلاص|ادفع)\s*\d+(?:\.\d+)?\s*(?:بس|فقط|تمام)?/g, ' ')

  const ws = words(noPaid)
  const numIdx = ws.findIndex((w) => /^\d+(?:\.\d+)?$/.test(w))
  if (numIdx < 0) return null
  const qty = Number(ws[numIdx])
  if (!(qty > 0)) return null

  let unitLabel: string | null = null
  let nameStart = numIdx + 1
  const after1 = ws[numIdx + 1]
  if (after1 && !STOP_WORDS.test(after1)) {
    // «100 صفيحه سمنه» — unit first, then name; or «100 سمنه صفيحه» — name then unit.
    const nextIsUnit = unitToCode(after1) != null || /صفيحه|صفائح|علبه|علب|كرتونه|كراتين|كيس|كيسه|زجاجة|بوكسه|ربعه|طقم|فلسه|طوبه|توبه/.test(after1)
    if (nextIsUnit) {
      unitLabel = after1
      nameStart = numIdx + 2
    } else {
      nameStart = numIdx + 1
      const after2 = ws[numIdx + 2]
      if (after2 && /صفيحه|صفائح|علبه|علب|كرتونه|كراتين|كيس|كيسه|زجاجة|بوكسه/.test(after2)) unitLabel = after2
    }
  }

  // 2) Name: 1–3 words after the qty (+unit), stopping at anatomy words.
  const nameWords: string[] = []
  for (let i = nameStart; i < ws.length && nameWords.length < 3; i++) {
    const w = ws[i]
    if (STOP_WORDS.test(w) || /^\d/.test(w)) break
    nameWords.push(w)
  }
  // 3) Reversed order: «جبت سمنه 100 صفيحه» — name sits BEFORE the number.
  if (nameWords.length === 0 && numIdx > 1) {
    for (let i = numIdx - 1; i >= 0 && nameWords.length < 3; i--) {
      const w = ws[i]
      if (STOP_WORDS.test(w) || /^(جبت|جبت|جيب|اشتريت|اشتري|اخد|اخدت|اتجيب|اتطلب|طلب|طلبه|سجل|سجلت|دخول|دخلت)$/.test(w)) break
      if (/صفيحه|صفائح|علبه|علب|كرتونه|كراتين|كيس|كيسه|زجاجة|بوكسه/.test(w)) continue
      nameWords.unshift(w)
    }
  }
  const itemName = nameWords.join(' ').trim()
  if (itemName.length < 2) return null
  if (!paid && qty == null) return null

  return {
    itemId: null,
    itemName,
    qty,
    unit: unitToCode(unitLabel) ?? 'piece',
    unitLabel,
    paid,
    supplierName: null,
    suggestedSupplier: null,
    total: null,
    unitPrice: null,
  }
}

/**
 * Fill the pending slots from the follow-up message.
 * «المورد شركة السمانه المصريه والسعر كله 2000» → {supplierName, total}
 * «الوحده بـ 20» → {unitPrice}
 */
export function fillPendingSlots(
  norm: string,
  slots: NewItemSlots,
  knownSuppliers: string[],
): { supplierName: string | null; total: number | null; unitPrice: number | null; changed: boolean } {
  const western = toWesternDigits(norm)
  const out: { supplierName: string | null; total: number | null; unitPrice: number | null } = {
    supplierName: null,
    total: null,
    unitPrice: null,
  }

  // Supplier from the known supplier book wins over raw capture (canonical name).
  for (const sName of knownSuppliers) {
    const flat = normalizeAr(sName).replace(/\s+/g, ' ')
    const at = flat.length >= 3 ? wordBounded(norm, flat) : -1
    if (at >= 0) {
      out.supplierName = sName
      break
    }
  }
  if (!out.supplierName) {
    // Marker-driven capture: «المورد X» / «بتاع X» / «من X» / «من عند X».
    const segments = western.split(/\s+(?:و|،|,|؛|;|\?)\s+/).join(' ')
    const m = western.match(/(?:المورد|المورده|بتاع|بتاعت|من عند|من|عند|الغلله|الغلا|الشركة|الشركه|بيجي من|بتيجي من|جاي من|جايه من)\s+([^\d؟?،,;]+?)(?=\s+(?:و|بس|كام|جنيه|ج\.م|بـ|ب |بال|بالكامل|والحساب|والسعر|والكل|والوحده|والوحدة)\s|$)/)
    void segments
    if (m) {
      const raw = m[1].trim()
      const w = raw.split(/\s+/).filter((x) => x.length >= 2 && !STOP_WORDS.test(x)).slice(0, 4)
      if (w.length >= 1 && w.join(' ').length >= 3) out.supplierName = w.join(' ')
    }
  }

  // Unit price: «الوحدة بـ20» / «كل وحدة 20» / «سعر الوحدة 20»
  const up = western.match(/(?:الوحده|الوحدة|كل وحد|سعر الوحد)\s*(?:بـ|ب|=)?\s*(\d+(?:\.\d+)?)/)
  if (up) out.unitPrice = Number(up[1])

  // Total: the number that is not already explained (qty / paid / unit price).
  const explained = new Set<number>()
  if (slots.qty != null) explained.add(slots.qty)
  if (slots.paid != null) explained.add(slots.paid)
  if (out.unitPrice != null) explained.add(out.unitPrice)
  const candidates = numsIn(western).filter((n) => n > 0 && !explained.has(n))
  if (candidates.length === 1) {
    out.total = candidates[0]
  } else if (candidates.length > 1) {
    // Prefer a number glued to «الكل/الكامل/الحساب/بسعر» or trailing at the end.
    const glued = western.match(/(?:الكل|الكامل|الحساب|بسعر|بسعره)\s*(?:بـ|ب)?\s*(\d+(?:\.\d+)?)/)
    if (glued) out.total = Number(glued[1])
    else {
      const tail = western.match(/(\d+(?:\.\d+)?)\s*$/)
      if (tail && candidates.includes(Number(tail[1]))) out.total = Number(tail[1])
    }
  }

  // Unit price given without a total: derive the total from the quantity.
  if (out.total == null && out.unitPrice != null && slots.qty != null) {
    out.total = Math.round(out.unitPrice * slots.qty)
  }
  // Total given without a unit price: derive the unit price.
  if (out.total != null && out.unitPrice == null && slots.qty != null && slots.qty > 0) {
    out.unitPrice = Math.round((out.total / slots.qty) * 100) / 100
  }

  const changed = out.supplierName != null || out.total != null || out.unitPrice != null
  return { ...out, changed }
}

/** Word-bounded containment on the normalized text. */
function wordBounded(hay: string, needle: string): number {
  const h = normalizeAr(hay).replace(/\s+/g, ' ')
  const n = needle.replace(/\s+/g, ' ')
  if (n.length < 2) return -1
  const idx = h.indexOf(n)
  if (idx < 0) return -1
  const before = h[idx - 1]
  const after = h[idx + n.length]
  const isBoundary = (c: string | undefined) => !c || /[\s،,؟?!.]/.test(c)
  return isBoundary(before) && isBoundary(after) ? idx : -1
}

/**
 * Is the message clearly a NEW topic (so the pending request should be
 * released)? A work command / question / greeting with none of the pending
 * vocabulary — the owner moved on.
 */
export function looksLikeNewTopic(norm: string): boolean {
  const hasPendingVocab = /(المورد|المورده|بتاع|بتاعت|من عند|الحساب|الكامل|الكل|بسعر|الوحده|الوحدة|صفيحه|صفائح|جنيه|ج\.م|دفعت|دفع)/.test(norm)
  if (hasPendingVocab) return false
  if (numsIn(norm).length === 0) return true
  return false
}

/**
 * R48 — parse the owner's answer to «عليه كام من قبل؟».
 *  • an explicit zero-word («جديد / مش عليه / من عندنا / صفر») → 0
 *  • the first number in the sentence → the opening balance (EGP)
 *  • anything else (a new command / no number) → null (still open)
 * A work-verb in the sentence means the owner moved on — that is a NEW topic,
 * not a balance, so it resolves to null and the caller checks looksLikeNewTopic.
 */
const CREDIT_ZERO_RE =
  /^(?:جديد|جديدك|مش عليه|مش عليه حاجه|مش عليه حاجة|من عندنا|مفيش|مفيش عليه|صفر|ولا جنيه|ولا حاجه|ولا حاجة|ولا حاجة عليه|نظيف|0|٠)[\s؟?!.،,]*(?:يا\s+\S+)?[\s؟?!.،,]*$/
const CREDIT_CMD_RE =
  /(?:^| )(?:بعت|بيعت|بيع|جبت|جيب|اشتريت|شرا|شراء|مصروف|صرفت|تحصيل|حصلت|دفع|دفعت|سدد|سددت|سجل|سجلت|ضيف|ضيفت|اعكس|ملش|الغيت|الغي|يلغي|امسح|جرد)(?: |$)/
export function parseCreditBalance(norm: string): number | null {
  const t = norm.trim()
  if (CREDIT_ZERO_RE.test(t)) return 0
  // A fresh work command is not a balance — the owner moved on.
  if (CREDIT_CMD_RE.test(t)) return null
  const nums = numsIn(norm)
  return nums.length > 0 ? nums[0] : null
}

/** R48 — is the message a fresh WORK command (so the credit request releases)? */
export function isCreditCommand(norm: string): boolean {
  return CREDIT_CMD_RE.test(norm.trim())
}

/** The outstanding question, in the employee's voice (Egyptian, warm, precise). */
export function pendingQuestionText(slots: NewItemSlots, kind: PendingKind): string {
  const { itemName, qty, unitLabel, paid, suggestedSupplier } = slots
  const unitTxt = unitLabel ?? (slots.unit ? arUnit(slots.unit) : '')
  const qtyTxt = qty != null ? `${numAr(qty)} ${unitTxt}`.trim() : null
  const paidTxt = paid != null ? `ودفعت ${numAr(paid)}` : null
  const known = [qtyTxt, paidTxt].filter(Boolean).join('، ')

  // R48 credit_new_customer: the ONLY missing slot is the opening balance.
  if (kind === 'credit_new_customer') {
    const name = slots.customerName ?? ''
    const q = qtyTxt ? ` — ${qtyTxt} ${itemName}` : ''
    return `«${name}» مش مسجل في حسابات العملاء${q}. عليه كام من قبل؟ قولي رقمه وأنا أسجله وأنزل عليه البيعة، أو قولي «جديد» لو من عندنا.`
  }

  // KNOWN-catalog item: the only missing slot is the supplier — ONE question.
  if (kind === 'purchase_known_item') {
    const understood = known ? ` — فاهمها كده: ${known} النهارده` : ''
    const supplierQ = suggestedSupplier
      ? `المرة اللي فاتت كان من «${suggestedSupplier}» — نفس المورد؟`
      : `مين بتاع ${itemName}؟`
    return `تمام يا فندم — «${itemName}»${understood}.\nعشان أكمّل المسودة: ${supplierQ}`.trim()
  }

  const intro = `«${itemName}» مش في الكتالوج بعد — افتكرته صنف جديد؟`
  const understoodK = known ? ` فاهمها كده: ${known} النهارده.` : '.'
  const supplierQ = suggestedSupplier
    ? `المرة اللي فاتت كان من «${suggestedSupplier}» — نفس المورد؟ `
    : `مين بتاع ${itemName}؟ `
  const totalQ = slots.total != null || slots.unitPrice != null ? '' : 'وكام الحساب كله؟'
  return `${intro}${understoodK}\nعشان أجهز المسودة: ${supplierQ}${totalQ || ''}${
    slots.total != null || slots.unitPrice != null ? '' : '(وأحسبلك الباقي عليهم في المسودة)'
  }`.trim()
}

/** Follow-up question when part of the slots is still missing. */
export function pendingFollowUpText(slots: NewItemSlots, kind: PendingKind): string {
  if (kind === 'credit_new_customer') {
    return `«${slots.customerName ?? ''}» عليه كام من قبل؟ قولي رقمه وأنا أسجله — أو «جديد» لو من عندنا.`
  }
  const parts: string[] = []
  if (!slots.supplierName && !slots.suggestedSupplier) parts.push(`مين بتاع ${slots.itemName}؟`)
  // A known item prices itself from the catalog — never ask its total.
  if (kind === 'purchase_new_item' && slots.supplierName && slots.total == null && slots.unitPrice == null) {
    parts.push(`وكام الحساب كله لـ«${slots.supplierName}»؟`)
  }
  if (!slots.supplierName && !slots.suggestedSupplier && slots.total == null && slots.unitPrice == null) {
    return kind === 'purchase_new_item'
      ? `تمام — بس لسه ناقصين: مين بتاع ${slots.itemName}؟ وكام الحساب كله؟`
      : `تمام — بس لسه ناقص: مين بتاع ${slots.itemName}؟`
  }
  if (parts.length) return `تمام — ${parts.join(' ')}`
  return 'تمام — جهزتلك المسودة'
}

function numAr(n: number): string {
  try {
    return new Intl.NumberFormat('ar-EG', { maximumFractionDigits: 2 }).format(n)
  } catch {
    return String(n)
  }
}
