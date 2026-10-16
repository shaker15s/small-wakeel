# وكيل — Architecture

> The rule that shapes everything: **the model proposes, the server decides.**
> A language model never mutates money, stock or balances directly. It produces a *draft* with structured fields; deterministic TypeScript validates those fields against the real database and only then writes — inside a transaction, with read-back verification.

---

## 1. Layers

```
┌───────────────────────────────────────────────────────────────────────┐
│ UI (React 19, RTL Arabic-first, Tailwind v4, zustand + react-query)   │
└───────────────▲───────────────────────────────────────────────────────┘
                │ /api/* (JSON + SSE), guarded
┌───────────────┴───────────────────────────────────────────────────────┐
│ API layer  src/app/api/**                                             │
│   _lib/guard.ts    token → Origin/CSRF → rate limit → tenant check    │
│   _lib/http.ts     Arabic error envelopes (400/404/500)               │
│   _lib/serialize.ts DB rows → DTOs (dates ISO, piastres ints)         │
│   _lib/dates.ts    Cairo day boundaries (never server-local)          │
│   lib/security/*   zod schemas + parseBody, token compare, buckets    │
└───────────────▲───────────────────────────────────────────────────────┘
                │
┌───────────────┴───────────────────────────────────────────────────────┐
│ Domain      src/lib/domain/**        ← the ONLY code that writes money │
│   executors.ts   draft → atomic claim → transaction → read-back checks │
│   risk.ts        R0..R4 ladder, who may draft / who may approve        │
└───────────────▲───────────────────────────────────────────────────────┘
                │
┌───────────────┴───────────────────────────────────────────────────────┐
│ Agent       src/lib/agent/**                                          │
│   harness.ts   the turn pipeline (intent → ground → draft → verify)   │
│   llm.ts       gateway + fallback ladder + breaker/retry + timeouts   │
│   arabic.ts    dialect normalisation, numbers, units, entity matching  │
│   research.ts  plan → gather → synthesize → cite → self-check         │
│   verify.ts    reply-vs-facts verification                            │
│   tools.ts     the read-tool registry                                 │
│   memory.ts    long-term memory, notes, usage telemetry               │
└───────────────▲───────────────────────────────────────────────────────┘
                │
┌───────────────┴───────────────────────────────────────────────────────┐
│ Data        prisma/schema.prisma (20 models) + @libsql adapter        │
│   ledger: Operation, CashEntry, AuditEvent (append-only by design)    │
│   catalog: Item, Customer, Supplier                                   │
│   agent: Conversation, Message, AgentNote, AgentMemory, ScheduledTask │
│   governance: ModelProvider, ModelConfig, ProviderCapability,         │
│               CustomTool, QuickCommand, UsageEvent, AgentSettings     │
└───────────────────────────────────────────────────────────────────────┘
```

Dependency direction is strictly downwards: the UI never touches Prisma, the domain never touches HTTP, and the agent never writes to the ledger directly.

---

## 2. The turn pipeline (`src/lib/agent/harness.ts`)

A chat turn is a sequence of *passes*, each with a deterministic fallback:

| Pass | What it does | Fallback when the model is unavailable |
|---|---|---|
| 0a Memory | Long-term memory recall + «ورقة وكيل» notes as prompt context | Memories are read from the DB; notes are plain rows |
| 0b Intent | Structured JSON extraction (`intent`, `tool`, `opType`, `fields`) | Arabic rule ladder (`ruleBasedIntent`) covering greetings, reads, writes, price queries, attendance, membership, collections |
| 0c Grounding | Resolve names → real items/customers/suppliers (aliases, dialect forms, units) | `matchEntity` / `findMentions` scoring, exact-word heuristics |
| 0d Research | Plan → gather (own ledger + web) → synthesize → cite → self-check | Skipped with an honest message; never a fabricated report |
| 0e Draft | Server computes the card: quantities × real prices, balances after, cash impact | Deterministic draft builder with the same math |
| 0f Verify | Re-read the written rows, compare with what the reply claims | `verifyReply` fact matching |
| 0g Reflect | «تأمل وكيل» — a deterministic self-critique of the draft *before* it is written (see §2b) | `src/lib/domain/audit.ts` is pure SQL + arithmetic; it cannot be skipped by a model failure |

