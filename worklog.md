# وكيل (Wakil) — Project Worklog (REBUILD)

## ⚠️ Situation
The sandbox was RESET — the entire previously-built app was wiped. Only the blueprint survived: `/home/z/my-project/upload/wakil_200_year_evolution_blueprint_ar.md`. This is Round 12: a full, faithful rebuild of the app at world-class level, based on the blueprint + retained architecture knowledge.

## Project Overview
**وكيل (Wakil)** — an Egyptian-Arabic (RTL) AI operations agent for small businesses. Conversation-first UX: the user talks, the agent drafts operations, the user approves, the server executes deterministically and verifies.

- 4 verticals (demo businesses): سوبر ماركت النور (supermarket) · جيم أبطال (gym) · صيدلية الشفاء (pharmacy) · عطارة المسك (attar/perfume shop)
- Egyptian Arabic dialect throughout, calm-trust design: **deep navy primary + warm amber accent on warm paper** (light + dark mode)
- Deterministic server-side domain execution (LLM extracts intent/fields; server enforces business rules)
- Risk ladder R0–R4 with approvals (R2+ writes need owner/supervisor approval)
- Operation state machine: RECEIVED → AWAITING_APPROVAL → EXECUTING → SUCCEEDED / FAILED_SAFE / OUTCOME_UNKNOWN / CANCELLED
- Idempotency keys for all writes; immutable audit events; corrections reverse, never delete
- Money stored as **integer piastres** (never floats)
- Role-based permissions: owner / cashier / reception / supervisor
- Letter-by-letter streaming (SSE) with visible thinking steps + agent avatar states
- BYO OpenAI-compatible providers (Base URL + API Key → pull models → enable subset → switch live)
- Mock external provider mini-service on port 3031 for demo without a real key
- z-ai-web-dev-sdk (backend only) for built-in models: deep (glm-4.6) + air (glm-4.5-air)

## Tech
Next.js 16 App Router (single route `/`), TypeScript strict, Tailwind 4 + shadcn/ui (New York), Prisma + SQLite (`db/custom.db`), Zustand + TanStack Query, framer-motion, next-themes, lucide-react, sonner toasts.

