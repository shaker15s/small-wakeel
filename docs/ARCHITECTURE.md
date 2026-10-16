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

Everything the model returns is treated as *untrusted input*: fields are validated, numbers recomputed, and unknown enum values rejected.

### Model gateway & fallback ladder (`src/lib/agent/llm.ts`)

* Two sources: the **built-in** gateway (`z-ai-web-dev-sdk`) and **BYO OpenAI-compatible** providers stored per tenant.
* `streamChat` / `completeChat` walk an ordered ladder — requested model → closest-tier enabled BYO model → built-in — with `withRetry` (0/800/2500 ms) and a circuit breaker per `provider:model`.
* Hard timeouts (intent 20 s, reply stream 60 s) so a slow provider can never hang a turn.
* When the ladder switches, the switch is announced in-stream **and** the UI label is rewritten (`llmHealth.servedBy`) so the owner is never told a dead model answered.
* `WAKIL_OFFLINE=1` makes every call fail instantly, which is how the eval suite and CI test the deterministic path.

---

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
| Evals | `tests/evals/run.ts` | 10 real Egyptian-Arabic utterances through the whole turn with `WAKIL_OFFLINE=1`, asserting routing decisions (draft type, read cards, memory writes, honest clarifications) |

The eval suite is the regression net for the parser: every bug it finds becomes a permanent case.
