# دليل أدلة الإطلاق — WAKIL

هذا الدليل يميز بين **نجاح فحوص الكود** وبين السماح بتشغيل المال الحقيقي. لا تُعتبر ملفات التقرير أو أسماء الاختبارات وحدها دليل نجاح.

## 1. فحص الكود المستضاف

Workflow: `.github/workflows/ci.yml`. كل تشغيل يحفظ `ci.log` و`pilot-gate.json` وبيانات SHA/Run ID في Artifact اسمه `wakil-validation-<sha>-<run-id>`.

بعد تشغيل GitHub Actions، تحقّق أن الـrun على SHA المقصود انتهى `success` وأن الـArtifact لنفس رقم التشغيل موجود. لا يمكن للـrun أن يثبت نجاحه النهائي من داخله؛ لذلك مرّر الدليل بعد انتهاء التشغيل عبر `WAKIL_HOSTED_CI_EVIDENCE` في ملف JSON خارجي:
```json
{
  "targetSha": "<exact SHA tested>",
  "workflow": "WAKIL CI",
  "conclusion": "success",
  "runId": "<GitHub Actions run ID as a string>",
  "runUrl": "https://github.com/<owner>/<repo>/actions/runs/<run-id>",
  "artifactName": "wakil-validation-<exact-sha>-<run-id>",
  "artifactSha256": "<64 hex chars of downloaded artifact archive>",
  "completedAt": "<ISO-8601 timestamp>"
}
```
نزّل الـArtifact واحسب بصمته الفعلية، ولا تستخدم القيم التمثيلية أعلاه. يجب أن يطابق التقرير SHA وRun ID نفسهما. نجاح CI لا يعني أن حالة إطلاق SaaS أصبحت GO.

## 2. قبول الموديل الحي

شغّل على جهاز/runner آمن ذي اتصال خارجي:
```bash
WAKIL_ACCEPTANCE_BASE_URL=https://generativelanguage.googleapis.com/v1beta
WAKIL_ACCEPTANCE_API_KEY=<secret>
WAKIL_ACCEPTANCE_MODELS=<model-ids>
node scripts/model-acceptance.mjs --report /secure/path/model-acceptance.json
```

يلزم إعداد متغيرات البيئة الحقيقية في الـshell أو Secret Store؛ لا تضع المفتاح في Git أو في ملف التقرير. يجب أن تكون نتيجة التقرير `environment: live` و`liveAcceptance: true`. لا تُذكر تكلفة مالية مقدرة إلا إذا أعاد المزود أعداد التوكنز؛ غير ذلك يظهر `n/a`. نموذج mock يثبت عقد الأداة فقط ولا يعتبر قبولًا حيًا.

## 3. دليل تدقيق أمني مستقل

بعد تدقيق مستقل على SHA المراد إطلاقه، ضع ملف JSON خارج المستودع ومرّر مساره في `WAKIL_SECURITY_AUDIT_EVIDENCE`. يجب أن يحتوي:
```json
{
  "targetSha": "<exact release SHA reviewed>",
  "independent": true,
  "result": "pass",
  "auditor": "<independent auditor / firm>",
  "completedAt": "<ISO-8601 timestamp>",
  "reportSha256": "<64 hex chars of the full audit report>"
}
```

لا تضع التقرير الأمني الحساس داخل الريبو العام؛ احفظه في تخزين خاص مضبوط الصلاحيات. يجب أن توجد أيضًا `docs/PRIVACY.md` و`docs/TERMS.md`.

## 4. قياس السعة

بعد اختبار حمل قابل للتكرار على بيئة شبيهة بالإنتاج، مرّر ملف JSON خارجيًا عبر `WAKIL_CAPACITY_EVIDENCE`:
```json
{
  "targetSha": "<exact release SHA tested>",
  "environment": "production-like",
  "result": "pass",
  "totalRequests": 1000,
  "concurrency": 10,
  "p95Ms": 800,
  "p99Ms": 1400,
  "errorRatePct": 0,
  "measuredAt": "<ISO-8601 timestamp>",
  "reportSha256": "<64 hex chars of benchmark report>"
}
```

الأرقام أعلاه مثال على **شكل الحقول فقط** وليست قياسات WAKIL أو حدود أداء معتمدة. لا تُدخلها كما هي. يجب أن تلخّص هذه القيم تقريرًا حقيقيًا قابلًا للمراجعة لنفس SHA؛ معدل الأخطاء المقبول في بوابة الإصدار لا يتجاوز 1%.

## 5. استعادة النسخ وتدوير الأسرار

بعد تجربة استعادة كاملة في بيئة شبيهة بالإنتاج وتدوير المفاتيح مع التحقق من قابلية فك الأسرار المطلوبة، مرّر ملف دليل خارجي في `WAKIL_RECOVERY_EVIDENCE`:
```json
{
  "targetSha": "<exact release SHA verified>",
  "environment": "production-like",
  "result": "pass",
  "backupRestore": { "passed": true },
  "secretRotation": { "passed": true },
  "measuredAt": "<ISO-8601 timestamp>",
  "reportSha256": "<64 hex chars of test report>"
}
```

الاختبارات الاصطناعية المحلية مهمة، لكنها لا تثبت وحدها أن التخزين والنسخ والاستعادة آمنة في البيئة الإنتاجية.

## 6. تشغيل بوابة الإطلاق

`node scripts/pilot-gate.mjs --report pilot-gate.json` يولّد تقريرًا حتى إن كانت النتيجة `NO-GO`. استخدم `--strict` عندما تريد أن ينتهي الأمر برمز فشل ما لم تتوافر كل أدلة الإطلاق. لا تستخدم `GO_CANDIDATE` بديلًا عن موافقة الإصدار الموثقة من المالك.
