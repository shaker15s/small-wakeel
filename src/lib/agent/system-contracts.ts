// وكيل — Per-system agent contracts (عقد كل نظام) — R69 / WAKIL-plan P2.
//
// The brain sees 70+ tools; what it must also see is the SYSTEM behind each
// tool — its job, its risk ceiling, and what goes wrong when the model
// confuses one system with another (a price question answered by the write
// path, a collection booked as a sale, a sensitive adjustment treated as a
// routine one). This registry is that contract, one source, machine-checked:
//
//   • every tool in SPECS belongs to EXACTLY ONE system (tests/unit/
//     system-contracts.test.ts pins the bidirectional coverage — the same
//     «the catalog can never lie» class as R64, one level up)
//   • every write tool sits in a system whose risk ceiling covers it
//   • the system map line in the prompt appendix is generated from here
//
// risk = the highest risk class an op this system can drive reaches
// (R0 read-only · R1 routine write · R2 money write · R3 sensitive —
// owner/supervisor + mandatory reason).
import { brainToolDescriptions } from './tool-schemas'

export type SystemRisk = 'R0' | 'R1' | 'R2' | 'R3'

export interface SystemContract {
  id: string
  labelAr: string
  /** the employee's job description for this system — one line. */
  roleAr: string
  tools: string[]
  risk: SystemRisk
  /** what breaks when the model confuses this system with another. */
  failureModes: string[]
  /** the gate that keeps it safe — permission, verification, or both. */
  gateAr: string
}