## File ownership map (to avoid conflicts)
- **Orchestrator (me)**: prisma/schema.prisma, lib/{types,format,api,store}, lib/domain/*, lib/agent/*, api/chat, api/operations/[id]/confirm, api/providers*, api/tasks*, app/{layout,page,globals.css}, components/app/*, components/chat/*
- **Subagents**: prisma/seed.ts, read API routes, mini-services/*, components/views/*, ProvidersSection

## Prisma schema (SINGLE SOURCE OF TRUTH — already pushed)
Models (money = integer piastres everywhere):
- Business(id, name, type: supermarket|gym|pharmacy|attar, currency, timezone, openingCash, opSeq, createdAt)
- User(id, businessId, name, role: owner|cashier|reception|supervisor, title?)
- Item(id, businessId, name, aliases, unit, category, costPrice, sellPrice, stockQty, lowStockThreshold, batchNo?, expiresAt?)
- Customer(id, businessId, name, phone?, balance, plan?, expiresAt?) — gym members are Customers
- Supplier(id, businessId, name, phone?, balance)
- Operation(id, ref WKL-#### unique, businessId, type, status, source, userId, risk R0-R4, summary, payload JSON, result JSON?, idempotencyKey unique, conversationId?, reversalOfRef?, reversedByRef?, reason?, failReason?, createdAt, executedAt?, decidedAt?)
- CashEntry(id, businessId, direction in|out, amount, reason, ref?, createdAt)
- AuditEvent(id, businessId, actor, action, ref?, detail JSON, createdAt)
- Conversation(id, businessId, userId, title, createdAt, updatedAt) + Message(id, conversationId, role user|assistant, text, card?, cards?, thinking?, modelLabel?)
- ScheduledTask(id, businessId, userId, conversationId?, title, tool, fields JSON, whenLabel, scheduledFor, recurrence?, status pending|done|failed|cancelled, result?, failReason?)
- AgentMemory(id, businessId, userId, kind fact|preference, text)
- AgentSettings(id, businessId unique, vertical, tone)
- ModelProvider(id, name, baseUrl, apiKey) + ModelConfig(id, providerId, remoteId, label, tier: air|balanced|deep, enabled)

## Operation types
sale (بيع) · purchase (شراء) · expense (مصروف) · collection (تحصيل من عميل) · payment (سداد لمورد) · stock_adjustment (تسوية مخزون) · membership (اشتراك جيم جديد/تجديد) · attendance (حضور) · reversal (عكس عملية)

## Agent tools (lib/agent/tools.ts)
Reads (R0, execute directly): get_daily_summary, get_cash_position, search_catalog, get_item_stock, list_low_stock, list_expiring, get_supplier_balance, get_member_status, list_receivables, list_payables, get_activity_history
Writes (R2, draft→approve): draft_sale, draft_purchase, record_expense, record_collection, record_payment, create_member, renew_membership, record_attendance
R3 (approve + reason): adjust_stock, reverse_operation, big amounts
Utility: schedule_task (R1), save_memory (R1)

## API contract (all routes under src/app/api)
- GET /api/bootstrap → { businesses:[{id,name,type,users:[{id,name,role,title}]}], providers:[{id,name,baseUrl,models:[{id,remoteId,label,tier,enabled}]}] }
- GET /api/overview?businessId&userId → { cash:{in,out,opening,net}, today:{sales,purchases,expenses,collections,payments,opsCount}, pendingOps:[ops], lowStock:[items], expiring?:[items], receivables:[customers], payables:[suppliers], recentOps:[ops], alerts:[{level,text}] }
- GET /api/items?businessId → items list (with daysToExpiry for pharmacy)
- GET /api/operations?businessId → journal list
- GET /api/chat?businessId&userId → { conversation, messages }
- POST /api/chat {businessId,userId,text,modelKey?,conversationId?} → **SSE stream**: events `thinking` (visible reasoning steps), `step` (tool calls with labels), `card` (draft operation card), `cards` (result tables), `delta` (reply text letter-by-letter), `done` {messageId,modelLabel}, `error`
- POST /api/operations/[id]/confirm {action: approve|reject|cancel, reason?} → executes via domain executor, returns updated op + verification
- POST /api/providers {name,baseUrl,apiKey} → validates via GET {baseUrl}/models, saves + fetched models
- POST /api/providers/[id] {models:[{remoteId,label,tier,enabled}]} → save enabled subset
- DELETE /api/providers/[id]
- GET /api/tasks?businessId · POST /api/tasks {…} · POST /api/tasks/tick (runs due tasks)
- GET /api/memories?businessId · POST /api/memories
- GET /api/reports?businessId&range=7d|30d → aggregates for Stats/Reports
- GET /api/export?businessId → JSON download
- GET /api/members?businessId (gym members)

## Design system (globals.css tokens)
- Warm paper bg `#faf7f2` light / deep navy-ink `#0f1a2b` dark; primary navy `#1b2d4f`/`#2e4a7d`; accent amber `#d97706`-ish `#c2762a`; success teal-green; danger warm red
- Border radius ~12px cards; 4/8 spacing scale; tabular-nums for money; Arabic font stack (system + "Segoe UI Arabic" fallbacks — no external font downloads to keep perf)
- Motion: 160–220ms card enter, 90–140ms press, framer-motion only where meaningful; respect prefers-reduced-motion
- RTL everywhere, dir="rtl" on html, logical Tailwind properties (ps/pe/ms/me)

## Frontend structure
- app/layout.tsx: html dir=rtl lang=ar, ThemeProvider, Toaster, metadata «وكيل — مساعد شغلك اليومي»
- app/page.tsx: 'use client' bootstrap → AppShell
- components/app/AppShell.tsx: header (business switcher, search palette, notifications, user switcher, dark mode) + main nav (المحادثة/اليوم/المخزون/السجل/الحسابات/الإحصائيات/التقارير/الإعدادات) + footer sticky-bottom (mt-auto), mobile bottom tab bar
- components/chat/: ChatView, MessageList, MessageBubble (user right-aligned amber, assistant left with AgentAvatar), LiveTurnView (thinking + steps + streaming), ThinkingBlock (collapsible «تفكير وكيل»), AgentAvatar (8 states: idle/thinking/searching/executing/writing/listening/success/error — Duolingo-style robot with antenna), ActionCard (draft with fields table + approve/reject + risk badge R0-R4 + danger indicator), ResultCards (tables), Composer (textarea + voice + quick chips per vertical), SessionDrawer (الجلسات السابقة), TasksDrawer (المهام المؤجلة), MemoryDrawer (ذاكرة وكيل)
- components/views/: TodayView, InventoryView, JournalView, AccountsView, StatsView (charts via shadcn chart), ReportsView, SettingsView (+ ProvidersSection + ModelPicker)
- lib/store.ts (Zustand): businessId, userId, view, modelKey (localStorage wakil.*), session/conversation state
- lib/api.ts: typed fetch helpers + SSE chat streaming reader

## Model registry
- Built-in: `builtin-deep` (عميق مفكّر, glm-4.6 via z-ai-web-dev-sdk, tier deep), `builtin-air` (خفيف سريع, glm-4.5-air, tier air) — modelLabel like «عميق مفكّر · glm-4.6»
- External: ModelConfig rows; modelKey = `ext:{modelConfigId}`; requests go to {provider.baseUrl}/chat/completions with provider.apiKey, streaming OpenAI-format
- Mock provider (port 3031): 4 models wakil-mock-air/flash/balanced/deep, SSE letter-by-letter, /v1/models list

## QA baseline (from pre-reset build, must reach again)
- Streaming letter-by-letter + thinking visible; approval cards; 4 verticals with correct chips/units/tools; providers CRUD with model pulling; model switching live; dark mode; mobile 390px no overflow; zero console errors; lint clean

## Current rebuild status
- [x] R12-0: worklog recreated, deps verified (framer-motion, next-themes, zustand, z-ai-web-dev-sdk, lucide all present)
- [x] R12-a: schema pushed + lib/{types,format,verticals} DONE
- [x] R12-b: seed DONE (4 businesses, 48 ops, 2 providers verified)
- [x] R12-c: mock-provider on :3031 RUNNING (PID 2457, double-fork daemon)
- [x] R12-d: read API routes DONE (10 routes + _lib helpers)
- [x] R12-e: domain executors + agent harness DONE & VERIFIED:
  - lib/agent/{arabic,llm,prompt,tools,harness}.ts + lib/domain/{risk,executors}.ts
  - api/chat POST SSE verified letter-by-letter: «بعت 10 جرام عود كمبودي» → draft WKL-5011 (10×95=950ج from REAL price) → approved → SUCCEEDED with verification check pass
  - FIXED: \b regex doesn't work with Arabic — UNIT_WORD_TO_CODE with plain includes + unitToCode() maps Arabic words («جرام») → codes
  - api/operations/[id]/confirm (approve/reject + R3 reason + role check), api/providers (+[id]) (validate via /models before save), api/tasks (GET+POST), api/tasks/tick, api/memories POST
  - globals.css: وكيل design system (warm paper #faf7f1 / deep navy #1f3a5f / amber #c2762a, dark navy ink #0f1a2b; .num LTR, .card-enter, .thinking-dot, .stream-caret, .scroll-warm, reduced-motion)
  - layout.tsx: RTL ar, ThemeProvider, «وكيل — مساعد شغلك اليومي»
  - lib/api.ts: typed client + streamChat SSE reader + messageToTurn
  - lib/store.ts: useWakil (businessId/userId/modelKey/view + localStorage wakil.*)
- [ ] R12-f1 (subagent): views — Today/Inventory/Journal/Accounts/Stats/Reports/Settings(+Providers+ModelPicker)
- [ ] R12-f2 (subagent): chat atoms — AgentAvatar/ThinkingBlock/ActionCard/ResultCards/MessageBubble/Composer
- [ ] R12-g (orchestrator): ChatView + AppShell + Onboarding + page.tsx
- [ ] R12-h: browser QA + fixes + final worklog

## Component contracts (frontend must follow EXACTLY)
All views receive props: `{ businessId: string; userId: string; onNavigate?: (v: ViewKey) => void }`.
- Chat atoms (components/chat/):
  - AgentAvatar.tsx: `({ state: 'idle'|'thinking'|'searching'|'executing'|'writing'|'listening'|'success'|'error', size?: 'sm'|'md'|'lg' })` — SVG robot w/ antenna, Duolingo-style, aria-label per state, antenna animates when thinking/executing
  - ThinkingBlock.tsx: `({ steps: ThinkingStep[] })` collapsible «تفكير وكيل» with per-step icons + active pulse
  - ActionCard.tsx: `({ card: ActionCardDTO, onApprove, onReject, busy?, resultOutcome? })` — fields table, effects, risk badge R0-R4 + dangerNote, approve/reject buttons (approve disabled w/ reason input when R3), post-execution verification display
  - ResultCards.tsx: `({ cards: ResultCardDTO[] })` — table/kv/text renderers, .num for numbers
  - MessageBubble.tsx: `({ turn: ChatTurn })` — user bubbles amber-tinted (end of row), assistant with AgentAvatar idle + thinking + text + cards + ActionCard (interactive if opId) + modelLabel badge
  - Composer.tsx: `({ chips: string[], onSend, disabled })` — textarea autosize, chips row, send button w/ spinner state
- ChatView.tsx (orchestrator): manages messages list, live turn streaming, sessions drawer, tasks drawer, memory drawer, model picker (dropdown in header of view)
- Views fetch with TanStack Query + api.*; money via egp(); status/type labels via STATUS_AR/TYPE_AR from '@/lib/agent/tools'

## Dev environment notes
- Dev server already running on :3000 (bun run dev, hot reload). NEVER `bun run build`.
- DB: `bun run db:push` after schema edits; seed with `bun run prisma/seed.ts` (bun).
- API base URLs must be relative (Caddy gateway). Mini-service requests from frontend must use `?XTransformPort=3031` only for direct provider test calls; the app itself calls providers server-side.
- mock-provider must be started: `cd mini-services/mock-provider && bun run dev` (background).

---
Task ID: R12-d
Agent: subagent-read-api
Task: read API routes (bootstrap/overview/items/operations/chat/members/tasks/memories/reports/export)
Work Log:
- Read worklog.md (API contract), prisma/schema.prisma, src/lib/types.ts (DTO contracts) — built strictly against them.
- Created shared helpers under src/app/api/_lib/ (underscore folder = not routed):
  - dates.ts: Africa/Cairo-aware day math (startOfCairoDay, cairoDayIndex, daysFromTodayCairo, cairoIsoDay/Offset) with DST-safe two-iteration offset solve — "today"/"expiring"/"daysToExpiry"/report buckets all follow the Cairo calendar regardless of server TZ.
  - http.ts: searchParams, badRequest(400 Arabic), notFound(404 Arabic), serverError(500 «حصل خطأ في السيرفر» + console.error).
  - serialize.ts: serializeOp (payload/result JSON strings → objects, userName joined), serializeItem (daysToExpiry + valueAtCost), serializeCustomer (daysLeft), serializeSupplier, serializeTask (fields JSON), serializeMemory, serializeMessage (card/cards/thinking JSON), parseJson (safe), payloadTotalPiastres (payload.total), userNameMap.
- Created 10 GET route handlers (all `export const dynamic = 'force-dynamic'`, all typed against lib/types DTOs, all use `import { db } from '@/lib/db'`):
  - api/bootstrap: businesses incl users (role priority owner→supervisor→cashier→reception, then name) + providers incl models (label asc); apiKey never returned.
  - api/overview?businessId&userId: cash {opening,in,out,net} via CashEntry groupBy; today sums (SUCCEEDED, payload.total, 5 money types, Cairo start-of-day) + opsCount (ALL ops created today); pendingOps (take 10, newest, userName); lowStock (stockQty ≤ threshold, asc); expiring (pharmacy only, ≤30d or expired, expiresAt asc); receivables/payables (balance>0 desc); recentOps (8); alerts built from data (danger expired «فيه X صنف صلاحيته خلصت», warning expiring/low-stock «X صنف تحت حد التنبيه», info pending «X عملية مستنية اعتمادك», info receivables via egp()) with optional view actions.
  - api/items?businessId: category asc, name asc; daysToExpiry + valueAtCost computed.
  - api/operations?businessId&status?: createdAt desc take 100, userName join, JSON parsed, status validated against the 7 statuses (400 «قيمة status غير صحيحة» on bad value).
  - api/chat?businessId&userId: latest Conversation (updatedAt desc) or creates «محادثة جديدة»; messages asc with card/cards/thinking parsed (404s for unknown business/user before create).
  - api/members?businessId: customers name asc with daysLeft.
  - api/tasks?businessId: JS sort — pending first (scheduledFor asc), then rest by executedAt desc (createdAt fallback).
  - api/memories?businessId: createdAt desc.
  - api/reports?businessId&range=7d|30d (default 7d): N Cairo daily buckets (every day present), totals + net = sales+collections−(purchases+expenses+payments), topItems top-5 by qty (defensive to items[]-with-price/total and flat single-item payload shapes), byType count+amount (amount desc).
  - api/export?businessId: JSON download, content-disposition attachment filename="wakil-export-{id}.json"; {exportedAt, business, items, customers, suppliers, operations (parsed), cashEntries, auditEvents (detail parsed)}.
- Validation on every route: missing businessId/userId → 400 in Arabic; DB exceptions → 500 «حصل خطأ في السيرفر» (logged); unknown business → 404 where a row is required (overview/chat/export).
- `bun run lint`: clean. `bunx tsc --noEmit`: zero errors in my files (remaining errors are only in examples/, mini-services/, skills/ — other agents' scope). Fixed one TS error found during check (null fallback typing in serializeOp result).
- Seed data didn't exist yet, so I ran a full functional smoke test with a temporary pharmacy fixture (business/users/items incl. expired+expiring+low-stock/customer/supplier/5 ops incl. pending & out-of-range/cash entries/audit/tasks/memory/message) → curl-verified every route end-to-end (cash net 57000, today sales 2500/opsCount 3, lowStock order, expiring daysToExpiry −2/10, alerts incl. «عندك ٥٠ ج.م مستحقة عند العملاء», chat conversation auto-create + JSON parsing, task ordering, reports buckets/totals/net 2100/topItems incl. flat-payload fallback, export headers + parsed audit detail), then deleted ALL fixture rows (cascade) and the temp script — DB left at zero rows for the seed agent.
Stage Summary:
- Routes created: 10 (bootstrap, overview, items, operations, chat GET, members, tasks, memories, reports, export) + 3 shared helper files in src/app/api/_lib/. All match lib/types DTOs exactly; money everywhere integer piastres.
- Lint clean; tsc clean in scope; live curl tests all 200/400/404 as designed; dev.log shows no route errors.
- Deviations/decisions: (1) bootstrap users ordered by role priority owner→supervisor→cashier→reception instead of alphabetical so the user switcher defaults sensibly; (2) overview.today uses createdAt ≥ Cairo midnight (opsCount counts ALL today's ops, money sums only SUCCEEDED of the 5 money types); (3) expiring/lowStock lists not capped (spec silent); (4) reports topItems accepts both items[] lines (price|total) and flat single-item payloads (defensive until R12-e fixes the payload shape); (5) 404 (not 400) for unknown businessId where a row is required; (6) status filter validated. Did NOT touch chat POST, operations/[id], providers, tasks/memories POST, lib/, components, prisma — untouched as instructed.

---
Task ID: R12-c
Agent: subagent-mock-provider
Task: mini-services/mock-provider — OpenAI-compatible streaming mock on 3031
Work Log:
- Read worklog + inspected sandbox (dev server :3000 running, mini-services/ absent → created it)
- Wrote `mini-services/mock-provider/package.json` (name mock-provider, dev = `bun --hot index.ts`, zero deps) and `index.ts` (147 lines, Bun.serve :3031, CORS + OPTIONS, JSON 400/404 errors)
- Implemented endpoints: GET /health, GET /v1/models (4 models), POST /v1/chat/completions with BOTH stream:true (SSE) and stream:false (chat.completion JSON with reasoning_content)
- Streaming = reasoning-first: 3–6 Arabic `delta.reasoning_content` chunks (DeepSeek-style, 90–260ms apart) → content deltas of 1–2 CHARS each (pace 8–25ms, slightly random, tier-scaled: air 8–13ms, deep 14–25ms) → finish_reason stop → `data: [DONE]`
- Smart replies (Egyptian Arabic): business keywords (بيع/شرا/تحصيل/سداد لمورد/مصروف/اشتراك/عضوية) → op confirmation + extracted numbers (western & Arabic-Indic digits) + tool reference when system prompt mentions tools; cash/stock questions → plausible answers; else friendly default; tier controls reply length & reasoning count
- Fixed classification bug found in testing (اشتريت من المورد was matching سداد لمورد → reordered OP_MAP; hot reload re-verified)
- DISCOVERED sandbox behavior: every background process from a Bash-tool command is SIGKILLed at command end — nohup/disown/setsid do NOT help; only double-fork daemonization (reparent to tini PID 1) survives. Added `mini-services/mock-provider/start.sh` (idempotent restart via perl double-fork). NOTE for orchestrator & future subagents (websocket chat-service!): use that pattern, plain `bun run dev &` dies.
- Service RUNNING (pid 2457, PPID=1, bun --hot) — survives command boundaries; also auto-starts on any sandbox reboot (boot /start.sh scans mini-services/*/package.json)
Stage Summary:
- Endpoints: GET /health → {ok:true} · GET /v1/models → OpenAI list (wakil-mock-air/flash/balanced/deep, owned_by wakil) · POST /v1/chat/completions (stream SSE + non-stream JSON, 400 bad JSON, 404 unknown routes, CORS everywhere)
- Verified by curl: /models lists 4 ids; streaming sale request → 138 SSE events (role + 6 reasoning_content + 129 content deltas of 1–2 chars e.g. "ت" "ما" "م " + stop + [DONE]); reassembled reply: «تمام يا فندم، فهمت — بيع. جهّزتلك كارت العملية بالأرقام دي (5، 300) وهنفّذها من خلال أداة draft_sale بأمان…»; air ≈ 1.0s / balanced ≈ 2s / deep ≈ 2.9s; non-stream returns chat.completion with message.reasoning_content + content; purchase/payment classification correct after fix
- Provider ready for Wakil app: baseUrl http://localhost:3031/v1 (server-side), models pulled via /v1/models, no API key needed. Left RUNNING on :3031.

