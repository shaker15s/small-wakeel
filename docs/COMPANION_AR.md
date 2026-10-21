# Companion — جسر القراءة من جهاز المالك (PR-011 / الخطة §10, P6)

## ما هذا
تطبيق محلي صغير **قراءة فقط** على جهاز المالك (ويندوز في الإنتاج — أي Node ≥18 في التطوير).
جسر موثوق بين الـ runtime السحابي والموارد التي سمح المالك بها صراحة: جذور مسارات + أوامر مثبتة.
**لا يوجد في الـ bridge أداة كتابة إطلاقًا** — الكتابة عبر برنامج خارجي مستوى موصل آخر
يتطلب approval engine (P1) وsandbox/preview/read-back خاصًا به.

## نموذج الثقة (كل بند مُختبر في `tests/integration/companion.test.ts`)
| الضمان | التنفيذ |
|---|---|
| اتصال صادر فقط | الـ bridge يفحص على HTTPS؛ لا يفتح أي منفذ inbound |
| enrollment | رمز قصير العمر (5 دقائق) استخدام واحد — يُخزن sha256 فقط |
| هوية جهاز قابلة للإبطال | token يُعرض مرة واحدة ويُخزن sha256؛ الإبطال فوري (403 + المهام المعلقة EXPIRED) |
| توقيع كل طلب | `HMAC(sha256(token), deviceId\|nonce\|ts\|sha256(body))` + نافذة 60 ثانية + nonce استخدام واحد |
| envelope موقعة | كل job موقعة: `jobId\|device\|tool\|args\|nonce\|expiresAt` — الـ bridge يرفض أي job غير مطابقة للتوقيع |
| allowlist صريحة | جذور مسارات + أوامر مثبتة بالضبط؛ تحقق مزدوج (سيرفر عند الجدولة + bridge محليًا) |
| لا shell إطلاقًا | CLI يعمل بـ `spawn(cmd, argv, {shell:false})` — argv يجب أن يكون قائمة؛ أي string مرفوض |
| لا path traversal / symlink | `realpath` للمسار **و** للجذر؛ أي خروج عن الجذر الحقيقي = رفض |
| حدود | ملف ≤2MB، قائمة ≤500، stdout ≤256KB، مهلة CLI 15 ثانية |
| القراءة تطابق مصدرها | **هاش مزدوج**: قراءتان مستقلتان يجب أن يتطابقا — السيرفر يرفض نجاحًا بلا تطابق |
| المهام تنتهي صلاحيتها | job = مهمة واحدة، 60 ثانية — بعدها EXPIRED ولا تُستلم |

## الحالات
- جهاز: `ACTIVE` | `REVOKED`
- مهمة: `QUEUED` | `CLAIMED` | `DELIVERED` | `FAILED` | `EXPIRED`
- كل حالة ظاهرة في `GET /api/companion?businessId=` مع الدليل (hash/size/lines/exitCode)

## الواجهة
```
node companion/bridge.mjs --server https://app.example.com \
  --device <DEVICE_ID> --token <DEVICE_TOKEN> --allowlist allowlist.json
```
allowlist.json: `{ "paths": ["/data/invoices"], "cli": [{ "command": "/opt/tools/report.exe", "label": "تقرير" }] }`

في ويندوز الإنتاج: الـ token في Credential Manager/DPAPI (تغليف الإنتاج) وليس في ملف مكشوف.

## حدود صادقة (لا نُدّعي ما لم يُختبر)
- هذه الدفعة تثبت **المنطق المشترك على Linux** (بطارية 10 اختبارات: crash/revocation/
  cross-tenant/traversal/symlink/shell-injection/replay/expiry/evidence).
- **قبول ويندوز الحقيقي** (آلة مستهدفة، DPAPI، تحديثات موقعة، فحص منفصل للبريد الضار)
  بوابة منفصلة حسب الخطة §10 — غير مدّعاة هنا. الجهاز غير المتصل = `not_connected`.