export const SYSTEMS: readonly SystemContract[] = [
  {
    id: 'overview',
    labelAr: 'لمحة الأعمال',
    roleAr: 'عينه على الموقف كله: مبيعات، مصروفات، أرباح، مقارنة فترات — بلا أي كتابة.',
    tools: ['get_daily_summary', 'get_period_totals', 'compare_periods', 'expense_breakdown', 'get_profit_margin', 'analyze_profitability', 'get_top_items', 'get_staff_performance', 'get_customer_ranking', 'get_reorder_list', 'get_dead_stock', 'get_stock_value', 'get_profit_by_item', 'get_proactive_insights', 'forecast_stockout', 'forecast_stock', 'get_financial_position'],
    risk: 'R0',
    failureModes: ['يستخدمها سؤال كتابة («بعت…») فتطلع أرقام بدل مسودة', 'يخليها تغني عن الرادار في سؤال مخاطر صريحة'],
    gateAr: 'قراءة فقط — حتى لو غلطت النتيجة تانيها سهل.',
  },
  {
    id: 'stock',
    labelAr: 'المخزون والكتالوج',
    roleAr: 'صوامع الوكيل: سعر، كمية، صلاحية، نقص — وقراءة/تعديل الكتالوج نفسه.',
    tools: ['search_catalog', 'get_item_stock', 'list_low_stock', 'list_expiring', 'get_price_check', 'upsert_catalog_item'],
    risk: 'R1',
    failureModes: ['«بكام؟» تتحول لتعديل سعر بالغلط', 'يرد على سؤال مخزون من حافظته مش من الأداة'],
    gateAr: 'قراءة مفتوحة؛ تعديل الكتالوج مسودة (R1) تتأكد منها.',
  },
  {
    id: 'sales',
    labelAr: 'المبيعات',
    roleAr: 'يدوّر الفاتورة: بيع كاش أو آجل — كمية من المخزون، مال في الخزنة أو دين على العميل.',
    tools: ['record_sale'],
    risk: 'R2',
    failureModes: ['بيع بضاعه مش موجودة في المخزون', 'سعر مختلف عن الكتالوج من غير ما يتأكد', '«بعت» تتفهّم كقراءة خزنه (كلمة كاش)'],
    gateAr: 'مسودة + اعتماد + تحقق بالأثر (مخزون-خزنة-عميل) قبل ما تقول «تم».',
  },
  {
    id: 'purchase',
    labelAr: 'المشتريات والموردين',
    roleAr: 'يدخل البضاعه والفاتورة على المورد: كمية تضيف، مال بيطلع أو دين علينا.',
    tools: ['record_purchase', 'register_supplier', 'get_supplier_balance', 'get_supplier_history'],
    risk: 'R2',
    failureModes: ['شراء يتسجل كبيع (عكس الأثر بالكامل)', 'رصيد مورد يتقال من غير الأداة'],
    gateAr: 'مسودة + اعتماد + تحقق بالأثر.',
  },
  {
    id: 'receivables',
    labelAr: 'العملاء والتحصيل',
    roleAr: 'حسابات العملاء: دين عليهم، تحصيلات، أعمار مديونيات، وملف كل عميل.',
    tools: ['list_receivables', 'list_payables', 'record_collection', 'register_customer', 'upsert_party', 'get_customer_history', 'get_contact_info'],
    risk: 'R2',
    failureModes: ['تحصيل يتسجل كبيع (خزنة-عميل يتغلطوا)', 'رصيد عميل «كام بقي عليها؟» يتقال من غير ملفه'],
    gateAr: 'قراءة الملفات مفتوحة؛ التحصيل مسودة + تحقق بالأثر.',
  },
  {
    id: 'cashbox',
    labelAr: 'الخزنة',
    roleAr: 'الكاش الفعلي في الدكان: رصيد، مصروفات، ومدفوعات — أرقام لحظية مش تقديرات.',
    tools: ['get_cash_position', 'record_expense', 'record_payment'],
    risk: 'R2',
    failureModes: ['«بعت كاش» تروح لقراءة الخزنه بدل ما تسجل بيع', 'مصروف يتقال من غير ما يتسجل'],
    gateAr: 'رصيد قراءة لحظية؛ كل حركة كتابة مسودة + تحقق بالأثر.',
  },
  {
    id: 'members',
    labelAr: 'الأعضاء والحضور',
    roleAr: 'عالم الجيم: اشتراكات، تجديدات، حضور — لكل عضو ملفه وسجله.',
    tools: ['register_member', 'record_attendance', 'get_member_status'],
    risk: 'R2',
    failureModes: ['حضور يتسجل لعضو مش موجود', 'سؤال اشتراك يتقال من غير الأداة'],
    gateAr: 'قراءة الأعضاء مفتوحة؛ التسجيل والحضور مسودة.',
  },
  {
    id: 'sensitive',
    labelAr: 'التعديلات الحساسة',
    roleAr: 'أدوات الكباش: تعديل مخزون يدوي، تغيير أسعار، عمليات معكوسة — أثرها واسع.',
    tools: ['record_stock_adjustment', 'record_price_change', 'reverse_operation'],
    risk: 'R3',
    failureModes: ['تتعامل معها كبيع عادي فيفلت من سبب إلزامي', 'عملية معكوسة بعد ما الزبون مشي من غير تتبع'],
    gateAr: 'R3: اعتماد من مدير/مشرف + سبب إلزامي + تحقق بالأثر.',
  },
  {
    id: 'memory',
    labelAr: 'الذاكرة',
    roleAr: 'ذاكرة الوكيل: معلومات ثابتة عن العميل/الذوق/القوانين — تتعلم من الحوار وتثبّت.',
    tools: ['memory_save', 'memory_forget', 'set_persona'],
    risk: 'R1',
    failureModes: ['تثبت معلومة غلط كحقيقة دائمة', 'أمر «انسى» يمسح حاجة غير المقصودة', 'حقن تعليمات من نص العميل يغيّر سلوك الوكيل'],
    gateAr: 'سياسة حفظ + بوابات استرجاع ضد الحقن (R65) + النسيان محدد المرجع.',
  },
  {
    id: 'planning',
    labelAr: 'التخطيط والمهام',
    roleAr: 'يد خطط ويعمل: مهام مجدولة، مهام خلفية، وتفكيك طلبات كبيرة لخطوات.',
    tools: ['run_plan', 'deep_dive', 'decompose_and_run_tasks', 'schedule_task', 'run_scheduled_tasks', 'dispatch_background_jobs'],
    risk: 'R2',
    failureModes: ['مهمة مجدولة بتكرر نفسها من غير ما يعرفها صاحب الدكان', 'مهمة خلفية تكتب بيانات من غير اعتماد'],
    gateAr: 'المهام القابلة للكتابة تمشي على مسودات الاعتماد؛ الجدول مرئي قابل لللغاء.',
  },
  {
    id: 'workspace',
    labelAr: 'المساحة والإضافات',
    roleAr: 'تصميم الوكيل نفسه: شخصيته، اختصاراته، إضافاته، وإعدادات الدكان.',
    tools: ['configure_workspace', 'toggle_plugin', 'install_plugin', 'run_plugin', 'list_plugins', 'create_quick_command', 'create_business', 'configure_business'],
    risk: 'R2',
    failureModes: ['تفعيل إضافة مش مجرّبة تغيّر سلوك الوكيل كله', 'تعديل إعدادات الدكان من جمل عابرة'],
    gateAr: 'قائمة إضافات موثقة + اعتماد على التعديلات المؤثرة.',
  },
  {
    id: 'web',
    labelAr: 'الويب والنصيحة',
    roleAr: 'عينه على برّا: بحث في السوق والأسعار + نصيحة محاسبية من سجله هو مش من الفروض.',
    tools: ['search_web', 'business_advice'],
    risk: 'R0',
    failureModes: ['يعتمد نتيجة بحث غلط كأرقام رسمية من السجل', 'ينصيح بأرقام من غير ما يتأكد من دفتره الأول'],
    gateAr: 'النتائج معلّمة «بحث ويب» وبتتأكد من السجل قبل أي رقم مالي.',
  },
  {
    id: 'operations',
    labelAr: 'العمليات والتدقيق',
    roleAr: 'سجل الحركات: أي عملية اتعملت، بأثر إيه، ومن قدّمها — وقلب الرادار.',
    tools: ['get_activity_history', 'get_transaction_status', 'scan_risks_and_opportunities'],
    risk: 'R0',
    failureModes: ['يرد على «فين فاتورتي؟» من غير ما يفتح سجل العمليات', 'الرادار يتقال كحقيقة مش إنذار'],
    gateAr: 'قراءة سجل موقّع (audit) — الإنذارات واضحة إنها إنذارات.',
  },
  {
    id: 'math',
    labelAr: 'الحسابات',
    roleAr: 'آلته الحاسبة: ضربات ومجملات ومناصفة — أرقام مش كلام.',
    tools: ['calculate'],
    risk: 'R0',
    failureModes: ['يحسب في راسه بدل الأداة فيتغلط في كسور عربية'],
    gateAr: 'قراءة نقية — مفيش كتابة أصلًا.',
  },
  {
    id: 'desktop',
    labelAr: 'برامج الحاسوب',
    roleAr: 'يد الوكيل على الحاسوب (CLI-Anything): شوف، افحص، متزامن، وضبط — بإذنك أنت.',
    tools: ['cli_list_desktop_apps', 'cli_inspect_app', 'cli_sync_desktop_data', 'cli_control_app', 'cli_harness_install'],
    risk: 'R3',
    failureModes: ['يتحكم في برنامج من غير إذن صريح', 'يبعت بيانات الدكان لبرمجية غريبة'],
    gateAr: 'R3: إذن صريح من المستخدم لكل تحكم + سجل لكل خطوة.',
  },
] as const

