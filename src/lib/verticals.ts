// وكيل — Dynamic Vertical & Plugin Registry
// Supports preset industries AND dynamically synthesized custom business verticals
// created via chat or the Business Builder wizard.

import type { PresetVertical, Vertical } from './types'

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

const CORE_SUPERPOWER_TOOLS = [
  'analyze_profitability',
  'forecast_stock',
  'get_proactive_insights',
  'upsert_catalog_item',
  'upsert_party',
  'create_quick_command',
  'create_business',
  'configure_business',
]

export const VERTICALS: Record<PresetVertical, VerticalDef> = {
  supermarket: {
    key: 'supermarket',
    label: 'وضع السوبر ماركت',
    shortLabel: 'السوبر ماركت',
    description: 'بيع بالقطعة والكيلو، موردون، وردية وخزنة',
    icon: 'basket',
    headerLabel: 'بيع وشراء ومخزون',
    welcome:
      'أهلاً! انا وكيل، موظفك الذكي في السوبر ماركت. قولّي بيع أو شراء أو اسألني عن الخزنة والمخزون والربحية، أو قولّي أضيف صنف أو أعمل مهمة مجدولة.',
    chips: ['بعت 3 كرتونة لبن', 'تحليل الربحية والهوامش', 'توقع نفاد المخزون', 'إيه وضع الخزنة؟'],
    examples: [
      'بعت 5 علب تونة للعميل أحمد',
      'تحليل الربحية وتوقع المخزون',
      'ضيف صنف جديد نسكافيه جولد بيع 120 وتكلفة 95 ورصيد 20 علبة',
      'المخزون الناقص واللي علينا للموردين',
    ],
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
      ...CORE_SUPERPOWER_TOOLS,
    ],
    units: ['piece', 'kg', 'liter', 'box', 'carton', 'pack'],
    features: { expiry: false, grams: false, memberships: false, sessions: false },
  },
  gym: {
    key: 'gym',
    label: 'وضع الجيم والنادي الصحي',
    shortLabel: 'الجيم',
    description: 'أعضاء واشتراكات وحضور وتحصيلات ومتابعة تجديدات',
    icon: 'dumbbell',
    headerLabel: 'أعضاء واشتراكات',
    welcome:
      'أهلاً يا كابتن! انا وكيل، موظفك في الجيم. اسألني عن أي عضو، جدد اشتراك، سجّل حضور أو تحصيل، أو اطلب تحليل الإيرادات والاشتراكات اللي قربت تخلص.',
    chips: ['اشتراك عمر شهرية', 'حضور محمد اليوم', 'الاشتراكات اللي هتنتهي', 'تحليل الربحية والهوامش'],
    examples: [
      'اشتراك جديد لسمير خطة شهرية 350',
      'محمد حضر النهاردة',
      'الاشتراكات المنتهية واللي ليّ عند الأعضاء',
      'تحصيل 200 من العضو كريم',
    ],
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
      ...CORE_SUPERPOWER_TOOLS,
    ],
    units: ['session', 'piece'],
    features: { expiry: false, grams: false, memberships: true, sessions: true },
  },
  pharmacy: {
    key: 'pharmacy',
    label: 'وضع الصيدلية',
    shortLabel: 'الصيدلية',
    description: 'أدوية وتشغيلات وصلاحيات ومخزون دقيق',
    icon: 'pill',
    headerLabel: 'أدوية وصلاحيات',
    welcome:
      'أهلاً يا دكتور! انا وكيل، موظفك في الصيدلية. بتابع الصلاحيات والنواقص والتشغيلات، وبسجّل البيع والشرا والطلبيات بدقة.',
    chips: ['الأدوية اللي صلاحيتها قربت تخلص', 'بعت علبة بروفين', 'توقع نفاد المخزون', 'إيه وضع الخزنة؟'],
    examples: [
      'بعت علبة بانادول للزبون',
      'الأدوية اللي صلاحيتها قربت تخلص والمخزون الناقص',
      'اشتريت 5 علب أوجمنتين من المورد',
      'تحليل الربحية والهوامش',
    ],
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
      ...CORE_SUPERPOWER_TOOLS,
    ],
    units: ['piece', 'box', 'strip', 'capsule'],
    features: { expiry: true, grams: false, memberships: false, sessions: false },
  },
  attar: {
    key: 'attar',
    label: 'وضع العطارة والزيوت',
    shortLabel: 'العطارة',
    description: 'بيع بالجرام والمللي وبالسعر المباشر وخلطات',
    icon: 'sparkle',
    headerLabel: 'بيع بالجرام والمللي',
    welcome:
      'أهلاً! انا وكيل، موظفك في العطارة. قولّي بعت كام جرام أو بكام جنيه من إيه — عود، مسك، توابل، خلطات — وانا أحسبها بالجرام والقرش.',
    chips: ['بعت 10 جرام عود كمبودي', 'سجّل بيع ربع كيلو كركديه', 'تحليل الربحية والهوامش', 'المخزون الناقص'],
    examples: [
      'بعت 10 جرام عود كمبودي',
      'بعت بـ 30 جنيه فلفل أسود',
      'توقع نفاد المخزون',
      'إيه وضع الخزنة والملخص النهاردة؟',
    ],
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
      ...CORE_SUPERPOWER_TOOLS,
    ],
    units: ['gram', 'kilo', 'milli', 'liter'],
    features: { expiry: false, grams: true, memberships: false, sessions: false },
  },
  restaurant: {
    key: 'restaurant',
    label: 'وضع المطعم والكافيه',
    shortLabel: 'مطعم وكافيه',
    description: 'أوردرات، مشروبات ووجبات، خامات وموردين، وورديات الكاشير',
    icon: 'sparkle',
    headerLabel: 'أوردرات ومشروبات وخامات',
    welcome:
      'أهلاً بيك! أنا وكيل، موظفك في المطعم والكافيه. سجّل الأوردرات والمشروبات، راقب تكلفة الخامات والهوامش، وتابع الخزنة لحظة بلحظة.',
    chips: ['بعت 4 قهوة تركي و2 لاتيه', 'تحليل الربحية والهوامش', 'توقع نفاد المخزون', 'ملخص اليوم'],
    examples: [
      'بعت 3 إسبريسو للعميل كريم',
      'اشتريت 10 كيلو بن برازيلي من المورد بـ4500',
      'تحليل الربحية والهوامش',
      'إيه وضع الخزنة والمخزون الناقص؟',
    ],
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
      ...CORE_SUPERPOWER_TOOLS,
    ],
    units: ['cup', 'plate', 'piece', 'kg', 'liter'],
    features: { expiry: true, grams: true, memberships: false, sessions: false },
  },
  clinic: {
    key: 'clinic',
    label: 'وضع العيادة والمركز الطبي',
    shortLabel: 'عيادة طبية',
    description: 'كشوفات وجلسات، متابعة مرضى، مستلزمات طبية، وخزنة العيادة',
    icon: 'pill',
    headerLabel: 'كشوفات وجلسات ومستلزمات',
    welcome:
      'أهلاً يا دكتور! أنا وكيل، مساعدك الإداري والمالي في العيادة. بسجّل الكشوفات والجلسات، بتابع حسابات المرضى والمستلزمات الطبية والخزنة.',
    chips: ['سجل كشف جديد', 'تحصيل 400 من مريض', 'إيه وضع الخزنة؟', 'المستلزمات الناقصة'],
    examples: [
      'بعت كشف استشارة للمريض أحمد',
      'سجّل مصروف مستلزمات تعقيم 350 ج',
      'ملخص اليوم ووضع الخزنة',
      'المديونيات المستحقة عند المرضى',
    ],
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
      ...CORE_SUPERPOWER_TOOLS,
    ],
    units: ['visit', 'session', 'box', 'piece'],
    features: { expiry: true, grams: false, memberships: true, sessions: true },
  },
  electronics: {
    key: 'electronics',
    label: 'وضع الإلكترونيات والصيانة',
    shortLabel: 'إلكترونيات وصيانة',
    description: 'أجهزة وإكسسوارات وقطع غيار وصيانة وضمان',
    icon: 'basket',
    headerLabel: 'أجهزة وقطع غيار وصيانة',
    welcome:
      'أهلاً يا هندسة! أنا وكيل، موظفك في معرض الإلكترونيات ومركز الصيانة. بسجّل المبيعات والصيانات وقطع الغيار، وبحسبلك الربحية والعملاء.',
    chips: ['بعت شاحن أصلي وتركيب اسكرينة', 'تحليل الربحية والهوامش', 'توقع نفاد المخزون', 'إيه وضع الخزنة؟'],
    examples: [
      'بعت 2 سماعة بلوتوث للعميل محمود',
      'اشتريت 10 شاشات غيار من المورد',
      'تحليل الربحية والهوامش',
      'المخزون الناقص والمديونيات',
    ],
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
      ...CORE_SUPERPOWER_TOOLS,
    ],
    units: ['piece', 'box', 'hour'],
    features: { expiry: false, grams: false, memberships: false, sessions: false },
  },
  wholesale: {
    key: 'wholesale',
    label: 'وضع تجارة الجملة والمخازن',
    shortLabel: 'مخزن وجملة',
    description: 'بيع بالكرتونة والعبوة والطن، حسابات تجار وموردين، وآجل',
    icon: 'basket',
    headerLabel: 'توريدات وجملة وحسابات تجار',
    welcome:
      'أهلاً يا فندم! أنا وكيل، موظفك في مخزن الجملة. بتابع الطلبيات الكبيرة، حسابات التجار والآجل، الموردين، وسرعة دوران البضاعة.',
    chips: ['بعت 20 كرتونة زيت للتاجر', 'المديونيات عند التجار', 'توقع نفاد المخزون', 'تحليل الربحية والهوامش'],
    examples: [
      'بعت 15 كرتونة مكرونة للعميل الحاج سعيد',
      'تحصيل 5000 من الحاج سعيد',
      'اللي علينا للموردين واللي لينا بره',
      'تحليل الربحية وتوقع الطلبيات',
    ],
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
      ...CORE_SUPERPOWER_TOOLS,
    ],
    units: ['carton', 'pack', 'kg', 'piece', 'box'],
    features: { expiry: false, grams: false, memberships: false, sessions: false },
  },
  clothing: {
    key: 'clothing',
    label: 'وضع الملابس والأزياء',
    shortLabel: 'ملابس وأزياء',
    description: 'موديلات ومقاسات، بيع قطاعي وجملة، ومواسم وتصفيات',
    icon: 'sparkle',
    headerLabel: 'موديلات ومبيعات ومخزون',
    welcome:
      'أهلاً بيك! أنا وكيل، موظفك في أتيليه ومعرض الملابس. بتابع الموديلات والمبيعات والهوامش وحسابات المصانع والموردين.',
    chips: ['بعت 2 قميص كتان', 'تحليل الربحية والهوامش', 'توقع نفاد المخزون', 'ملخص اليوم'],
    examples: [
      'بعت جاكيت جينز للعميل عمر',
      'اشتريت 20 قطعة تيشيرت بولو من المصنع',
      'تحليل الربحية والهوامش',
      'إيه الأصناف اللي قربت تخلص؟',
    ],
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
      ...CORE_SUPERPOWER_TOOLS,
    ],
    units: ['piece', 'pack', 'meter'],
    features: { expiry: false, grams: false, memberships: false, sessions: false },
  },
}

