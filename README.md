# وكيل — Wakil

**An Arabic-first AI operations agent for Egyptian small businesses.**
The owner talks; the agent drafts; the server executes deterministically and verifies every number against the ledger.

> «بعت ٢ علبة لبن لأم حسن بـ٩٥ جنيه» → مسودة عملية → اعتماد → خصم مخزون + قيد خزنة + مديونية عميل، وكل رقم متحقق منه من قاعدة البيانات.

Four verticals ship in the seed data — **سوبر ماركت، عطارة، صيدلية، جيم** — each with its own vocabulary, units and workflows.

> **Launch status:** synthetic-data / controlled pilot hardening only. **NO-GO for paid public SaaS or unsupervised real financial records.** See [verification and remaining blockers](docs/LAUNCH_VERIFICATION_2026-10-17.md). CLI-Anything host discovery is not an external connector; unverified bridges return `not_connected`.
> **Native SaaS now implemented (18 Oct 2026):** accounts, secure sessions, verification/reset/MFA, teams/invitations, isolated workspaces, trial/limits, manual operator contracts and encrypted mail jobs. See [SaaS guide](docs/SAAS.md), [current verification](docs/SAAS_VERIFICATION_2026-10-18.md), and [خطة الاستكمال والإطلاق](docs/SAAS_LAUNCH_PLAN_AR.md). No electronic payment or real mail delivery is claimed. Local gates now include Chromium E2E, SSE abort/replay, financial SIGKILL recovery and packaged quarantine/snapshots; hosted release and real infrastructure acceptance remain open.

> **Brain/harness upgrade:** versioned prompt contract, real-role recent dialogue, actor-scoped semantic memory, bounded model requests/streams, honest draft/denial outcomes, canonical tool deduplication and accessible evidence-led chat states. The full local gate now passes **446 tests** plus Chromium/process checks. [تفاصيل التطوير وحدود التحقق](docs/BRAIN_HARNESS_2026-10-18_AR.md). Model-boundary tests are synthetic, not a claim of live-model quality or latency.
> **Real workspace upgrade (2026-10-18):** actor-scoped persisted onboarding/preferences, usage-driven non-demo suggestions, consent-gated recurring READ reports, safe chat-driven analytics styling, fast/deep controls, permission-gated bounded plugins, and sourced playbooks for all nine presets. No automatic mock web search. `bun run model:acceptance` is a separate strict LIVE inference gate: **currently blocked**, not passed by offline fallbacks. [Implementation, evidence and migration notes](docs/WORKSPACE_BRAIN_ACCEPTANCE_2026-10-18_AR.md) · [Research sources](docs/BUSINESS_KNOWLEDGE_2026-10-18_AR.md). Original demo DB is preserved; newly created workspaces are blank.
> **Manual-shop cashbook (2026-10-18):** attar/supermarket defaults now prioritize one-cashier cash/debt bookkeeping, itemless credit/cash purchases, lending/borrowing, physical drawer closing with **unclassified variance—not sales**, occurrence/promise dates, contextual goods reminders and ledger-checked overdue questions. New responsive Today/review/report flows are backed by the approval/atomic accounting machinery. Full local gate: **446 passed**, actual Chromium count/approval/mobile proof included. Persisted multi-turn financial clarification, single-utterance spoken amounts, atomic pre-approval draft corrections, nonce-bound duplicate-account choices, date-filtered due queries, personal revision-checked restock checklists, actionable daily promise/shortage review, read-only background audits, approval-only promise revisions/history, and unified legacy/new debt settlements are now included. Voice supports browser dictation plus real record/replay/consented server-ASR upload with admin-selected transcription models and review-only text. Live model inference remains blocked; no ASR is selected in the test environment, so **live microphone/recognition quality is not verified**. `bun run voice:acceptance` is a separate strict real-audio gate. [التنفيذ والأمثلة ودليل التحقق والحدود](docs/CASHBOOK_ACCEPTANCE_2026-10-18_AR.md). Original DB unchanged; no deploy.



---

## Why this is not «another chatbot»