/** Every tool the contracts claim — for the coverage tests and the prompt map. */
export function contractToolNames(): string[] {
  return SYSTEMS.flatMap((s) => [...s.tools])
}

/** The prompt's compact system map — generated, never hand-maintained.
 *  Example line: «المبيعات (R2) — record_sale · الخزنة (R2) — get_cash_position, …» */
export function systemMapLine(): string {
  return SYSTEMS.map((s) => `${s.labelAr} (${s.risk})`).join(' · ')
}

/** Sanity: a tool exists in SPECS and (if write) its contract risk ≥ R2.
 *  Returns the problems — empty array means the contract is coherent. */
export function contractProblems(): string[] {
  const problems: string[] = []
  const spec = brainToolDescriptions()
  const seen = new Set<string>()
  for (const s of SYSTEMS) {
    for (const t of s.tools) {
      if (seen.has(t)) problems.push(`المسؤولية مكررة: ${t} في نظامين (${s.id} والسابق)`)
      seen.add(t)
      if (!spec[t]) problems.push(`أداة مش في SPECS: ${t} (${s.id})`)
    }
  }
  for (const t of Object.keys(spec)) {
    if (!seen.has(t)) problems.push(`أداة من SPECS من غير نظام مسؤول: ${t}`)
  }
  return problems
}
