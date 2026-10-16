// وكيل — vertical registry: one entry per business type.
// Adding a new vertical = one entry here + seed data. Nothing else.

import type { Vertical } from './types'

export interface VerticalDef {
  key: Vertical
  label: string // «وضع السوبر ماركت»
  shortLabel: string // «السوبر ماركت»
  description: string
  icon: 'basket' | 'dumbbell' | 'pill' | 'sparkle'
  headerLabel: string // subtitle under business name
  welcome: string // agent welcome message
  chips: string[] // quick-action chips under composer
  examples: string[] // welcome examples for empty conversation
  tools: string[] // tools available for this vertical
  units: string[] // typical units
  features: { expiry: boolean; grams: boolean; memberships: boolean; sessions: boolean }
}

export const VERTICALS: Record<Vertical, VerticalDef> = {
  supermarket: {
    key: 'supermarket',
    label: 'وضع السوبر ماركت',
    shortLabel: 'السوبر ماركت',
    description: 'بيع بالقطعة والكيلو، موردون، وردية وخزنة',
    icon: 'basket',
    headerLabel: 'بيع وشراء ومخزون',
    welcome:
      'أهلاً! انا وكيل، مساعدك في السوبر ماركت. قولّي بيع أو شراء أو اسألني عن الخزنة والمخزون، وانا جهزلك كل حاجة جاهزة للاعتماد.',
    chips: ['بعت 3 كرتونة لبن', 'إيه وضع الخزنة؟', 'المخزون الناقص', 'سجّل مصروف كهربا 200 ج'],
    examples: ['بعت 5 علب تونة للعميل أحمد', 'اشتريت 10 كيلو قهوة من محمد بـ2500', 'المخزون الناقص', 'اللي علينا للموردين'],
    tools: [
      'draft_sale',
      'draft_purchase',
      'record_expense',
      'record_collection',
      'record_payment',
      'adjust_stock',
      'list_low_stock',
      'get_cash_position',
      'get_daily_summary',
      'search_catalog',
      'list_receivables',
      'list_payables',
      'reverse_operation',
      'schedule_task',
      'save_memory',
    ],
    units: ['piece', 'kg', 'liter', 'box'],
    features: { expiry: false, grams: false, memberships: false, sessions: false },
  },
  gym: {
    key: 'gym',
    label: 'وضع الجيم',
    shortLabel: 'الجيم',
    description: 'أعضاء واشتراكات وحضور وتحصيلات',
    icon: 'dumbbell',
    headerLabel: 'أعضاء واشتراكات',
    welcome:
      'أهلاً! انا وكيل، مساعدك في الجيم. اسألني عن أي عضو، جدد اشتراك، سجّل حضور أو تحصيل — وانا أعملها صح من أول مرة.',
    chips: ['اشتراك عمر شهرية', 'حضور محمد اليوم', 'الاشتراكات اللي هتنتهي', 'تحصيل 300 من أحمد'],
    examples: ['اشتراك جديد لسمير خطة شهرية 350', 'محمد حضر النهاردة', 'الاشتراكات المنتهية', 'تحصيل 200 من العضو كريم'],
    tools: [
      'create_member',
      'renew_membership',
      'record_attendance',
      'record_collection',
      'record_expense',
      'get_member_status',
      'list_receivables',
      'get_cash_position',
      'get_daily_summary',
      'reverse_operation',
      'schedule_task',
      'save_memory',
    ],
    units: ['session', 'piece'],
    features: { expiry: false, grams: false, memberships: true, sessions: true },
  },
  pharmacy: {
    key: 'pharmacy',
    label: 'وضع الصيدلية',
    shortLabel: 'الصيدلية',
    description: 'أدوية وصلاحيات ومخزون دقيق',
    icon: 'pill',
    headerLabel: 'أدوية وصلاحيات',
    welcome:
      'أهلاً! انا وكيل، مساعدك في الصيدلية. اسألني عن الصلاحيات والمخزون الناقص، سجّل البيع والشرا — كل حاية موثقة ومتحققة.',
    chips: ['الأدوية اللي صلاحيتها قربت تخلص', 'بعت علبة بروفين', 'المخزون الناقص', 'إيه وضع الخزنة؟'],
    examples: ['بعت علبة بانادول للزبون', 'الأدوية اللي صلاحيتها قربت تخلص', 'اشتريت 5 علب أوجمنتين من المورد', 'المخزون الناقص'],
    tools: [
      'draft_sale',
      'draft_purchase',
      'record_expense',
      'record_collection',
      'record_payment',
      'adjust_stock',
      'list_low_stock',
      'list_expiring',
      'get_cash_position',
      'get_daily_summary',
      'search_catalog',
      'list_receivables',
      'list_payables',
      'reverse_operation',
      'schedule_task',
      'save_memory',
    ],
    units: ['piece', 'box', 'strip', 'capsule'],
    features: { expiry: true, grams: false, memberships: false, sessions: false },
  },
  attar: {
    key: 'attar',
    label: 'وضع العطارة',
    shortLabel: 'العطارة',
    description: 'بيع بالجرام والمللي وخلطات',
    icon: 'sparkle',
    headerLabel: 'بيع بالجرام والمللي',
    welcome:
      'أهلاً! انا وكيل، مساعدك في العطارة. قولّي بعت كام جرام من إيه — عود، مسك، خلطات — وانا أحسبها وأسجّلها بالوحدة الصح.',
    chips: ['بعت 10 جرام عود كمبودي', 'سجّل بيع ربع كيلو كركديه', 'إيه وضع الخزنة؟', 'المخزون الناقص'],
    examples: ['بعت 10 جرام عود كمبودي', 'سجّل بيع ربع كيلو كركديه', 'بعت 50 مللي زيت صندل', 'المخزون الناقص'],
    tools: [
      'draft_sale',
      'draft_purchase',
      'record_expense',
      'record_collection',
      'record_payment',
      'adjust_stock',
      'list_low_stock',
      'get_cash_position',
      'get_daily_summary',
      'search_catalog',
      'list_receivables',
      'list_payables',
      'reverse_operation',
      'schedule_task',
      'save_memory',
    ],
    units: ['gram', 'kilo', 'milli', 'liter'],
    features: { expiry: false, grams: true, memberships: false, sessions: false },
  },
}

export function getVertical(type: string): VerticalDef {
  return VERTICALS[type as Vertical] ?? VERTICALS.supermarket
}

// Unit conversion: «ربع كيلو كركديه» → 250 grams
export const UNIT_CONVERSION: Record<string, { to: string; factor: number; ar: string }[]> = {
  kilo: [
    { to: 'gram', factor: 1000, ar: 'كيلو' },
    { to: 'kg', factor: 1, ar: 'كيلو' },
  ],
  gram: [
    { to: 'gram', factor: 1, ar: 'جرام' },
    { to: 'kg', factor: 0.001, ar: 'جرام' },
  ],
}

export const AR_UNITS: Record<string, string> = {
  piece: 'قطعة',
  box: 'علبة',
  strip: 'شريط',
  capsule: 'كبسولة',
  kg: 'كيلو',
  gram: 'جرام',
  liter: 'لتر',
  milli: 'مللي',
  session: 'حصة',
}

export function arUnit(u: string): string {
  return AR_UNITS[u] ?? u
}