---
Task ID: R12-b
Agent: subagent-seed
Task: prisma/seed.ts — seed 4 businesses with rich demo data
Work Log:
- Read worklog.md + src/lib/{types,format,verticals}.ts + prisma/schema.prisma + src/lib/db.ts (exists, exports `db` with query logging); verified bun auto-loads DATABASE_URL from .env and Prisma client is generated
- Created `/home/z/my-project/prisma/seed.ts` (~1300 lines, organized: helpers → generic creators (users/items/customers/suppliers/opFactory+audit+cash/settings/memories/tasks/conversation) → 4 per-business sections → providers → verify → main). Imports `db` from '../src/lib/db' as instructed
- Wipe order (children first): Message, Conversation, ScheduledTask, AgentMemory, AgentSettings, AuditEvent, CashEntry, Operation, Customer, Supplier, Item, User, Business, ModelConfig, ModelProvider
- opFactory: WKL-#### refs + auto cash entry + audit trail per op (SUCCEEDED → created+approved+executed events, AWAITING_APPROVAL → created+approval_requested); executedAt=createdAt+2min, decidedAt=+1min; idempotencyKey `seed-{businessId}-{ref}` unique
- سوبر ماركت النور: خالد(owner)/سعاد(cashier)/محمود(supervisor) · 20 items piastres prices (لبن 4500=45ج, بيض 16500, قهوة 9500…) with 4 low-stock (ديتول 6<8, بيض 8<10, كوكاكولا 20<24, عدس 9<12) · 5 customers (أحمد owes 85000=850ج, أم حسن 12500) · 4 suppliers (الألبان الوطنية we owe 120000) · opening cash 500000 in «افتتاح الخزنة» · 14 ops spread D-6→today (sales/purchase credit+cash/expenses/collection/payment) + WKL-1013 AWAITING_APPROVAL credit sale R2 (payload lines/customer/payment/total) + WKL-1014 SUCCEEDED reversal R3 linked to WKL-1006 (reversalOfRef/reversedByRef set, reason «فاتورة اتسجلت مرتين بالغلط», cash out 9800)
- جيم أبطال: كابتن حسام(owner)/مريم(reception) · 8 items (3 plans 35000/90000/300000 + بروتين/ماء/قفازات/بار/طاقة) · 8 members with plans+expiry (عمر +3d, هدى +5d owes 5000, كريم expired −5d owes 20000, الباقي healthy) · 12 ops: membership renewals/new, 4 attendance (payload {memberName,date}), sale, collection 15000, expense + WKL-2012 AWAITING_APPROVAL renewal R2 (linked to conversation via Operation.conversationId)
- صيدلية الشفاء: د. عبد الله(owner)/نورهان(cashier) · 22 items ALL with batchNo+expiresAt: 5 expiring ≤30d (كونجستال 5d, كتافلام 8d, بروفين 12d, فيتامين سي 18d, بانادول أكتيف 25d), 2 expired (سيتال −10d, تليفاست −25d), 3 low (ناكسيد 8<10, ميلجا 6<8, فيوسيدين 4<5), units box/piece/strip · مستشفى الرحمة customer owes 250000, عيادة د. منى 60000 · suppliers شركة الدواء 180000 + ميا فارم 65000 · 12 ops incl. WKL-3003 sale with expiryNotes+warnings in result + WKL-3012 AWAITING_APPROVAL R3 stock_adjustment (سيتال −12 علب, reason required «إتلاف موثق بمحضر»)
- عطارة المسك: عم سيد(owner)/زبير(cashier, مساعد عطارة) · 20 items gram/milli (عود كمبودي 9500/جرام, مسك غزال 18000/جرام stock 340<th 350 LOW, بخور/كركديه/حبة البركة stored per-gram so «ربع كيلو» = 250 gram works with Int stock, زيت صندل 350/مللي, خلطة المدينة/الحرم, عنبر, زعفران 12<15 LOW) · الحاج رجب owes 8000, متجر الريحان 45000, الحاج مسعود we owe 90000 · 10 ops incl. WKL-4001 gram sale (payload qty 10 unit gram + 500 جرام بخور) + WKL-4008 ربع كيلو كركديه (250 gram + unitConversions in payload) + WKL-4010 AWAITING_APPROVAL gram credit sale
- All 4 businesses: AgentSettings (vertical=type, tone friendly) · 3 AgentMemory each (facts like «العميل أحمد بيشتري بالآجل ويسدد آخر الشهر») · 2 ScheduledTasks each (pending «فحص المخزون الناقص» list_low_stock daily tomorrow 9am recurrence daily + one done with JSON result) · 1 Conversation each = 1 user msg + 1 assistant msg (thinking = JSON STRING array of ThinkingStep{label,detail,state:'done',icon}, cards = JSON STRING: supermarket gets table«المخزون الناقص»+kv«وضع الخزنة», gym gets table+kv+draft ActionCard linked to WKL-2012 (opId+ref+risk+fields+effects), pharmacy 2 tables, attar table+kv) · modelLabel «عميق مفكّر · glm-4.6» · all money-formatted text uses Arabic-Indic digits like egp()
- 2 ModelProviders «مزوّد تجريبي»(demo-key) + «مزوّد الاختبار»(test-key), both baseUrl http://localhost:3031/v1, 4 ModelConfig each (wakil-mock-air/flash/balanced/deep → وكيل خفيف/سريع/متوازن/عميق, tiers air/air/balanced/deep); flash disabled on provider 2 → 7 of 8 enabled so the enable/disable UI shows
- Ran `bun prisma/seed.ts` → exit 0. Script prints counts per model + 24 verification checks, ALL ✅ (cash in/out/net per business vs hand-computed expected, low-stock counts, 4 pending ops, reversal linkage, pharmacy expiring 5/expired 2, gym 8 members/2 ending ≤5d, 7 enabled configs, 4 parseable thinking+cards messages) and throws → exit 1 if any check fails
- `bun run lint` → clean (exit 0). Spot-checked DB via direct PrismaClient: thinking 4 steps, draft card WKL-2012 5 fields, ops by type = sale 20, expense 6, attendance 4, membership 4, collection 4, purchase 5, payment 3, reversal 1, stock_adjustment 1 = 48
Stage Summary:
- DB seeded & verified. Counts: Business 4, User 9, Item 70, Customer 19, Supplier 8, Operation 48, CashEntry 37, AuditEvent 144, Conversation 4, Message 8, ScheduledTask 8, AgentMemory 12, AgentSettings 4, ModelProvider 2, ModelConfig 8 (7 enabled)
- **Business IDs + owner IDs (for QA — from the FINAL seed run; ⚠ re-running seed.ts regenerates all cuids, so prefer GET /api/bootstrap over hardcoding):**
  - سوبر ماركت النور (supermarket) → businessId=cmvav3psg000iorbm9e9y9hb8 · owner خالد id=cmvav3psh000korbmqwag4fcz · opSeq=1014 (next ref WKL-1015)
  - جيم أبطال (gym) → businessId=cmvav3pv0006jorbme9kf58ul · owner كابتن حسام id=cmvav3pv1006lorbmi34gwdhm · opSeq=2012
  - صيدلية الشفاء (pharmacy) → businessId=cmvav3pxd00b6orbmj7dvqgdr · owner د. عبد الله id=cmvav3pxe00b8orbmvlpvjlrh · opSeq=3012
  - عطارة المسك (attar) → businessId=cmvav3pzy00gjorbm70rupsbp · owner عم سيد id=cmvav3pzz00glorbmnzoklps4 · opSeq=4010
