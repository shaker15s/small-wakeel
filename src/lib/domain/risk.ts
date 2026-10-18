// وكيل — risk ladder + role permissions. The model can NEVER lower a risk level
// or grant itself an approval; this is enforced server-side only.

import type { OpType, Risk } from '../types'

/** Amount thresholds (piastres) that bump an operation to R3. */
export const R3_AMOUNT_THRESHOLD = 1_000_000 // 10,000 EGP

const BASE_RISK: Record<OpType, Risk> = {
  debt_promise: 'R2',
  cashbook: 'R2',
  sale: 'R2',
  purchase: 'R2',
  expense: 'R2',
  collection: 'R2',
  payment: 'R2',
  stock_adjustment: 'R3',
  price_change: 'R2',
  membership: 'R2',
  attendance: 'R1',
  // Creating a party with an OPENING BALANCE changes receivables/payables — it
  // is money-shaped master data, so it needs an approval like the rest.
  customer_add: 'R2',
  supplier_add: 'R2',
  reversal: 'R3',
}

export function computeRisk(type: OpType, totalPiastres?: number): Risk {
  let risk = BASE_RISK[type] ?? 'R2'
  if (risk === 'R2' && totalPiastres != null && totalPiastres >= R3_AMOUNT_THRESHOLD) risk = 'R3'
  return risk
}

export const RISK_META: Record<Risk, { label: string; color: string; hint: string }> = {
  R0: { label: 'قراءة فقط', color: 'text-emerald-700 bg-emerald-50 border-emerald-200', hint: 'مش بتحرك أي فلوس' },
  R1: { label: 'أثر بسيط', color: 'text-emerald-700 bg-emerald-50 border-emerald-200', hint: 'تسجيل بسيط بلافلوس' },
  R2: { label: 'حركة مالية', color: 'text-amber-700 bg-amber-50 border-amber-300', hint: 'بتحرّك فلوس أو مخزون — محتاجة اعتماد' },
  R3: { label: 'عملية حساسة', color: 'text-red-700 bg-red-50 border-red-300', hint: 'تعديل حساس محتاج اعتماد وسبب إلزامي' },
  R4: { label: 'خارج النطاق', color: 'text-red-800 bg-red-100 border-red-400', hint: 'مش متاحة للوكيل في المرحلة دي' },
}

/** Who may DRAFT each type (agent acts on behalf of the user). */
const DRAFT_ALLOWED: Record<string, string[]> = {
  debt_promise: ['owner', 'supervisor', 'cashier'],
  cashbook: ['owner', 'supervisor', 'cashier'],
  sale: ['owner', 'cashier', 'supervisor'],
  purchase: ['owner', 'supervisor'],
  expense: ['owner', 'supervisor'],
  collection: ['owner', 'cashier', 'supervisor', 'reception'],
  payment: ['owner', 'supervisor'],
  stock_adjustment: ['owner', 'supervisor'],
  price_change: ['owner', 'supervisor'],
  membership: ['owner', 'supervisor', 'reception'],
  attendance: ['owner', 'supervisor', 'reception'],
  // front-desk roles add members/walk-in customers all day long
  customer_add: ['owner', 'supervisor', 'cashier', 'reception'],
  supplier_add: ['owner', 'supervisor'],
  reversal: ['owner', 'supervisor'],
}

/**
 * Who may APPROVE (decide) a draft.
 *
 * Default policy (an Egyptian small shop has 2–4 people, and the cashier must
 * be able to complete a sale without waking the owner):
 *   R1/R2 → owner, supervisor, cashier, reception
 *   R3    → owner, supervisor only (large/sensitive amounts, reversals)
 *   R4    → nobody (blocked by design)
 *
 * Shops that need management-only approvals (including drafts created by
 * management themselves) flip `WAKIL_STRICT_APPROVALS=1`, which routes
 * EVERY write through management. It is opt-in so the default demo flows keep
 * working, but real deployments with employees should turn it on.
 */
export function canApprove(role: string, risk: Risk): boolean {
  if (risk === 'R4') return false
  if (risk === 'R3') return role === 'owner' || role === 'supervisor'
  if (risk === 'R2' || risk === 'R1') {
    if (process.env.WAKIL_STRICT_APPROVALS === '1') {
      return role === 'owner' || role === 'supervisor'
    }
    return role === 'owner' || role === 'supervisor' || role === 'cashier' || role === 'reception'
  }
  return false
}

export function canDraft(role: string, type: OpType): boolean {
  return DRAFT_ALLOWED[type]?.includes(role) ?? false
}

/** Approval needs BOTH operation-type and risk capabilities. */
export function canApproveOperation(role: string, type: OpType, risk: Risk): boolean {
  return canDraft(role, type) && canApprove(role, risk)
}