| Concern | How Wakil answers it |
|---|---|
| **A model must never invent money** | Every write is a *draft* (`AWAITING_APPROVAL`) with a server-computed card. The LLM and staff propose; **the owner approves by default**; deterministic TypeScript executes (`src/lib/domain/executors.ts`). Cashiers/reception cannot approve. Supervisors may approve only R1/R2 if an operator explicitly enables `WAKIL_ALLOW_DELEGATED_APPROVALS=1`; R3 remains owner-only. Approval is an atomic compare-and-set: an operation executes **exactly once**, and effects land in a single DB transaction. |
| **Verified answers** | `src/lib/agent/verify.ts` re-reads the database after a write and checks the numbers it reported (`checks[]`), so the reply can't drift from the ledger. |
| **Arabic that Egyptians actually type** | Dialect normalisation, Arabic-Indic digits, word-numbers («نص كيلو»), broken plurals («النواقص»), unit conversion, alias matching — see `src/lib/agent/arabic.ts` and the golden eval suite. |
| **Model outages must not stop the shop** | A fallback ladder walks the requested model → the closest-tier enabled BYO model → the built-in gateway, announces the switch, and only then drops to the deterministic rule ladder (`WAKIL_OFFLINE=1` reproduces that path in tests). |
| **The reply must agree with the cards** | A draft turn's reply is a *contract* composed deterministically (operation, amount, approval requirement); a read turn's reply is buffered and **grounded** — if the model's prose shares no figure or distinctive word with the cards, the deterministic summary replaces it. |
| **Money math** | Integer **piastres** everywhere (1 EGP = 100 piastres). No floats in the ledger. |
| **Time** | Every operational «today» is a **Cairo** day (`src/app/api/_lib/dates.ts`), never the server's UTC day. The separate SaaS request allowance resets at UTC midnight. |

---

## Quickstart

```bash
bun install --frozen-lockfile # Bun 1.3.11; Node 22
# Optional: cp .env.example .env   # DATABASE_URL=file:./db/custom.db
bun run db:generate        # Prisma client (works offline — see scripts/prisma-generate.sh)
bun run dev                # http://localhost:3000
```

The committed `db/custom.db` is kept schema-synchronized (CI gate: `db:sync --check`), and
`bun dev` **auto-migrates local `file:` databases at startup** (idempotent `_WakilMigration`
ledger; dev-only, `WAKIL_AUTO_MIGRATE=0` opts out) — so a fresh clone serves with
`bun install && bun dev` alone. Production deployments still run the explicit
`DATABASE_URL="file:$PWD/db/custom.db" bun run db:migrate` step in the runbook.

For deterministic local testing set `WAKIL_OFFLINE=1`. BYO providers require public HTTPS; the old localhost mock provider is not a supported connector and is no longer offered by Compose.

### Quality gates

```bash
bun run typecheck   # tsc --noEmit, strict
bun run lint        # eslint (next/core-web-vitals + React Compiler rules)
bun test            # unit + real-DB integration tests
bun run evals       # golden Arabic dataset through the whole agent turn
bun run check       # typecheck + lint + tests
bun run db:sync --check   # schema drift gate (exit 1 when drift)
```

`bun run ci` runs frozen install → Prisma → migrations on a disposable copy → schema/date checks → synthetic backup restore → typecheck → lint → tests → financial SIGKILL/reopen proof → offline evals → build → production financial/SaaS HTTP + server-rendered screens + real Chromium → five packaged maintenance jobs. `bun run ci:fast` explicitly skips build/boot/screens.
The active workflow is [`.github/workflows/ci.yml`](.github/workflows/ci.yml), with an exact reference copy in `docs/ci`. GitHub execution and required-check branch rules must be verified separately on the release SHA; local green gates do not prove remote CI ran.

