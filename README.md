# وكيل — Wakil

**An Arabic-first AI operations agent for Egyptian small businesses.**
The owner talks; the agent drafts; the server executes deterministically and verifies every number against the ledger.

> «بعت ٢ علبة لبن لأم حسن بـ٩٥ جنيه» → مسودة عملية → اعتماد → خصم مخزون + قيد خزنة + مديونية عميل، وكل رقم متحقق منه من قاعدة البيانات.

Four verticals ship in the seed data — **سوبر ماركت، عطارة، صيدلية، جيم** — each with its own vocabulary, units and workflows.

---

## Why this is not «another chatbot»

| Concern | How Wakil answers it |
|---|---|
| **A model must never invent money** | Every write is a *draft* (`AWAITING_APPROVAL`) with a server-computed card. The LLM proposes; deterministic TypeScript executes (`src/lib/domain/executors.ts`). Approve is an atomic compare-and-set: an operation can execute **exactly once**, and every effect lands in a single DB transaction. |
| **Verified answers** | `src/lib/agent/verify.ts` re-reads the database after a write and checks the numbers it reported (`checks[]`), so the reply can't drift from the ledger. |
| **Arabic that Egyptians actually type** | Dialect normalisation, Arabic-Indic digits, word-numbers («نص كيلو»), broken plurals («النواقص»), unit conversion, alias matching — see `src/lib/agent/arabic.ts` and the golden eval suite. |
| **Model outages must not stop the shop** | A fallback ladder walks the requested model → the closest-tier enabled BYO model → the built-in gateway, announces the switch, and only then drops to the deterministic rule ladder (`WAKIL_OFFLINE=1` reproduces that path in tests). |
| **Money math** | Integer **piastres** everywhere (1 EGP = 100 piastres). No floats in the ledger. |
| **Time** | Every «today» is a **Cairo** day (`src/app/api/_lib/dates.ts`), never the server's UTC day. |

---

## Quickstart

```bash
bun install                # or: npm install
cp .env.example .env       # DATABASE_URL=file:./db/custom.db
bun run db:generate        # Prisma client (works offline — see scripts/prisma-generate.sh)
bun run db:sync            # additive schema push, no engines required
bun run db:seed            # 4 demo businesses, catalogs, customers, history
bun run dev                # http://localhost:3000
```

Optional — a local OpenAI-compatible model so the agent has a real LLM:

```bash
cd mini-services/mock-provider && bun install && bun --hot index.ts   # :3031
```

Then point a provider at it from the UI (الموديلات → مزوّد جديد → `http://localhost:3031/v1`).

### Quality gates

```bash
bun run typecheck   # tsc --noEmit, strict
bun run lint        # eslint (next/core-web-vitals + React Compiler rules)
bun test            # unit + real-DB integration tests
bun run evals       # golden Arabic dataset through the whole agent turn
bun run check       # typecheck + lint + tests
bun run db:sync --check   # schema drift gate (exit 1 when drift)
```

`bun run ci` runs the whole gate locally (install → prisma → drift → typecheck → lint → tests → evals → build); `bun run ci:fast` skips the build.
CI runs the same script — copy [`docs/ci/github-actions.yml`](docs/ci/github-actions.yml) to `.github/workflows/ci.yml` to enable it (pushing workflow files needs a token with the `workflow` scope).

---

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | `file:./db/custom.db` | SQLite file (libsql driver adapter). Any `file:`/`libsql:` URL works. |
| `WAKIL_ACCESS_TOKEN` | *(unset)* | When set, every `/api/*` call must present it (header, `?token=`, or cookie). Unset = local demo mode. |
| `WAKIL_ALLOWED_ORIGINS` | *(unset)* | Extra origins allowed to call the API (CSRF guard). Same-origin is always allowed. |
| `WAKIL_STRICT_APPROVALS` | `0` | `1` = nobody approves their own write; every R1/R2 needs owner/supervisor. |
| `WAKIL_OFFLINE` | `0` | `1` = every model call fails instantly (deterministic ladder; used by evals/CI). |
| `WAKIL_SCHEDULER` | `on` | `off` disables the in-process due-task sweep. |
| `WAKIL_SCHEDULER_INTERVAL_MS` | `60000` | Sweep interval (floor 5 s). |
| `WAKIL_RATE_LIMIT*` | 600/120/40 per min | Read / write / chat token buckets. |
| `WAKIL_EMBED_ORIGINS` | *(unset)* | Origins allowed to iframe the app (`https://*.e2b.app` is allowed in dev). |
| `WAKIL_LOCAL_WEBHOOKS` | `0` | `1` allows tenant webhooks to target private/loopback addresses (SSRF guard otherwise blocks them). |