- Cash (piastres, pure CashEntry sums, opening entry counted as 'in'): النور in 619600/out 190800/net 428800 · جيم 506500/60000/446500 · صيدلية 521100/240500/280600 · عطارة 570000/339000/231000. Pending approvals: WKL-1013 (sale R2), WKL-2012 (membership R2), WKL-3012 (stock_adjustment R3 with reason), WKL-4010 (gram sale R2). Reversal: WKL-1014 ↔ WKL-1006 (both directions linked)
- Deviations: (1) ref ranges are per-business thousand-blocks (1001–1014/2001–2012/3001–3012/4001–4010) because ref is globally unique WKL-####; Business.opSeq = last used number so the executor's next ref is WKL-{opSeq+1}; (2) gym has no suppliers (not required); (3) used `import { db } from '../src/lib/db'` as preferred — works, but db.ts logs every query, so run output is noisy (pipe through `tail`); (4) attar بخور/كركديه/حبة البركة stored per-GRAM (integer-safe for «ربع كيلو» = 250g sales); (5) عطارة assistant msg + gym card reference seeded pending ops for a realistic approval demo; (6) seed is idempotent (wipe→reseed) but cuids are regenerated each run — re-ran once to confirm exit 0 both times, IDs above are from the last run
- NOTE for R12-d/R12-e: DB was empty during read-API agent's earlier smoke test — re-run your route tests now, real seeded data is in place (read-API smoke fixture was deleted before I ran). Mock provider on :3031 is already running (R12-c), so the seeded providers' baseUrl will resolve.

