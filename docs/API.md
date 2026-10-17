# وكيل — API reference

Base URL: `http://localhost:3000`. All responses are JSON (chat is SSE).
`GET /api` returns the live index of every route below.

## Conventions

* **Guards** — every route runs `token → origin → rate limit → tenant`. `scope: 'open'` marks the few public routes.
* **Errors** — `{ "error": "رسالة بالعربي" }` with `400 / 401 / 403 / 404 / 409 / 429 / 500`. A `409` from `/api/operations/:id/confirm` always carries the operation's real status.
* **Money** — integers in **piastres** (1 EGP = 100 piastres) unless a field says otherwise.
* **Dates** — ISO-8601 UTC strings in responses; «today» boundaries are computed in `Africa/Cairo`.
* **Caching** — responses under `/api/*` are `Cache-Control: no-store`.

## Endpoints

### System

| Method | Path | Notes |
|---|---|---|
| GET | `/api` | Self-documenting index, version, live counts. Scope: open. |
| GET | `/api/health` | `status`, DB latency + counts, scheduler state, enabled models, security summary. Scope: open. 503 when the DB is down, `degraded` when >25 drafts wait. |
| GET | `/api/usage?businessId&days=1..90` | Performance ledger: per-kind count, `latencyP50/P95`, `ttftP50`, tokens, `fallbackRate`, slowest/most-used labels, daily volume. |

### Session & catalog

| Method | Path | Notes |
|---|---|---|
| GET | `/api/bootstrap` | Businesses, users, providers, settings for the client. Scope: open (ids are random cuids; no secrets). |
| GET | `/api/overview?businessId&userId` | Today's dashboard: cash position, low stock, expiring, receivables, payables, recent operations, alerts. |
| GET | `/api/items?businessId` | Full catalog with `daysToExpiry`, `valueAtCost`, `barcode`. |
| POST | `/api/items/import` | `{ businessId, userId, csv, updateExisting?, dryRun? }` → `{ created, updated, skipped, unknownHeaders, errors[] }`. Arabic headers, Arabic-Indic digits, `;`/tab/`،` delimiters, quoted fields, EGP→piastres conversion, name-normalised matching, one transaction, one audit event. |
| GET | `/api/members?businessId` | Customers/members with balances and membership expiry. |
| GET | `/api/search?businessId&q&limit` | One search over items, customers, suppliers, operations and notes. Arabic-normalised, ranked, grouped: `{ total, groups, results[] }`. |
| GET | `/api/reports?businessId&range=7d\|30d` | Sales/purchases/expenses totals, top items, cash flow, per-day series. |
| GET | `/api/suggestions?businessId&userId` | Contextual next actions (reorder, collect, expire). |
| GET | `/api/radar?businessId&userId` | Anomaly/attention alerts (price jumps, unusual drafts, stale debts). |
| GET | `/api/export?businessId` | Full JSON backup (`business`, items, customers, suppliers, operations, cashEntries, auditEvents). |
| POST | `/api/restore` | `{ businessId, userId, mode:'preview'\|'merge', items?, customers?, suppliers? }`. Catalog only — never the ledger. |

### Operations (money)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/operations?businessId&status&limit` | Ledger with cards, risk level, verification checks. |
| POST | `/api/operations/:id/confirm` | `{ action: 'approve'\|'reject'\|'cancel', userId, reason? }`. `approve` claims the operation atomically; duplicates return `409` with the current status. R3 requires a reason. |

### Agent

| Method | Path | Notes |
|---|---|---|
| POST | `/api/chat` | SSE turn. Events: `start`, `thinking` (step list), `step`, `delta` (text), `card` (draft/result), `cards`, `actions`, `done` (`verified`, `research`, `notesUpdated`, `modelLabel`). |
| GET | `/api/chat?businessId&userId&conversationId` | Message history for a conversation. |
| GET/POST/PATCH/DELETE | `/api/conversations` | Conversation CRUD (archive/pin/rename). |
| GET/POST/PATCH/DELETE | `/api/memories` | Long-term memory («فاكر إن…») with entity refs and confidence. |
| GET/POST/PATCH/DELETE | `/api/notes` | «ورقة وكيل» scratchpad notes (fact/hypothesis/todo/plan/citation). |
| GET/POST/PATCH/DELETE | `/api/tools` | «أدوات بتاعتك» — tenant web sources and read-only webhooks (SSRF-guarded). |
| GET/POST | `/api/tasks` | Scheduled tasks/reminders. |
| POST | `/api/tasks/tick` | Run due tasks now (cron-friendly). Returns `{ ran, due, failed, requeued, details }`. |
| GET/POST/PATCH/DELETE | `/api/quick-commands` | Owner-defined quick commands. |
| GET/POST | `/api/providers` | Model providers (keys are never returned). |
| POST/DELETE | `/api/providers/:id` | Update/delete a provider and its models. |
| POST | `/api/providers/probe` | `{ modelConfigId }` → streaming check with TTFT/TPS, stored as a capability row the model ladder prefers. |

## Examples

```bash
BIZ=$(curl -s localhost:3000/api/bootstrap | jq -r '.businesses[0].id')
USR=$(curl -s localhost:3000/api/bootstrap | jq -r '.businesses[0].users[0].id')

# 1. Ask the agent something (SSE)
curl -N -X POST localhost:3000/api/chat -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BIZ\",\"userId\":\"$USR\",\"text\":\"بعت ٢ علبة لبن لأم حسن بـ٩٥ جنيه\"}"

# 2. Approve the draft it returned
curl -s -X POST localhost:3000/api/operations/$OP/confirm -H 'content-type: application/json' \
  -d "{\"action\":\"approve\",\"userId\":\"$USR\"}" | jq

# 3. Import a catalog from a spreadsheet export
curl -s -X POST localhost:3000/api/items/import -H 'content-type: application/json' \
  -d "{\"businessId\":\"$BIZ\",\"userId\":\"$USR\",\"dryRun\":true,\"csv\":\"$(cat stock.csv)\"}" | jq

# 4. Search everything
curl -s "localhost:3000/api/search?businessId=$BIZ&q=لبن" | jq '.groups, .results[0]'
```

When `WAKIL_ACCESS_TOKEN` is set, add `-H "x-wakil-token: $TOKEN"` to every request.