---

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | `file:./db/custom.db` | SQLite file (libsql driver adapter). Any `file:`/`libsql:` URL works. |
| `WAKIL_AUTH_CREDENTIALS` | *(unset)* | Hashed per-user pilot/operator credentials. Native SaaS cookie sessions are a separate identity path; absent both, production fails closed. See `docs/SECURITY.md`. |
| `WAKIL_SECRETS_KEY` | *(unset)* | External 64-hex AES key for provider, MFA and mail secrets. |
| `WAKIL_ACCESS_TOKEN` | *(unset)* | Optional **development demo only** shared token. Not production identity. |
| `WAKIL_ALLOWED_ORIGINS` | *(unset)* | Extra origins allowed to call the API (CSRF guard). Same-origin is always allowed. |
| `WAKIL_STRICT_APPROVALS` | `0` | `1` = every R1/R2 needs management; managers may approve their own drafts (not four-eyes). |
| `WAKIL_OFFLINE` | `0` | `1` = every model call fails instantly (deterministic ladder; used by evals/CI). |
| `WAKIL_SCHEDULER` | `on` | `off` disables the in-process due-task sweep. |
| `WAKIL_SCHEDULER_INTERVAL_MS` | `60000` | Sweep interval (floor 5 s). |
| `WAKIL_RATE_LIMIT*` | 600/120/40 per min | Read / write / chat token buckets. |
| `WAKIL_EMBED_ORIGINS` | *(unset)* | Origins allowed to iframe the app (`https://*.e2b.app` is allowed in dev). |
| `WAKIL_SAAS_ENABLED` / `WAKIL_SIGNUP_ENABLED` | `0` | Opt in to native accounts / public signup; signup also requires real mail/key/HTTPS configuration. |
| `WAKIL_APP_URL` | *(unset)* | Canonical HTTPS origin for cookie writes and security links. |
| `WAKIL_MAIL_ENDPOINT` / `WAKIL_MAIL_TOKEN` | *(unset)* | Public HTTPS JSON mail gateway + private token; scheduled worker required. See [SAAS](docs/SAAS.md). |

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
5. **Self-critique («تأمل وكيل»)** — *before* the draft is written, a deterministic auditor checks it against your own ledger: price vs. the median of the last 5 same-type operations, quantity vs. the recorded shelf, possible duplicates in the last 10 minutes, collections larger than the debt, expense spikes. The findings ride on the card (severity-coloured, with the real numbers), lower a visible **confidence** score, and a dangerous one escalates the draft to **R3** — approval then needs a written reason.
6. **Verification** — after execution the executor re-reads the rows and returns `checks[]`; the reply only reports numbers that passed.
7. **Telemetry & timing** — every turn writes a `UsageEvent` (latency, TTFT, tokens, fallback) → `GET /api/usage`, and the thinking trace carries a **measured duration per pass** (understanding, tools, verification, composing) so slowness is diagnosable instead of felt.

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
- A self-critiquing agent: every draft arrives with the doubts it found and how confident it is — the owner decides with the objection in front of him, not after the money moved.
- **«سوبر باورز»** — tools the shop actually asks for, all deterministic: real profit margin per item, stockout forecasting («هيخلص خلال ٣ أيام»), a customer's payment behaviour, period-over-period comparison, and where the cash goes.
- **Compound questions in one round trip** — `run_plan` (a safe, read-only Programmatic Tool Calling subset) runs up to six reads in parallel and answers «مبيعات الأسبوع وربحه والنواقص» as one batch; `deep_dive` spins an **isolated researcher** that returns only its summary and the numbers it found.
- **Accuracy beats refusal** — a sale larger than the recorded stock drafts anyway (the shelf count is often stale); the agent attaches the finding, drops its confidence, and escalates to a written reason when the stock is zero. A package size inside an item's name («زيت عافية 800 مل») is identity, not a measurement.

**For the engineer**
- Strict TypeScript, boundary validation and lint gates for app-owned code. Existing lint warnings and broader authorization/validation gaps are documented; vendored CLI-Anything is not covered by app lint.
- Unit and integration tests run against a disposable SQLite copy, plus **10 offline Arabic routing evals**. New security regressions cover each exported HTTP handler, production identity/tenant denials, provider URL/DNS policy, key encryption and fail-closed bridges. See the dated verification report for actual results, not a fixed marketing test count.
- Speed is measured, not claimed: a 5-second catalog cache with write-through invalidation and hit/miss stats on `GET /api/health`; unreachable providers fail fast instead of burning the retry budget (7 s → ~0.1 s in the live preview).
- Engine-free Prisma setup for offline/air-gapped installs (`scripts/db-sync.ts`, `scripts/prisma-generate.sh`).
- Additive-only migrations, indexed query paths, `no-store` on all API responses, CSP + security headers.

---

## Deployment

```bash
bun run build            # next build (type errors fail the build)
bun run start            # standalone :3000; production identity config required
```

- Docker: see [pilot configuration](docs/OPERATIONS.md); an unconfigured production container refuses API access.
- Compose: `docker compose up --build` requires per-user credentials, external encryption key, admin health credential and HTTPS origin in the operator environment. No mock service. Container execution is not verified by the local gate.
- Health probe: admin-authenticated `GET /api/health` (200 reachable/degraded, 503 DB unavailable; 401/403 invalid identity/permissions).

**Backups** — the SQLite file *is* the product state:

```bash
DATABASE_URL=file:/persistent/wakil.db bun run db:snapshot --output /secure-backups/wakil.db
bun run backup:drill                      # synthetic full-DB restore rehearsal
# JSON export includes financial data; catalog import cannot restore the ledger.
# Full recovery uses DB snapshots + key versions + quarantine/reconciliation. See docs/OPERATIONS.md.
```

---

## Contributing

Arabic-language comments are welcome and expected in product code — the domain vocabulary is Arabic.
Before opening a PR: `bun run check && bun run evals && bun run db:sync --check`.
Add a golden eval case for every parsing behaviour you change; that suite exists because a regression («ليه» inside «عليه» hijacking a collection into a deep-research report) reached the demo.