Full list with commentary: [`.env.example`](.env.example).

---

## Architecture at a glance

```
src/app/api/**            thin HTTP layer: guard → zod → domain → DTO
src/app/api/_lib/*        guard (token/origin/rate/tenant), http helpers, serializers, Cairo dates
src/lib/agent/*           harness (the turn pipeline), llm gateway + fallback ladder, arabic, research, verify…
src/lib/domain/*          executors (the only code that mutates money), risk matrix
src/lib/tasks/*           due-task runner (reminders, recurrences)
src/lib/scheduler.ts      in-process sweep, started from src/instrumentation.ts
src/components/**         React UI (RTL, Arabic-first, mobile-first)
prisma/schema.prisma      20 models — the whole product state
scripts/db-sync.ts        engine-free schema push / drift check
tests/                    unit · integration (real DB copy) · evals (golden Arabic dataset)
```

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/SECURITY.md](docs/SECURITY.md) · [docs/OPERATIONS.md](docs/OPERATIONS.md) · [docs/API.md](docs/API.md)

---

## The turn pipeline (why answers are trustworthy)

1. **Memory + context** — business vertical, item/customer/supplier catalogs, long-term memories, open drafts.
2. **Intent** — LLM structured extraction with a deterministic Arabic rule ladder as the safety net (`ruleBasedIntent`), plus a compound-intent splitter for «بعت واشتريت».
3. **Grounding** — the intent is resolved against the **real** catalog (names, aliases, units, prices). Unknown entities trigger a clarifying question, never a guessed write.
4. **Draft or read** — writes become a card with server-computed numbers; reads run the tool registry.
5. **Verification** — after execution the executor re-reads the rows and returns `checks[]`; the reply only reports numbers that passed.
6. **Telemetry** — every turn writes a `UsageEvent` (latency, TTFT, tokens, fallback) → `GET /api/usage`.

---

## Features

**For the shop owner**
- Conversation-first operations: sale, purchase, expense, collection, payment, stock adjustment, membership, attendance, reversal.
- Approvals with a risk ladder (R0–R4), written reasons for high-risk writes, and an audit trail for everything.
- Inventory: low stock, expiry tracking, CSV/Excel import with Arabic headers, barcode field, valuation.
- Customers/suppliers with balances; gym memberships with expiry radar.
- Scheduled reminders & recurring tasks, delivered by the agent itself.
- Deep research reports (plan → gather from your own ledger → web → cited synthesis → self-check).
- «ورقة وكيل» scratchpad notes, «أدوات بتاعتك» custom web sources/webhooks, quick commands, model picker with live capability probing.
- Reports (7d/30d), suggestions, radar alerts, global search, JSON export, catalog restore.

**For the engineer**
- Strict TypeScript, zod at every boundary, ESLint clean, no dead code or unused dependency.
- Real tests: 61 unit tests, integration tests against a copy of the real DB, 10 golden-dataset evals of the Arabic pipeline.
- Engine-free Prisma setup for offline/air-gapped installs (`scripts/db-sync.ts`, `scripts/prisma-generate.sh`).
- Additive-only migrations, indexed query paths, `no-store` on all API responses, CSP + security headers.

---

## Deployment

```bash
bun run build            # next build (type errors fail the build)
bun run start            # standalone server on :3000
```

- Docker: `docker build -t wakil . && docker run -p 3000:3000 -v wakil-db:/app/db wakil`
- Compose (app + mock model provider): `docker compose up --build`
- Health probe: `GET /api/health` (200 healthy · `degraded` with a backlog of drafts · 503 when the DB is unreachable).

**Backups** — the SQLite file *is* the product state:

```bash
bun run db:snapshot                       # timestamped copy into db/
curl -s "$BASE/api/export?businessId=…" > backup.json
curl -s -X POST "$BASE/api/restore" -d @backup.json   # mode=preview first!
```

---

## Contributing

Arabic-language comments are welcome and expected in product code — the domain vocabulary is Arabic.
Before opening a PR: `bun run check && bun run evals && bun run db:sync --check`.
Add a golden eval case for every parsing behaviour you change; that suite exists because a regression («ليه» inside «عليه» hijacking a collection into a deep-research report) reached the demo.
