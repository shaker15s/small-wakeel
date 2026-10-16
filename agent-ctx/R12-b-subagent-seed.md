# Task R12-b — subagent-seed — prisma/seed.ts (4 businesses rich demo data)

Full work log is in /home/z/my-project/worklog.md (search "Task ID: R12-b").

## Result: DONE ✅ (exit 0, 24/24 verification checks pass, lint clean)

- Created `/home/z/my-project/prisma/seed.ts` (~1300 lines) — wipes DB in FK-safe order, seeds 4 businesses + 2 model providers. Imports `db` from `../src/lib/db`. Run: `bun prisma/seed.ts`.
- Counts: Business 4 · User 9 · Item 70 · Customer 19 · Supplier 8 · Operation 48 · CashEntry 37 · AuditEvent 144 · Conversation 4 · Message 8 · ScheduledTask 8 · AgentMemory 12 · AgentSettings 4 · ModelProvider 2 · ModelConfig 8 (7 enabled).

## Key data facts for downstream agents (R12-d/e/f/g)

- Refs per business thousand-block (globally unique): النور WKL-1001..1014 · جيم WKL-2001..2012 · صيدلية WKL-3001..3012 · عطارة WKL-4001..4010. `Business.opSeq` = last used number → next ref = `WKL-{opSeq+1}`.
- Pending approvals (status AWAITING_APPROVAL, no result/cash/executedAt): WKL-1013 sale R2 credit أم حسن 23300 · WKL-2012 membership R2 عمر renewal 35000 (linked to conversationId) · WKL-3012 stock_adjustment R3 سيتال −12 with reason · WKL-4010 sale R2 gram credit الحاج رجب 42000.
- Reversal pair: WKL-1014 (type reversal, R3, reason set, cash out 9800) ↔ WKL-1006 (`reversalOfRef`/`reversedByRef` set both ways).
- Cash (CashEntry sums, opening «افتتاح الخزنة» counted as in): النور 619600/190800/428800 · جيم 506500/60000/446500 · صيدلية 521100/240500/280600 · عطارة 570000/339000/231000 (piastres).
- Low stock: النور 4 · صيدلية 3 (ناكسيد/ميلجا/فيوسيدين) · عطارة 2 (مسك غزال 340<350, زعفران 12<15). Pharmacy expiry: 5 ≤30d (كونجستال 5d أخطرها), 2 expired (سيتال, تليفاست).
- Gym members = Customers with plan+expiresAt: عمر +3d, هدى +5d (owes 5000), كريم −5d expired (owes 20000), others healthy.
- Messages: thinking/cards/card are JSON STRINGS (parse with JSON.parse); assistant modelLabel «عميق مفكّر · glm-4.6». Gym assistant message carries a draft ActionCard (kind 'draft', opId of WKL-2012) in `card`.
- Providers: «مزوّد تجريبي» (demo-key) + «مزوّد الاختبار» (test-key), baseUrl http://localhost:3031/v1 (mock-provider running), remoteIds wakil-mock-air/flash/balanced/deep, Arabic labels وكيل خفيف/سريع/متوازن/عميق; flash disabled on provider 2.
- ⚠ seed.ts is idempotent (wipe→reseed) but regenerates all cuids on each run — NEVER hardcode IDs, always use GET /api/bootstrap. Current-run IDs are listed in worklog.md (they change if the seed is re-run).
- Payload shapes used (for executor consistency): sale/purchase `{ lines:[{name,qty,unit,unitPrice}], payment:'cash'|'credit', customer?/supplier?, total }` · expense `{category,amount,note}` · collection/payment `{customer|supplier, amount}` · membership `{member,plan,months,amount,payment}` · attendance `{memberName,date}` · reversal `{ref,reason}` · stock_adjustment `{item,unit,delta,currentStock,newStock,reason}`. Results mirror these + balanceAfter/cashDelta/stockApplied.