---
Task ID: R12-f2
Agent: subagent-chat-atoms
Task: chat atoms (AgentAvatar/ThinkingBlock/ActionCard/ResultCards/MessageBubble/Composer)
Work Log:
- Read worklog.md (component contracts + design system), src/lib/types.ts (DTOs), src/lib/format.ts, src/app/globals.css (tokens/.num/.card-enter/.press/.scroll-warm/.thinking-dot/.stream-caret/.avatar-antenna-active), lib/agent/tools.ts, lib/domain/risk.ts, lib/verticals.ts + the shadcn primitives I consume (button/badge/card/collapsible/table/input/textarea/alert — no Spinner in ui/, used lucide Loader2 as instructed).
- Created 6 files in src/components/chat/ ('use client', TS strict, RTL, no new deps):
  - AgentAvatar.tsx — inline-SVG mascot (rounded navy head via var(--wakil-navy), ears, blush cheeks, antenna w/ amber tip that waves via .avatar-antenna-active + transform-box:fill-box when thinking/searching/executing/writing/listening). 8 states: idle dots · thinking pulsing .thinking-dot eyes · searching eyes-up + magnifier badge · executing narrowed eyes + gear badge · writing eyes-down + pencil badge · listening equalizer badge · success happy-arc eyes + emerald check badge · error flat eyes/X + red ✕ badge. Eyes/mouth use var(--background) fill so contrast holds in dark mode (head flips to light navy there). aria-label «وكيل — خامل/يفكر/يبحث/ينفذ/يكتب/يستمع/نجح/خطأ», sizes 28/40/56px, zero hooks. Exports `AgentState`.
  - ThinkingBlock.tsx — shadcn Collapsible «تفكير وكيل» (Brain + chevron that rotates via group-data-[state=open]). Derived open state (no setState-in-effect — lint forced the cleaner pattern): untouched → open iff any step active, closed when all done; user toggle always wins. Step icons understand=Lightbulb/search=Search/verify=BadgeCheck/plan=ListChecks/execute=Zap (Circle fallback); active = amber .thinking-dot + text-foreground; done = muted + emerald check; pending = opacity-60. bg-muted/50 rounded-lg border, text-sm, framer 180ms enter.
  - ActionCard.tsx — Card: type Badge (TYPE_AR) + title + RISK_META risk badge (hint as title) + ref chip (.num) + summary; fields as dl rows (muted label / bold value, dashed separators); effects with tone colors (good=emerald, bad=destructive); dangerNote amber callout (AlertTriangle, bg-accent) with role=alert. AWAITING_APPROVAL footer: «اعتماد العملية» (primary, h-11, .press) + «إلغاء المسودة» (outline destructive); R3 → reason Input above buttons, approve disabled until trim≥3; busy → Loader2 spinner in approve + both disabled. Status strip for non-awaiting states (SUCCEEDED emerald «تم — موثّق ومتحقق», FAILED_SAFE red «فشلت بأمان», CANCELLED muted «ملغاة», EXECUTING amber spinner, …). outcome prop → verification section: per-check CheckCircle2/XCircle + «المتوقع/الفعلي» mono .num, verified effects, failReason in destructive Alert. Exports `ActionCardOutcome`.
  - ResultCards.tsx — table kind: Table icon + title, shadcn Table inside max-h-72 .scroll-warm wrapper, columns text-start/end (align==='end' or last col), every cell digit-run wrapped in .num, footer rows bold; empty rows/cols → «مفيش نتايج». kv kind: label/value justify-between rows. text kind: title + pre-wrap paragraph. Each card framer 180ms.
  - MessageBubble.tsx — user: dir=ltr row justify-end (physical RIGHT per worklog contract) + dir=rtl bubble bg-[var(--wakil-amber-soft)] text-accent-foreground rounded-2xl rounded-tr-sm max-w-[85%] px-4 py-2.5 text-[15px]. assistant: dir=ltr row justify-start (physical LEFT) with AgentAvatar sm + dir=rtl column: ThinkingBlock → streamed text (whitespace-pre-wrap, .stream-caret while streaming) → ActionCard (busy when busyOpId===card.opId, handlers re-wrapped to (card, reason)) → ResultCards → Cpu modelLabel text-[11px]. streaming with no text yet → ThinkingBlock only. All text digit-runs .num-wrapped.
  - Composer.tsx — chips row (overflow-x-auto .scroll-warm, secondary rounded-full text-xs .press h-8, click fills+focuses input) + form row [Textarea flex-1, Mic ghost 44px, Send primary circle 44px ArrowUp]. Textarea rows=1, JS autosize 44→128px (max-h-32), Enter=send / Shift+Enter=newline (isComposing-guarded), placeholder «رسالة إلى وكيل…», amber focus ring. Send disabled when empty/disabled, Loader2 spin while disabled (treated as the in-flight state). Mic: enabled only when onVoiceClick provided, else disabled teaser w/ title «الصوت جاي قريب», aria-label «تسجيل صوتي لرسالتك».