Everything the model returns is treated as *untrusted input*: fields are validated, numbers recomputed, and unknown enum values rejected.

### Model gateway & fallback ladder (`src/lib/agent/llm.ts`)

* Two sources: the **built-in** gateway (`z-ai-web-dev-sdk`) and **BYO OpenAI-compatible** providers stored per tenant.
* `streamChat` / `completeChat` walk an ordered ladder — requested model → closest-tier enabled BYO model → built-in — with `withRetry` (0/800/2500 ms) and a circuit breaker per `provider:model`.
* Hard timeouts (intent 20 s, reply stream 60 s) so a slow provider can never hang a turn.
* When the ladder switches, the switch is announced in-stream **and** the UI label is rewritten (`llmHealth.servedBy`) so the owner is never told a dead model answered.
* `WAKIL_OFFLINE=1` makes every call fail instantly, which is how the eval suite and CI test the deterministic path.
* **Fail fast on a dead host.** `withRetry` separates *connection* failures (`ECONNREFUSED`/`ENOTFOUND`/`EHOSTUNREACH`, including undici's `cause.code`) from transient hiccups (429/5xx/timeout). A refused socket is never retried: waiting 0/800/2500 ms against a port nobody listens on cost the owner 7 seconds of «بفهم طلبك» before the ladder was even consulted — it is now ~0.1 s straight to the next model.
* **The rule ladder has the last word on writes.** If the model answers with prose (flaky provider, garbled JSON, a small model ignoring the schema) while `ruleBasedIntent` recognises a concrete write, the deterministic intent wins: a clear «بعت ٣ كيلو …» must never be downgraded to chit-chat and lose the sale.
* **Connect failures fail fast and open the breaker at once.** `isConnectFailure` also catches a bare undici `TypeError: fetch failed` (no `cause.code`), so a dead host is attempted ONCE; the circuit breaker's threshold is bypassed for connect-level failures (`breakerRecord(key, false, fatal=true)`) — a host that cannot be reached is not the model the owner is waiting for. Live: 3 attempts with 800/2500 ms backoff → 1 attempt, and the switch notice ««عميق مفكّر» وقع — بكمّل بـ«وكيل عميق»» appears in dev.log with the served model labelled in the UI.
* **A real 5xx IS retried.** `isTransient` matched the English form `status 5xx` only, while the providers throw Arabic messages with a bare number («المزوّد رجع 503») — so a provider hiccup was treated as a deterministic failure and never retried. Found by `tests/unit/resilience.test.ts`, fixed by matching the number in an error-ish context.

### 2b. «تأمل وكيل» — self-critique before the draft (`src/lib/domain/audit.ts`)

Before any draft is created, the agent audits its own work against the ledger and attaches
`audit[]` + a numeric `confidence` to the card. It is *deterministic* — SQL and arithmetic
only, no model — because a hallucinated objection is worse than no objection:

| Code | Question it answers |
|---|---|
| `price_anomaly` | Is this price ≥20 % (warn) / ≥50 % (danger) away from the median of the last 5 same-type priced operations (90-day window), else the catalog price? |
| `oversell` | Is the quantity bigger than the recorded shelf? (danger when nothing is on the shelf) |
| `duplicate` | Did the same type + summary get drafted/succeeded within the last 10 minutes? |
| `overpay` | Is a collection/payment larger than the party's outstanding balance? |
| `expense_spike` | Is this expense >3× the median daily expense of the trailing 30 days? |
| `unknown_entity` | Did a name resolve to nothing in the catalog? |

Findings reach the human at three levels: the card carries them (severity-coloured, above the
approve button, with the real numbers in `detail`), the thinking trace announces «راجعت
المسودة من سجلك — N ملاحظة», and the reply model is instructed to voice each finding.
A **danger** finding escalates the draft to **R3** — the approval then requires a written
reason. `scoreAudit` turns findings into confidence (`100 − 30/danger − 12/warn − 3/info`,
clamped to 20–100); any exception inside the auditor returns «no findings, confidence 80»,
so a faulty audit can never block a legitimate draft.

**Consequence for overselling:** a sale larger than the recorded shelf now *drafts* (flagged,
lower confidence) instead of being refused. A shelf count is usually stale, and the owner must
be able to record what actually happened; refusing the sale silently pushed real revenue out of
the ledger. Cleaning up the count stays the owner's call — the doubt is simply visible.

### 2b-ii. «سوبر باورز» — the tool layer beyond reading (`src/lib/agent/{tools,pipeline,registry,prompt}.ts`)

Five deterministic money/future tools join the twelve read tools. They are
*deterministic on purpose*: the numbers come from the ledger, never from a model.

| tool | question it answers | arithmetic |
| --- | --- | --- |
| `get_profit_margin` | «أنا بربح كام؟» | sold revenue − `costPrice` × qty per item, ranked; falls back to price margins when the window has no sales |
| `forecast_stockout` | «إيه اللي هيخلص؟» | qty ÷ (sold ÷ days) → days left, ≤10 days listed, order = 30-day cover |
| `get_customer_history` | «العميل ده بيحاسب إزاي؟» | balance, last collection, average collection, gap between collections |
| `compare_periods` | «أنا أحسن من الأسبوع اللي فات؟» | two Cairo-day windows, per-type deltas, one verdict |
| `expense_breakdown` | «فلوسي بتتصرف في إيه؟» | expense categories ranked, share %, per-day burn |

Two **orchestration** tools make compound questions cheap:

* `run_plan({plan:[{tool,args}]})` — Programmatic Tool Calling without code
  execution. `normalizePlan` accepts the three shapes models actually send
  (`{plan}`, `{steps}`, `[…]`), **drops every write tool** (the approval gate is
  not bypassable from inside a plan), caps the batch at 6, runs the reads in
  parallel and returns one compact result — three round trips become one.
* `deep_dive({question})` — an **isolated researcher** (`runSubAgent`): its own
  message loop, read tools only, `maxRounds` 3, 12s budget, and it returns a
  SUMMARY plus the numbers it found. The parent context never pays for the
  intermediate reads; a JSON-looking reply with an unknown tool is corrected and
  retried instead of being mistaken for a final answer.

The guarded pipeline (`runToolPipeline`) wraps every read: 9s hard timeout
(Promise.race, never throws), result digest capped at 1.6k chars for the model
while the UI keeps the full card, and a `trimmed` flag so the thinking step can
say «اتقصّرت للسياق». `budgetToolHistory` keeps the newest three results whole
and digests the older ones, logging a `context.compact` audit row when it fires.

### 2b-iii. Reply contracts — the text must agree with the cards

Live evidence (2026-10-17, preview host, providers down) showed a profit table
AND a real draft while the reply said «من رسالتك مفيش عملية محددة». Three rules
now make that impossible:

1. **A draft turn's reply is a contract** — name, summary, amount, the approval
   requirement + the audit's note. Composed deterministically (`جهزتلك مسودة
   «بيع» — بيع ٢ قطعة … راجعها واعتمدها لو تمام.`), verified, then paced. No
   model call: one round trip less and zero chance of prose that disagrees with
   the money.
2. **A read turn's reply must be grounded** — the model may phrase it, but the
   text is buffered and checked with `replyGroundsCards` (a shared figure of ≥2
   digits or a distinctive shared word). Ungrounded prose is replaced by
   `deterministicReadReply(cards)`.
3. **A brain turn that used no tool cannot override the ledger** — when the
   model answers a clearly write- or read-shaped request with prose only, the
   turn falls through to PASS 1 (the deterministic engine) instead of shipping
   the prose.

### 2c. Speed: a 5-second catalog cache (`src/lib/agent/catalog.ts`)

Every turn needs items/customers/suppliers (prompt context, entity resolution, tool results).
They are read through `getCatalog(businessId)` with a 5 s TTL: repeat turns in a burst (the
normal chat pattern) hit memory instead of three queries. Every committed write path
(`executeOperation` after its transaction, `POST /api/items/import`, `POST /api/restore`) calls
`invalidateCatalog`, so the owner's next message always sees post-write numbers; the TTL is
only a safety net. `catalogCacheStats()` (hits/misses/ratio/entries) is exposed on
`GET /api/health` so «is the cache helping?» is measurable, not a belief.

### 2d. Where the milliseconds go

`ThinkingStep.ms` is stamped per pass — understanding, each tool round, verification,
composing — in **both** pipelines (the deterministic one via `done(i)` and the model-driven
«brain» loop, which is the one a real provider exercises). The UI shows the per-step chips and
the total, so «بطيء» becomes a measurement: a dead provider is immediately visible as
`بفهم طلبك 7003 ms` next to `بتحقق من الأرقام 1 ms`.

---

## 2b. Name matching — «لازم نقصد نفس الصنف» (R29)

Every money path resolves names through `matchEntity` (`src/lib/agent/arabic.ts`) and
`lexiconResolve` (`src/lib/agent/memory.ts`), and both are **word-bounded**:

* containment counts only when the needle sits on word boundaries — `«شوكولاتة»`
  contains the letters of `«كولا»`, and a raw `includes()` turned a chocolate
  sentence into a Coca-Cola draft;
* the deterministic per-item scan (`harness.ts`, sale/purchase) uses
  `wordBoundedAt` for the same reason;
* a learned alias must FIT its entity (`aliasFitsEntity`), must not be a category
  word, must not be a customer/supplier name, and must not be claimed by two
  catalog entities (`pruneLexicon`) — otherwise the agent asks instead of guessing;
* loans of trust are one-way: an alias only ever resolves the item whose name it
  actually resembles, and `bun run db:prune-lexicon` keeps the stored rows honest.

## 3. Money & time

* **Integer piastres** end to end; `src/lib/format.ts` renders Arabic numerals and «ج.م». Floats never enter the ledger.
* **Cairo calendar** — `src/app/api/_lib/dates.ts` computes day starts in `Africa/Cairo`, so «النهاردة» means the shop's day, not the server's UTC day. The same helper powers «قرب ينتهي» and membership expiry.
* Quantities keep their unit (`box`, `kg`, `gram`, `milli`, `strip`, `capsule`, `piece`, `session`) and are converted to the item's base unit before any stock movement (`convertToBaseUnit`).

---

## 4. Write path (exactly once, or not at all)

```
POST /api/chat ──► draft card (Operation.status = AWAITING_APPROVAL)
                        │
        POST /api/operations/:id/confirm {action:'approve'}
                        │
        ┌───────────────▼───────────────────────────────────────────┐
        │ updateMany({id, status:'AWAITING_APPROVAL'} → 'EXECUTING')│  atomic claim
        │ count === 0  →  409 «مش في حالة انتظار اعتماد»            │
        └───────────────▲───────────────────────────────────────────┘
                        │
        db.$transaction([ stock, cash, customer/supplier balance, op status ])
                        │
                   read-back checks[] → SUCCEEDED | FAILED
```

* Multi-write operations (sales, purchases, collection, payment) are a **single transaction** — no half-applied sale can exist.
* Drafts are idempotent (`idempotencyKey`), so a retried request returns the same operation instead of creating a second one.
* Rejections and reversals append audit events; history is never rewritten.
* Stuck `running` tasks (crash mid-sweep) are requeued after 10 minutes.

---

## 5. Background work

`src/instrumentation.ts` → `startScheduler()` (nodejs runtime only, guarded so a failure can't break boot):

* one sweep each `WAKIL_SCHEDULER_INTERVAL_MS` (default 60 s) plus a boot sweep after 3 s;
* `runDueTasks()` claims due rows atomically (`pending → running` + `claimedAt`), delivers reminders into the owner's conversation, reschedules daily/weekly/monthly recurrences;
* `requeueStuckTasks()` returns crashed rows to `pending`;
* `POST /api/tasks/tick` is a thin delegate, so an external cron (Vercel, Kubernetes) can drive the same code path;
* `schedulerStatus()` is exposed by `GET /api/health` (`runs`, `lastRunAt`, `lastError`).

---

## 6. Data layer & migrations

* Prisma 6 with `engineType = "client"` + `@prisma/adapter-libsql` — **no Rust engine download required**, which is what makes offline/air-gapped installs possible.
* `scripts/db-sync.ts` derives DDL from `schema.prisma` (via `@prisma/internals` DMMF) and applies it with `@libsql/client`: creates missing tables/columns/indexes, additive only, in one transaction, `--check` for drift. It exists because `prisma migrate` needs engines that a locked-down environment may not have.
* 28+ composite indexes cover every hot path (`[businessId, createdAt]`, `[status, scheduledFor]`, `[businessId, barcode]`, …).
* `db/custom.db` is the shipped demo dataset; `bun run db:snapshot` copies it before any risky operation.

---

## 7. Front-end

* **The reduced-motion contract: «no movement», never «no content».** The R14
  guard applied `opacity: 0 !important` to `.rise-in`, the only entrance class
  the third onboarding screen used — with «تقليل الحركة» on, step 3 was blank
  with no error anywhere. Every content class (`.rise-in`, `.list-enter`,
  `.ae-riser`, `.blur-in`, `.ae-curtain`, `.kinetic-word`, `.odometer`) now keeps
  `opacity: 1 !important` + `animation: none`; only the decorative sheens
  (`.card-sheen::after`, `.ae-sweep::after`) stay hidden. `tests/unit/motion-guard.test.ts`
  parses `globals.css`, brace-matches every reduced-motion block and fails if any
  entrance class is ever hidden again — the bug cannot come back unnoticed.
* **«أفتر إفكتس» motion layer** (`globals.css`, appended): `.ae-riser`
  (staggered riser), `.blur-in` (focus pull), `.ae-curtain` (directional step
  transition via `--enter-x`), `.kinetic-word` (55 ms per-word headline), `.magnetic`
  (pointer pull), `.ae-rail` (progress rail), `.ae-float` (parallax planes),
  `.odometer` (number roll-up), `.ae-sweep` (one-pass sheen on money controls,
  `.ae-sweep-loop` for demo planes). The onboarding is a 3-step cinematic flow on
  top of them; the chat welcome greeting is kinetic; the draft CTA is magnetic +
  swept + pressed.
* **Dead imports are a crash, not a warning.** `tsc` does not flag them and the
  ESLint config does not either — an unused lucide icon emptied a chunk and landed
  the preview in its error boundary. `tests/unit/ui-hygiene.test.ts` walks `src/`
  and asserts every named import is referenced (plus `<body suppressHydrationWarning>`
  for the extension-injected attribute mismatch).

* React 19 + Next 16 App Router, RTL by default (`<html lang="ar" dir="rtl">`).
* State: `zustand` for session/business/user/model, `@tanstack/react-query` for server state, SSE for chat streaming (deltas, thinking steps, cards, `done`).
* No remote fonts and no third-party scripts: system Arabic font stacks only — faster first paint, works offline, nothing leaks to a CDN.
* `Content-Security-Policy` locks scripts/styles to self, and framing is deny-by-default with an explicit allow-list (`WAKIL_EMBED_ORIGINS`, plus the sandbox preview host in dev).

---

## 8. Testing strategy

| Layer | File | What it protects |
|---|---|---|
| Unit | `tests/unit/*.test.ts` | money, Arabic normalisation/units, risk & approval matrix, Cairo dates, security primitives, zod contracts, CSV parsing |
| Integration | `tests/integration/agent-domain.test.ts` | the real executors against a **copy of the real database**: draft → approve → effects; idempotency; concurrent approvals (exactly one wins); tenant isolation |
| Integration | `tests/integration/audit.test.ts` | «تأمل وكيل» against real seeded rows: clean draft = 0 findings, oversell/price-anomaly/overpay/duplicate detection, the auditor never throws, catalog cache TTL + invalidation |
| Integration | `tests/integration/self-critique.test.ts` | the whole turn offline: the card really reaches the wire carrying `audit[]` + `confidence`, a danger finding escalates to **R3**, per-pass `ms` are present, a package size inside an item name is never read as the user's quantity |
| Evals | `tests/evals/run.ts` | 10 real Egyptian-Arabic utterances through the whole turn with `WAKIL_OFFLINE=1`, asserting routing decisions (draft type, read cards, memory writes, honest clarifications) |

The eval suite is the regression net for the parser: every bug it finds becomes a permanent case.

### Isolated test database (`bunfig.toml` → `tests/helpers/preload.ts`)

`src/lib/db` is a module singleton, so whichever module graph loads first decides *which
database* the whole run talks to. Setting `DATABASE_URL` inside a `beforeAll` was not enough:
one test file that imported the singleton at collection time bound the entire suite to the real
`db/custom.db` and quietly wrote its drafts into the owner's demo data (found by watching
pending approvals go 32 → 38 across a single `bun test`). The preload now creates a throwaway
copy and points the environment at it *before any test module loads*; `testDb()` additionally
refuses to hand out a handle unless the URL is inside the temp directory. `bun test` and
`bun run evals` are both proven not to move the demo data.
