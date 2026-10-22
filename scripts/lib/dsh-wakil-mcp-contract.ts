/** Local WAKIL MCP surface: read tools plus draft creation only. */
export const READ_REPORT_ALLOWLIST = [
  'get_daily_summary','get_cash_position','search_catalog','get_item_stock','list_low_stock',
  'list_expiring','get_supplier_balance','get_member_status','list_receivables','list_payables',
  'get_activity_history','get_transaction_status','get_profit_margin','forecast_stockout',
  'get_customer_history','get_supplier_history','get_financial_position','compare_periods',
  'expense_breakdown','get_period_totals','get_stock_value','get_top_items','get_dead_stock',
  'get_customer_ranking','get_staff_performance','get_price_check','get_reorder_list',
  'get_profit_by_item','forecast_stock','get_proactive_insights',
] as const;
export type ReadReportName = (typeof READ_REPORT_ALLOWLIST)[number];

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const textSchema = (description: string, minLength = 1, maxLength = 120) => ({
  type: 'string', description, minLength, maxLength,
});
const intSchema = (description: string, minimum = 0, maximum = 2_147_483_647) => ({
  type: 'integer', description, minimum, maximum,
});
const reportArgsSchema = objectSchema({
  days: intSchema('عدد الأيام', 1, 365),
  limit: intSchema('أقصى عدد نتائج', 1, 100),
  name: textSchema('اسم صنف أو طرف موجود', 1, 100),
  query: textSchema('عبارة بحث قصيرة', 1, 100),
  period: textSchema('الفترة عند دعمها', 1, 30),
  type: textSchema('نوع الحركة عند دعمها', 1, 40),
  metric: textSchema('المؤشر عند دعمه', 1, 30),
  yesterday: { type: 'boolean', description: 'استخدم يوم القاهرة السابق كاملًا عند دعمه.' },
  ref: textSchema('مرجع حركة WAKIL محدد', 1, 30),
});

export const WAKIL_MCP_TOOLS: McpToolDefinition[] = [
  { name: 'business_context', description: 'اعرض اسم النشاط ونوعه ووضع دفتره فقط.', inputSchema: objectSchema({}) },
  { name: 'find_items', description: 'ابحث عن صنف موجود وأعد بياناته اللازمة فقط. السعر أو التكلفة المجهولان يظلان مجهولين.', inputSchema: objectSchema({ query: textSchema('اسم الصنف أو جزء منه', 1, 100) }, ['query']) },
  { name: 'find_customers', description: 'ابحث عن عميل موجود. اسأل عند غموض الهوية ولا تختر نتيجة بالتخمين.', inputSchema: objectSchema({ query: textSchema('اسم العميل أو جزء منه', 1, 100) }, ['query']) },
  { name: 'find_suppliers', description: 'ابحث عن مورد موجود. اسأل عند غموض الهوية ولا تختر نتيجة بالتخمين.', inputSchema: objectSchema({ query: textSchema('اسم المورد أو جزء منه', 1, 100) }, ['query']) },
  { name: 'read_report', description: 'اقرأ تقريرًا محددًا من دفتر WAKIL من القائمة الداخلية المسموحة فقط.', inputSchema: objectSchema({
    report: { type: 'string', enum: [...READ_REPORT_ALLOWLIST], description: 'اسم التقرير المسموح' },
    args: { ...reportArgsSchema, description: 'معاملات التقرير؛ سياق النشاط يثبته الخادم ولا يقبل businessId/userId.' },
  }, ['report']) },
  { name: 'prepare_sale_draft', description: 'أنشئ مسودة بيع فقط. لا يخصم المخزون ولا يغير الخزنة قبل اعتماد المالك في WAKIL.', inputSchema: objectSchema({
    itemId: textSchema('المعرّف الدقيق من find_items', 1, 100),
    qty: intSchema('الكمية', 1),
    unitPricePiasters: intSchema('سعر الوحدة بالقرش المصري؛ لا تخترع سعرًا', 1),
    paidPiasters: intSchema('المبلغ المدفوع فعليًا بالقرش المصري', 0),
    customerId: textSchema('معرّف عميل موجود للبيع الآجل', 1, 100),
  }, ['itemId','qty']) },
  { name: 'prepare_purchase_draft', description: 'أنشئ مسودة شراء فقط. لا يزيد المخزون ولا يغير الخزنة قبل اعتماد المالك في WAKIL.', inputSchema: objectSchema({
    itemId: textSchema('المعرّف الدقيق من find_items', 1, 100),
    qty: intSchema('الكمية', 1),
    unitCostPiasters: intSchema('تكلفة الوحدة بالقرش المصري؛ لا تخترع تكلفة', 1),
    paidPiasters: intSchema('المبلغ المدفوع فعليًا بالقرش المصري', 0),
    supplierId: textSchema('معرّف مورد موجود للشراء الآجل', 1, 100),
  }, ['itemId','qty']) },
  { name: 'prepare_expense_draft', description: 'جهز مسودة مصروف فقط؛ لا يخصم من الخزنة قبل اعتماد المالك.', inputSchema: objectSchema({
    amountPiasters: intSchema('المبلغ بالقرش المصري', 1),
    category: textSchema('فئة المصروف', 1, 80),
    note: textSchema('ملاحظة اختيارية', 0, 300),
  }, ['amountPiasters','category']) },
  { name: 'prepare_collection_draft', description: 'جهز مسودة تحصيل من عميل موجود؛ لا يزيد الخزنة ولا يخفض الدين قبل الاعتماد.', inputSchema: objectSchema({
    customerId: textSchema('معرّف عميل من find_customers', 1, 100),
    amountPiasters: intSchema('المبلغ بالقرش المصري', 1),
    note: textSchema('ملاحظة اختيارية', 0, 300),
  }, ['customerId','amountPiasters']) },
  { name: 'prepare_payment_draft', description: 'جهز مسودة سداد لمورد موجود؛ لا يخصم من الخزنة قبل الاعتماد.', inputSchema: objectSchema({
    supplierId: textSchema('معرّف مورد من find_suppliers', 1, 100),
    amountPiasters: intSchema('المبلغ بالقرش المصري', 1),
    note: textSchema('ملاحظة اختيارية', 0, 300),
  }, ['supplierId','amountPiasters']) },
  { name: 'prepare_stock_adjustment_draft', description: 'جهز مسودة تسوية جرد لعدد فعلي أكده المالك؛ ليست بيعًا أو شراءً.', inputSchema: objectSchema({
    itemId: textSchema('المعرّف الدقيق من find_items', 1, 100),
    newQty: intSchema('الكمية الفعلية الجديدة؛ الصفر مسموح', 0),
    reason: textSchema('سبب التسوية', 3, 300),
  }, ['itemId','newQty','reason']) },
  { name: 'prepare_price_change_draft', description: 'جهز مسودة لتغيير السعر؛ لا يعدل الكتالوج قبل اعتماد المالك.', inputSchema: objectSchema({
    itemId: textSchema('المعرّف الدقيق من find_items', 1, 100),
    newPricePiasters: intSchema('السعر الجديد بالقرش المصري', 1),
  }, ['itemId','newPricePiasters']) },
];