export const VERTICAL_PRESET_LIST: VerticalDef[] = Object.values(VERTICALS)
export const VERTICAL_PRESETS: VerticalDef[] = VERTICAL_PRESET_LIST

/**
 * Dynamically resolves any business type string (preset or custom user-defined industry)
 * into a complete VerticalDef plugin descriptor.
 */
export function getVertical(type: string): VerticalDef {
  if (!type) return VERTICALS.supermarket
  const clean = type.trim()
  if (clean in VERTICALS) {
    return VERTICALS[clean as PresetVertical]
  }
  // Support custom:<label> or arbitrary Arabic/English vertical names
  const customLabel = clean.startsWith('custom:') ? clean.slice(7).trim() : clean
  const shortLabel = customLabel || 'نشاط مخصص'
  return {
    key: clean,
    label: `وضع ${shortLabel}`,
    shortLabel,
    description: `إدارة المبيعات والمشتريات والمخزون والحسابات لـ ${shortLabel}`,
    icon: 'sparkle',
    headerLabel: `${shortLabel} — إدارة ذكية متكاملة`,
    welcome: `أهلاً بيك! أنا وكيل، موظفك الذكي في «${shortLabel}». جاهز أسجّل المبيعات والمشتريات والمصروفات، أتابع المخزون والديون، وأحلل الربحية أو أضيف أي أصناف وقواعد جديدة لمجال شغلك.`,
    chips: ['ملخص اليوم ووضع الخزنة', 'تحليل الربحية والهوامش', 'توقع نفاد المخزون', 'المخزون الناقص'],
    examples: [
      'ملخص اليوم ووضع الخزنة',
      'تحليل الربحية والهوامش',
      'ضيف صنف جديد في الكتالوج',
      'المخزون الناقص والمديونيات',
    ],
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
      ...CORE_SUPERPOWER_TOOLS,
    ],
    units: ['piece', 'box', 'kg', 'gram', 'liter', 'session'],
    features: { expiry: true, grams: true, memberships: true, sessions: true },
  }
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
  cup: 'كوب',
  plate: 'طبق',
  visit: 'كشف',
  carton: 'كرتونة',
  pack: 'عبوة',
  meter: 'متر',
  hour: 'ساعة',
}

export function arUnit(u: string): string {
  return AR_UNITS[u] ?? u
}
