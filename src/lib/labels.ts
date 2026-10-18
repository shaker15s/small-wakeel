// وكيل — pure client-safe label maps (no Prisma imports).
// Keep in sync with src/lib/agent/tools.ts (server side) — both must match.

import type { OpType, OpStatus, Risk, Vertical } from './types'

export const TYPE_AR: Record<string, string> = {
  debt_promise: 'تعديل وعد السداد',
  cashbook: 'دفتر الكاش والآجل',
  sale: 'بيع',
  purchase: 'شرا',
  expense: 'مصروف',
  collection: 'تحصيل',
  payment: 'سداد',
  stock_adjustment: 'تسوية مخزون',
  membership: 'اشتراك',
  attendance: 'حضور',
  reversal: 'عكس عملية',
}

export const STATUS_AR: Record<string, string> = {
  RECEIVED: 'مستلمة',
  AWAITING_APPROVAL: 'مستنية اعتماد',
  EXECUTING: 'بتتنفذ',
  SUCCEEDED: 'تم — موثّق ومتحقق',
  FAILED_SAFE: 'فشلت بأمان',
  OUTCOME_UNKNOWN: 'نتيجة غير محسومة',
  CANCELLED: 'ملغاة',
}

export const RISK_META: Record<Risk, { label: string; color: string; hint: string }> = {
  R0: { label: 'قراءة فقط', color: 'text-emerald-700 bg-emerald-50 border-emerald-200 dark:text-emerald-300 dark:bg-emerald-950 dark:border-emerald-800', hint: 'مش بتحرك أي فلوس' },
  R1: { label: 'أثر بسيط', color: 'text-emerald-700 bg-emerald-50 border-emerald-200 dark:text-emerald-300 dark:bg-emerald-950 dark:border-emerald-800', hint: 'تسجيل بسيط بلافلوس' },
  R2: { label: 'حركة مالية', color: 'text-amber-700 bg-amber-50 border-amber-300 dark:text-amber-300 dark:bg-amber-950 dark:border-amber-800', hint: 'بتحرّك فلوس أو مخزون — محتاجة اعتماد' },
  R3: { label: 'عملية حساسة', color: 'text-red-700 bg-red-50 border-red-300 dark:text-red-300 dark:bg-red-950 dark:border-red-800', hint: 'تعديل حساس محتاج اعتماد وسبب إلزامي' },
  R4: { label: 'خارج النطاق', color: 'text-red-800 bg-red-100 border-red-400 dark:text-red-200 dark:bg-red-950 dark:border-red-700', hint: 'مش متاحة للوكيل في المرحلة دي' },
}

export const VERTICAL_LABELS: Record<Vertical, string> = {
  supermarket: 'السوبر ماركت',
  gym: 'الجيم',
  pharmacy: 'الصيدلية',
  attar: 'العطارة',
  restaurant: 'المطعم والكافيه',
  clinic: 'العيادة والمستوصف',
  electronics: 'الموبايلات والإلكترونيات',
  wholesale: 'تجارة الجملة والمخازن',
  clothing: 'الملابس والأزياء',
}

export const TIER_AR: Record<string, string> = {
  air: 'خفيف',
  balanced: 'متوازن',
  deep: 'عميق',
}

export function arStatus(s: string): string {
  return STATUS_AR[s] ?? s
}

export function arType(t: string | OpType): string {
  return TYPE_AR[t] ?? t
}

export function arOpStatus(s: OpStatus): string {
  return STATUS_AR[s] ?? s
}