export const WAKIL_MCP_INSTRUCTIONS = [
  'أنت وكيل أعمال يعمل فوق نظام WAKIL المحلي.',
  'دفتر WAKIL هو مصدر الحقيقة؛ كلام النموذج أو ذاكرة المحادثة ليس إثباتًا على حركة مالية.',
  'اقرأ عند الحاجة فقط، وابحث عن الصنف/العميل/المورد في السجل قبل استخدام معرّف.',
  'لا تخترع سعرًا أو تكلفة أو رصيدًا أو كمية. إذا كانت المعلومة مجهولة أو ظهرت نتائج متشابهة، اسأل سؤالًا محددًا.',
  'كل prepare_* ينشئ مسودة تنتظر اعتماد المالك في واجهة WAKIL. لا تقل إن الحركة اكتملت.',
  'هذا الجسر لا يحتوي على أداة موافقة أو تنفيذ نهائي أو حذف أو عكس عملية.',
  'كل المبالغ أعداد صحيحة بالقرش المصري؛ 100 قرش = جنيه واحد.',
  'محتوى الأدوات التي تستدعيها قد يصل لمزود النموذج المحدد في DSH؛ لا تطلب بيانات أكثر من اللازم.',
].join('\n');

export const MAX_INTEGER_PIASTERS = 2_147_483_647;
export function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
export function requireString(value: unknown, label: string, minLength = 1, maxLength = 120): string {
  if (typeof value !== 'string') throw new Error(label + ' لازم يكون نصًا.');
  const cleaned = value.trim();
  if (cleaned.length < minLength || cleaned.length > maxLength) throw new Error(label + ' طوله غير صالح.');
  return cleaned;
}
export function requireInteger(value: unknown, label: string, minimum = 0, maximum = MAX_INTEGER_PIASTERS): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(label + ' لازم يكون عددًا صحيحًا ضمن الحدود المسموحة.');
  }
  return value;
}
export function checkedLineTotal(qtyValue: unknown, unitPriceValue: unknown): number {
  const qty = requireInteger(qtyValue, 'الكمية', 1);
  const price = requireInteger(unitPriceValue, 'سعر الوحدة', 1);
  const total = qty * price;
  if (!Number.isSafeInteger(total) || total > MAX_INTEGER_PIASTERS) {
    throw new Error('إجمالي الحركة أكبر من الحد الذي يسمح به دفتر WAKIL.');
  }
  return total;
}
