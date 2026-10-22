# WAKIL × DeepSeek Harness (MCP) — دليل التوصيل المحلي

**الحالة:** تكامل محلي أولي. لا يعني هذا اعتماد WAKIL للإنتاج.

## ما الذي تضيفه الحزمة؟
- Agent Preset باسم \`wakil\` في DeepSeek Harness الرسمي.
- اتصال MCP محلي عبر \`stdio\`.
- تقارير من سجل WAKIL، والبحث عن صنف/عميل/مورد موجود.
- أدوات \`prepare_*_draft\` تنشئ مسودات فقط.

لا توجد أداة اعتماد أو تنفيذ نهائي أو حذف أو عكس عملية. الاعتماد النهائي يبقى في واجهة WAKIL بعد مراجعة المالك.

## متطلبات قبل البدء
1. استخدم Profile منفصلًا في DSH مخصصًا لوكيل.
2. قاعدة WAKIL يجب أن تكون SQLite محلية مستقلة خارج مجلد السورس وموجودة ومهيأة بالترحيلات، وبها نشاط ومالك موجود.
3. **لا تستخدم \`db/custom.db\`**؛ هذه قاعدة عرض اصطناعية متتبعة في Git.
4. متغيرات البيئة أدناه تُمرر إلى العملية عند تشغيل DSH؛ لا تشارك مفاتيح مزود النموذج ولا تحفظ الأسرار في Git.
5. نتائج الأدوات المطلوبة قد تصل إلى مزود النموذج بحسب إعدادات DSH. لا تستخدم بيانات حقيقية قبل مراجعة الخصوصية والأمان.

## إعداد PowerShell على Windows
عدّل القيم للمسارات والمعرّفات الفعلية لديك:

\`\`\`powershell
$env:WAKIL_HOME = 'C:\\Path\\To\\small-wakeel'
$env:WAKIL_DATABASE_URL = 'file:C:/WAKIL-data/wakil.db'
$env:WAKIL_DSH_MCP_ENABLE = '1'
$env:WAKIL_DSH_BUSINESS_ID = 'PUT_REAL_BUSINESS_ID_HERE'
$env:WAKIL_DSH_USER_ID = 'PUT_REAL_OWNER_USER_ID_HERE'
# اختياري لو Bun غير موجود في PATH الخاص بعملية DSH:
# $env:WAKIL_BUN_PATH = 'C:\\Users\\YOUR_USER\\.bun\\bin\\bun.exe'
dsh --profile wakil
\`\`\`

يجب أن تكون قاعدة \`wakil.db\` موجودة فعليًا خارج checkout. لا يُنشئ الجسر قاعدة فارغة أو يخمّن معرّفات النشاط والمالك. افتح DSH من نفس PowerShell حتى يرث المتغيرات.

داخل Creator Mode / Plugin Manager، ثبّت الحزمة المحلية من مجلد \`integrations/dsh-wakil\` باستخدام \`install_bundle\`. افتح جلسة جديدة واختر Agent Preset **وكيل — موظف أعمالك**. توثيق DSH يوضح أن Presets تخص الجلسات الجديدة وليست حدود عزل أمنية.

## الأدوات المتاحة
- \`business_context\`
- \`find_items\`, \`find_customers\`, \`find_suppliers\`
- \`read_report\` (قائمة تقارير WAKIL داخلية)
- \`prepare_sale_draft\`, \`prepare_purchase_draft\`
- \`prepare_expense_draft\`, \`prepare_collection_draft\`, \`prepare_payment_draft\`
- \`prepare_stock_adjustment_draft\`, \`prepare_price_change_draft\`

كل المبالغ أعداد صحيحة بالقرش المصري. السعر أو التكلفة المجهولان لا يتحولان إلى صفر. الطرف الملتبس لا يُختار بالتخمين.

## اختبار العقد
من جذر WAKIL:
\`\`\`powershell
bun test tests/unit/dsh-wakil-mcp-protocol.test.ts
\`\`\`
الخادم نفسه يستخدم stdout حصريًا لإطارات JSON-RPC؛ سجلاته تذهب إلى stderr. لا تتوقع مخرجات بشرية عند تشغيل الأمر \`bun run dsh:mcp\` يدويًا لأنه ينتظر رسائل MCP من stdin.

## حدود V1
- مالك النشاط المحلي فقط.
- مسودات فقط؛ لا اعتماد أو تنفيذ نهائي من DSH.
- لا صوت/ASR حي ولا رفع ملفات عبر هذا الجسر.
- لا يثبت التكامل وحده جاهزية DSH أو WAKIL للإنتاج.