- ⚠ DEVIATION (important for orchestrator): TYPE_AR/STATUS_AR are NOT imported from '@/lib/agent/tools' — tools.ts imports { db } (PrismaClient instantiated at module scope) + '@/app/api/_lib/dates', so importing it from a client component would pull Prisma into the browser bundle and break. Duplicated the two small label maps locally in ActionCard.tsx with a keep-in-sync note. RISK_META IS imported from '@/lib/domain/risk' (that module is genuinely pure). Suggest moving TYPE_AR/STATUS_AR into a pure module (e.g. lib/labels.ts) in a later stage and updating both server + ActionCard imports.
- A local withNums() helper (splits Arabic-Indic ٠-٩ incl. ٫٬ separators + western digit-runs into .num spans) is duplicated in ActionCard/ResultCards/MessageBubble to stay file-self-contained (no new files allowed).
- `bun run lint` → CLEAN (fixed one error: react-hooks/set-state-in-effect in ThinkingBlock, replaced with derived open state). `bunx tsc --noEmit` → ZERO errors in components/chat (only remaining project errors are examples/ + mini-services/ + skills/ = other agents' scope, unchanged). curl localhost:3000 → 200; dev.log shows clean hot compiles, no errors from these files (they compile lazily once ChatView imports them — imports were type-verified via tsc).
Stage Summary:
- Files: src/components/chat/{AgentAvatar,ThinkingBlock,ActionCard,ResultCards,MessageBubble,Composer}.tsx — 6/6 chat atoms done, all spec prop signatures exact.
- Exported surface: AgentAvatar(state:AgentState,size?:'sm'|'md'|'lg') + `AgentState`; ThinkingBlock(steps:ThinkingStep[]); ActionCard(card,onApprove?(reason?:string),onReject?(reason?:string),busy?,outcome?:ActionCardOutcome) + `ActionCardOutcome`; ResultCards(cards:ResultCardDTO[]); MessageBubble(turn,onApprove?(card,reason?),onReject?(card),busyOpId?); Composer(chips,onSend(text),disabled?,onVoiceClick?).
- lint clean · tsc clean in scope · dev server 200 + hot reload OK. Did NOT touch page.tsx/AppShell/ChatView/lib/api — ready for R12-g wiring.
- Ready-for-orchestrator notes: (1) MessageBubble keeps LTR transcript geometry per worklog (user right/assistant left) via dir switches — inner content fully RTL; (2) ThinkingBlock auto-collapses when all steps done (default-closed per spec) unless the user toggled it; (3) ActionCard hides the approve footer when `outcome` is passed (post-execution read-only); (4) Composer shows the send spinner whenever `disabled` is true (no separate `sending` prop exists); (5) TYPE_AR/STATUS_AR duplication issue above — please consider lib/labels.ts.

---
Task ID: R12-f1
Agent: subagent-views
Task: views (Today/Inventory/Journal/Accounts/Stats/Reports/Settings+Providers)
Work Log:
- Read worklog (contracts + design system + API contract), lib/{types,api,format,verticals,store}, globals.css tokens, agent/tools.ts labels, and the live routes (overview/providers/providers-[id]/tasks/memories/reports) to pin exact payload shapes before writing UI.
- Created `src/components/views/shared.tsx`: ViewProps ({businessId,userId,onNavigate?}), client-safe TYPE_AR/STATUS_AR/RISK_AR/TIER_AR/TASK_STATUS_AR/READ_TOOL_AR/RECURRENCE_AR, safeView(), Money, RiskBadge/StatusBadge/TypeBadge/TierBadge, KpiCard (fixed h-24 → zero layout shift), LoadingKpis, ErrorState (Arabic + retry), EmptyState (icon + guidance, never blank), SectionCard, ViewHeader, arNum.
- TodayView: 4 KPIs (خزنة net teal/red, مبيعات, عمليات, مستنيات amber), alerts list (danger red / warning amber / info navy borders, clickable → onNavigate via safeView), pending approvals cards (ref mono + type/risk badges + summary + «راجعها في المحادثة» → chat), low-stock top 5 with «شوف كل المخزون», pharmacy-only expiring section («منتهية» destructive / «باقي X يوم» amber).
- InventoryView: search (name+aliases) + category Tabs («الكل»+distinct, flex-wrap for mobile) + desktop Table (max-h-[480px] scroll-warm, amber row bg + TriangleAlert + «ناقص» badge, expiry «منتهية»/«قربت») + mobile cards (md:hidden) + footer «إجمالي قيمة المخزون» (valueAtCost ?? cost×qty).
- JournalView: status chips (الكل/مستنية اعتماد/تم/فشلت/ملغاة with counts) + type Select (كل الأنواع + 9 types) + newest-first op cards (ref .num font-mono, TYPE/STATUS/RISK badges — SUCCEEDED teal, AWAITING amber, FAILED_SAFE red, CANCELLED muted — reversal chip «عكس WKL-####» with Link2, userName + arDateTime, failReason/reason), max-h-[560px] scroll-warm.
- AccountsView: two Cards lg:grid-cols-2 — «اللي ليّا عليهم» (teal, name+phone tel:+plan, total big .num) and «اللي علينا للموردين» (amber), row hover bg-muted, friendly empties.
- StatsView: 7d/30d Tabs, 4 KPIs, shadcn Chart (ChartContainer+recharts BarChart): grouped navy/amber/muted bars, Arabic weekday x-axis, compact ar-EG y-axis, custom tooltip with egpPlain; topItems Table + byType rows with share bars.
- ReportsView: printable card — header (businessName prop + الفترة + «مصدر البيانات: سجل العمليات الموثقة» + تاريخ الإنشاء), ملخص الفترة kv, أرباح تقديرية big emerald/red number, byType + topItems tables, «تصدير البيانات» (relative /api/export?businessId=… target=_blank) + «اطبع» (print:hidden).
- SettingsView: (a) الموديلات والمزوّدين — builtin rows (builtin-deep «عميق مفكّر · glm-4.6», builtin-air «خفيف سريع · glm-4.6») + provider cards (name/baseUrl mono ltr/models with TierBadge + SwitchHit + delete AlertDialog) + add-provider Dialog (name/baseUrl/apiKey → «جرب واجلب الموديلات» → 422 Arabic error in destructive Alert, or models step with checkbox+label Input+tier Select+enable Switch → «حفظ المختارة» → saveProviderModels + invalidate); selection = setModel('builtin-*'|'ext:{id}') with localStorage verified. (b) المهام المؤجلة — create form (title + tool Select of the 7 read tools + recurrence يومي/أسبوعي/شهري) + «شغّل المهام المستحقة» (tickTasks + toast + refetch) + task rows (whenLabel + status badge + arDateTime + failReason). (c) ذاكرة وكيل — add (text + kind حقيقة/تفضيل) + list with kind badges.
- QA via temporary __qa.tsx harness (all 7 views + pharmacy Today) + agent-browser headless: every view rendered with live seed data; chip filter, search, model switch (localStorage wakil.modelKey), switch toggle persisted to DB, FULL provider add→edit subset→save→delete round-trip vs mock-provider :3031, task create+tick, memory add, toasts, chart 21 bars + Arabic ticks, dark palette, 390×844 no horizontal overflow, zero console errors. Temp harness + page.tsx swap fully reverted; QA DB rows (1 task, 1 memory) deleted → seed state restored (2 providers, original tasks/memories).
- Fixed during QA: `useToast()` destructure bug (was calling the hook result), api.tasks {tasks:[...]} vs ScheduledTaskDTO[] mismatch (defensive both-shapes), unused Money import, inventory subtitle now shows unfiltered total, Switch → 44×44 SwitchHit wrapper (role=switch + keyboard).
Stage Summary:
- Files: 8 new in src/components/views/ (shared.tsx + 7 view screens, ~2,300 lines total). Nothing outside the folder touched (page.tsx swap temporary + restored byte-identical).
- lint: clean (exit 0). tsc --noEmit: ZERO errors in components/views. Dev server 200, dev.log clean.
- Exported for orchestrator: default exports TodayView/InventoryView/JournalView/AccountsView/StatsView/SettingsView (ViewProps), ReportsView default + optional businessName?: string prop; shared.tsx re-exports ViewProps + all label maps + UI atoms for chat atoms agent if useful.
- ⚠ DEVIATIONS for orchestrator to know: (1) TYPE_AR/STATUS_AR live in views/shared.tsx, NOT imported from '@/lib/agent/tools' — that module pulls Prisma into the browser bundle (verified: client chunk contained @prisma/client index-browser shim + lib/db instantiation). Recommend extracting to client-safe lib/labels.ts and having tools.ts re-export. (2) lib/api.ts `tasks()` is typed ScheduledTaskDTO[] but the route returns {tasks:[…]} — my view handles both; aligning api.ts is a 1-line fix on your side. (3) builtin-air label uses «glm-4.6» per task brief (worklog registry said glm-4.5-air). (4) Toaster in layout is the radix use-toast system (not sonner) — views use useToast from '@/hooks/use-toast'.

---
Task ID: round-12-full-rebuild (R12-g + R12-h orchestrator)
Agent: orchestrator (Z.ai Code)
Task: After sandbox reset wiped the whole app: R12-g (ChatView + AppShell + Onboarding + page.tsx + wiring) + R12-h full browser QA + fixes.

Work Log:
- R12-g: ChatView.tsx (live SSE turn w/ thinking+card+cards+letter-by-letter deltas, smart scroll near-bottom-only, in-chat approvals w/ busy state + verification, ModelPicker dropdown (builtin-deep/builtin-air + ext:{id} from providers query), welcome hero w/ vertical examples). AppShell.tsx (header w/ business+user switcher, alerts badge, dark toggle, desktop nav 8 views, mobile bottom tab bar, sticky footer mt-auto, useSyncExternalStore mounted pattern). Onboarding.tsx (3-step cinematic: pick business → how it works → safety → enter). page.tsx (QueryClientProvider). Fixed ReportsView props + lib/labels.ts (pure client-safe TYPE_AR/STATUS_AR/RISK_META — lib/agent/tools imports Prisma, unusable client-side) + api.tasks() return shape.
- BUGS FOUND & FIXED in QA:
  1. Onboarding crash: VERTICAL_ICONS keyed by vertical key but v.icon gives 'basket'/'sparkle' → undefined component crash → remapped.
  2. CRITICAL: AnimatePresence mode="wait" froze the whole UI — React state updates (step=1) but DOM never re-rendered because framer-motion exit never completes in this environment → removed ALL AnimatePresence (Onboarding + BusinessSwitcher), plain conditional render + enter motion only.
  3. GET /api/chat now syncs historical action cards with CURRENT op status + attaches outcome from op.result (WKL-5011 shows «تم — موثّق ومتحقق» with verification checks after reload; MessageDTO.outcome added).
  4. Arabic \b regex bug (from R12-e): UNIT_WORD_TO_CODE + unitToCode().
- BROWSER QA (agent-browser, all PASSED):
  - Onboarding 3 steps → picked عطارة المسك → entered app.
  - Chat: seeded pending draft shows approve/reject; sent «سجّل بيع ربع كيلو كركديه» → LIVE streaming → draft WKL-5012 بيع ٢٥٠ جرام كركديه بـ٣٠ ج.م (0.12ج/جرام × 250 — REAL price math) → clicked اعتماد → executed → verification shown «المخزون نقص بالمقدار الصح المتوقع ٢٩٬٧٥٠ الفعلي ٢٩٬٧٥٠».
  - Today: live alerts (٢ صنف ناقص/١ عملية مستنية/٨٠ ج مستحقة) + pending approvals + low stock.
  - Inventory 21 rows + Journal WKL refs + Settings (providers + model switches + enable switches).
  - Model switch → external «وكيل خفيف» (ext:) → sent «إيه وضع الخزنة؟» → reply streamed from mock provider :3031 with badge «وكيل خفيف · wakil-mock-air · مزوّد خارجي» + kv card وضع الخزنة (٤٬٧٩٠ ج.م real numbers) + 4 thinking steps persisted.
  - Dark mode class applies; mobile 390×844 NO horizontal overflow.
  - bun run lint clean · tsc zero project errors · dev.log clean (all 200s).

Stage Summary:
- The FULL app is rebuilt and browser-verified end-to-end: 4 verticals, letter-by-letter streaming + visible thinking, deterministic executors w/ verification read-back, risk ladder + approvals (R3 reason gating), BYO providers (validated via /models before save) + live model switching incl. external path through mock provider, all 8 views, onboarding, dark mode, mobile-safe RTL design (warm paper + deep navy + amber).
- Remaining polish for next rounds (cron 462331 every 15min): voice input (ASR/TTS wiring), multi-item single message → multiple drafts, seed timestamps (13:30 future clock) sort after live msgs — cosmetic, sessions list (multi-conversation UI), stats chart refinements, deep-reasoning multi-pass, onboarding video-like intro refinement.
