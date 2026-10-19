// وكيل — Native tool-calling schemas (معمارية DeepSeek-Harness: «كل حاجة أداة»).
//
// The model-facing capability surface is ONE typed registry. This module turns
// it into the OpenAI-compatible `tools` array so ANY provider that supports
// function calling (OpenAI, DeepSeek, OpenRouter, vLLM, the local mock) gets
// the real schema — the model then picks the tool, exactly like dsh's
// ctx.tools registration whose schemas join prompt assembly.
//
// Providers without native tool support keep the JSON-in-text emulation
// protocol (parseBrainReply) — the harness is identical either way, because
// native tool_calls are normalized back into the canonical
// `{"tool_calls":[{"tool","args"}]}` text contract.

export interface BrainToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

type ParamType = 'string' | 'number' | 'boolean' | 'array'

const P = (props: Record<string, ParamType>, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties: Object.fromEntries(Object.entries(props).map(([k, t]) => [k, { type: t }])),
  required,
  additionalProperties: true,
})

const NONE: Record<string, unknown> = { type: 'object', properties: {}, additionalProperties: false }

/** name → (use-when line, parameter schema). One source of truth for both the
 *  native schema and the prompt's tool catalog. */
const SPECS: Record<string, [string, Record<string, unknown>]> = {
  // ---------- القراءات من السجل (eyes) ----------
  get_daily_summary: ['ملخص اليوم: المبيعات والمصروفات والحركات. استخدمه في «ملخص النهارده».', P({ period: 'string' })],
  get_cash_position: ['رصيد الخزنة الكاش دلوقتي. «الخزنة كام؟».', NONE],
  search_catalog: ['بحث في أصناف الكتالوج بالاسم أو جزء منه. «بكام؟ / السعر».', P({ query: 'string' }, ['query'])],
  get_item_stock: ['رصيد صنف معين في المخزون. «عندي كام؟ / فاضل كام؟».', P({ name: 'string' }, ['name'])],
  list_low_stock: ['قائمة الأصناف تحت حد النقص.', P({ limit: 'number' })],
  list_expiring: ['الصلاحيات والقرب من الانتهاء (أصناف/عضويات).', P({ days: 'number', limit: 'number' })],
  get_supplier_balance: ['رصيد حساب مورد: متبقّي له كام.', P({ name: 'string' }, ['name'])],
  get_member_status: ['حالة عضو/اشتراك معين (باقي قد إيه). سؤال عن عضو بالاسم.', P({ name: 'string' }, ['name'])],
  list_receivables: ['اللي ليا عند العملاء (مديونيات). «مين عليه كام؟».', P({ limit: 'number' })],
  list_payables: ['اللي عليا للموردين. «اللي علينا؟».', P({ limit: 'number' })],
  get_activity_history: ['آخر الحركات والعمليات في السجل.', P({ limit: 'number' })],
  get_transaction_status: ['حالة عملية معينة بالمرجع.', P({ ref: 'string' }, ['ref'])],
  get_profit_margin: ['هامش الربح على صنف أو الكل في فترة.', P({ name: 'string', days: 'number' })],
  forecast_stockout: ['متى هينفد الصنف بمعدل البيع الحالي.', P({ name: 'string' }, ['name'])],
  get_customer_history: ['ملف العميل: عملياته وسجله في فترة.', P({ name: 'string', days: 'number' })],
  compare_periods: ['مقارنة فترتين (هالشهر بالشهر اللي فات).', P({ days: 'number' })],
  expense_breakdown: ['تفصيل المصروفات على فئاتها.', P({ days: 'number', limit: 'number' })],
  get_period_totals: ['إجماليات فترة (بعت كام/حصّلت كام في آخر N يوم).', P({ days: 'number', type: 'string' })],
  get_stock_value: ['قيمة المخزون الحالي بالدخل.', NONE],
  get_top_items: ['أفضل الأصناف مبيعًا في فترة.', P({ days: 'number', limit: 'number' })],
  get_dead_stock: ['أصناف راكدة متباعتش فترة.', P({ days: 'number', limit: 'number' })],
  get_customer_ranking: ['ترتيب العملاء حسب التعامل.', P({ limit: 'number' })],
  get_staff_performance: ['أداء العاملين (مبيعات/حضور) في فترة.', P({ days: 'number' })],
  get_price_check: ['سعر صنف حالي مقابل تاريخه (تغييرات).', P({ name: 'string' }, ['name'])],
  get_reorder_list: ['قائمة إعادة الطلب حسب الاستهلاك.', P({ limit: 'number' })],
  get_profit_by_item: ['الربح صنف صنف في فترة.', P({ days: 'number', limit: 'number' })],
  search_web: ['بحث في الويب عن معلومة خارج السجل (أسعار سوق، أخبار).', P({ query: 'string' }, ['query'])],
  business_advice: ['قراءة تحليلية لنشاط الشغل ونصيحة عملية مبنية على السجل.', P({ question: 'string' })],
  analyze_profitability: ['تحليل الربحية والهوامش عبر الأصناف.', P({ days: 'number' })],
  forecast_stock: ['توقع نفاد المخزون لعدة أصناف.', P({ name: 'string', days: 'number' })],
  get_proactive_insights: ['نبض الشغل: تنبيهات واستبقات قبل ما يسأل.', NONE],
  // ---------- الكتابات (hands) — كلها مسودات محتاجة اعتماد ----------
  record_sale: ['مسودة بيع صنف (كمية وسعر). «بعت …».', P({ name: 'string', qty: 'number', price: 'number', paid: 'number', total: 'number', customer: 'string' }, ['name', 'qty'])],
  record_purchase: ['مسودة شراء بضاعة من مورد. «جبت/اشتريت …».', P({ name: 'string', qty: 'number', price: 'number', paid: 'number', total: 'number', supplier: 'string' }, ['name', 'qty'])],
  record_collection: ['مسودة تحصيل فلوس من عميل. «حصلت/قبضت من …».', P({ name: 'string', amount: 'number', note: 'string' }, ['name', 'amount'])],
  record_payment: ['مسودة سداد لمورد. «سددت/دفعت للمورد …».', P({ name: 'string', amount: 'number', note: 'string' }, ['name', 'amount'])],
  record_expense: ['مسودة مصروف (كهربا/إيجار/نقليات…). «صرفت …».', P({ amount: 'number', category: 'string', note: 'string' }, ['amount'])],
  register_member: ['مسودة اشتراك/عضوية جديدة أو تجديد.', P({ name: 'string', plan: 'string', months: 'number', amount: 'number', phone: 'string' }, ['name'])],
  record_attendance: ['تسجيل حضور/انتهاء حصة أو تدريب.', P({ name: 'string', type: 'string', note: 'string' }, ['name'])],
  record_stock_adjustment: ['تعديل مخزون يدوي (جرد/فاقد). «الجرد / عدّل مخزون».', P({ name: 'string', newQty: 'number', reason: 'string' }, ['name', 'newQty'])],
  record_price_change: ['تغيير سعر صنف في الكتالوج.', P({ name: 'string', newPrice: 'number' }, ['name', 'newPrice'])],
  register_customer: ['إضافة عميل جديد (اسم/تليفون/رصيد).', P({ name: 'string', phone: 'string', balance: 'number' }, ['name'])],
  register_supplier: ['إضافة مورد جديد (اسم/تليفون/رصيد).', P({ name: 'string', phone: 'string', balance: 'number' }, ['name'])],
  reverse_operation: ['إلغاء/عكس عملية سابقة بالمرجع.', P({ ref: 'string', reason: 'string' }, ['ref'])],
  upsert_catalog_item: ['إضافة أو تحديث صنف في الكتالوج (سعر/مخزون/وحدة).', P({ name: 'string', sellPrice: 'number', costPrice: 'number', stock: 'number', unit: 'string' }, ['name'])],
  upsert_party: ['إضافة أو تحديث عميل/مورد.', P({ name: 'string', kind: 'string', phone: 'string', balance: 'number' }, ['name'])],
  // ---------- الذاكرة والتفكير (mind) ----------
  memory_save: ['حفظ معلومة ثابتة عن الشغل أو العميل في ذاكرة طويلة المدى (عادة/تفضيل/قرار).', P({ key: 'string', value: 'string' }, ['key', 'value'])],
  memory_forget: ['مسح معلومة من الذاكرة.', P({ key: 'string' }, ['key'])],
  calculate: ['حساب حسابية (معادلة). «حسبلي …».', P({ expression: 'string' }, ['expression'])],
  run_plan: ['تنفيذ خطة قراءات متعددة الخطوات مرة واحدة (هدف + خطوات).', P({ goal: 'string', steps: 'array' }, ['goal'])],
  deep_dive: ['تحقيق عميق في سؤال مركّب: جمع سياق + أدوات + بحث ثم تحليل.', P({ question: 'string' }, ['question'])],
  decompose_and_run_tasks: ['تفكيك هدف كبير لمهام متوازية وتوزيعها على متخصصين.', P({ goal: 'string' }, ['goal'])],
  schedule_task: ['جدولة مهمة أو تذكير بوقت.', P({ title: 'string', when: 'string', kind: 'string' }, ['title'])],
  set_persona: ['تغيير نبرة الكلام (دافي/رسمي/مباشر).', P({ tone: 'string' }, ['tone'])],
  // ---------- نظام البلاجنز والعمل (body) ----------
  configure_workspace: ['تخصيص تفضيلات واجهة المستخدم.', P({ preferences: 'string' }, [])],
  toggle_plugin: ['تفعيل أو إيقاف إضافة (بلاجن).', P({ plugin: 'string', active: 'boolean' }, ['plugin'])],
  install_plugin: ['بناء وتثبيت بلاجن جديد من وصف بالعامية.', P({ goal: 'string' }, ['goal'])],
  run_plugin: ['تشغيل بلاجن مثبت.', P({ plugin: 'string' }, ['plugin'])],
  list_plugins: ['عرض البلاجنز المتاحة وحالتها.', NONE],
  create_quick_command: ['إضافة أمر سريع للواجهة.', P({ label: 'string', text: 'string' }, ['label', 'text'])],
  create_business: ['إنشاء منشأة جديدة.', P({ name: 'string', type: 'string' }, ['name'])],
  configure_business: ['تعديل إعدادات المنشأة.', P({ changes: 'string' }, [])],
  run_scheduled_tasks: ['تشغيل المهام المجدولة اللي مستحقة.', P({ scope: 'string' })],
  dispatch_background_jobs: ['تشغيل مهام خلفية متوازية.', P({ jobs: 'string' }, [])],
  scan_risks_and_opportunities: ['فحص استباقي للمخاطر والفرص في السجل.', NONE],
  // ---------- سطح الأجهزة والتطبيقات (CLI-Anything: كل برنامج له أوامر JSON) ----------
  cli_list_desktop_apps: ['فحص البرامج شغالة على الجهاز دلوقتي (إكسل، دفتارة، الأمين، الكاشير…) وحالتها.', NONE],
  cli_inspect_app: ['فحص عميق لتطبيق: شغال ولا لأ، ملفات البيانات وقاعدة بياناته المحلية.', P({ appName: 'string' }, ['appName'])],
  cli_sync_desktop_data: ['مطابقة بيانات تطبيق خارجي مع السجل (فحص فقط — الكتابة المالية محتاجة موصل موثّق).', P({ appName: 'string' }, ['appName'])],
  cli_control_app: ['تشغيل برنامج عبر سطح أوامره (نمط CLI-Anything). «إكسل» محركه حقيقي: list-recent/summary/read (read-only)/write. app = excel|daftra|ameen|easystore|quickbooks|browser. الناتج JSON موثّق.', P({ app: 'string', command: 'string', file: 'string', sheet: 'string', range: 'string', value: 'string', maxRows: 'number' }, ['app', 'command'])],
}

/** The OpenAI-compatible tools array for the brain. Stable order = stable
 *  prompt prefix (the catalog section is derived from the same SPECS). */
export function brainToolSchemas(): BrainToolSchema[] {
  return Object.entries(SPECS).map(([name, [desc, parameters]]) => ({
    type: 'function',
    function: { name, description: desc, parameters },
  }))
}

/** Number of tools the brain can call (used by the brain-audit line). */
export function brainToolCount(): number {
  return Object.keys(SPECS).length
}
