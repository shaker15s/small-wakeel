# وكيل — API reference

Base URL: `http://localhost:3000`. All responses are JSON (chat is SSE).
`GET /api` is a deployment-admin index of the primary operational routes. Native auth/operator additions are documented separately below.

## Conventions

* **Guards** — every route runs identity → Origin/CSRF → rate limit → tenant/role. `scope: 'open'` is authenticated discovery, NOT public. Only the explicit `auth` whitelist is public; `admin` requires deployment administration.
* **Errors** — `{ "error": "رسالة بالعربي" }` with `400 / 401 / 402 / 403 / 404 / 409 / 413 / 429 / 500 / 503`. A `409` from `/api/operations/:id/confirm` always carries the operation's real status.
* **Money** — integers in **piastres** (1 EGP = 100 piastres) unless a field says otherwise.
* **Dates** — ISO-8601 UTC strings in responses; «today» boundaries are computed in `Africa/Cairo`.
* **Caching** — responses under `/api/*` are `Cache-Control: no-store`.

## Endpoints

### System

| Method | Path | Notes |
|---|---|---|
| GET | `/api` | Self-documenting index, version, live counts. Scope: deployment admin. |
| GET | `/api/health` | `status`, DB latency + counts, scheduler state, enabled models, security summary. Scope: deployment admin. 503 when DB is down; degraded for >25 drafts or operational alerts. Operator-only `operational` aggregates include queue/worker age, fenced mail heartbeat, financial EXECUTING and mail configuration/failure alerts; `externalDelivery:not_probed`. 200 is not proof of delivery. |
| GET | `/api/usage?businessId&days=1..90` | Performance ledger: per-kind count, `latencyP50/P95`, `ttftP50`, tokens, `fallbackRate`, slowest/most-used labels, daily volume. |

### Session & catalog

| Method | Path | Notes |
|---|---|---|
| GET | `/api/bootstrap` | Only authenticated tenant/user, model metadata and deploymentAdmin UI flag. Scope: authenticated open; no provider keys. |
| GET | `/api/overview?businessId&userId` | Today's dashboard: cash position, low stock, expiring, receivables, payables, recent operations, alerts. |
| GET | `/api/items?businessId` | Full catalog with `daysToExpiry`, `valueAtCost`, `barcode`. |
| POST | `/api/items/import` | `{ businessId, userId, csv, updateExisting?, dryRun? }` → `{ created, updated, skipped, unknownHeaders, errors[] }`. Arabic headers, Arabic-Indic digits, `;`/tab/`،` delimiters, quoted fields, EGP→piastres conversion, name-normalised matching, one transaction, one audit event. |
| GET | `/api/members?businessId` | Customers/members with balances and membership expiry. |
| GET | `/api/search?businessId&q&limit` | One search over items, customers, suppliers, operations and notes. Arabic-normalised, ranked, grouped: `{ total, groups, results[] }`. |
| GET | `/api/reports?businessId&range=7d\|30d` | Sales/purchases/expenses totals, top items, cash flow, per-day series. |
| GET | `/api/suggestions?businessId&userId` | Contextual next actions (reorder, collect, expire). |
| GET | `/api/radar?businessId&userId` | Anomaly/attention alerts (price jumps, unusual drafts, stale debts). |
| GET | `/api/export?businessId` | Owner-only logical export (`business`, items, customers, suppliers, operations, cashEntries, auditEvents). Not all DB/account/security tables; not a supported full-ledger restore format. Use SQLite snapshots for complete recovery. |
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


## Native SaaS / operator entitlements

See [SAAS.md](SAAS.md) for request semantics/security/limits and actual provisioning requirements.

| Method | Path | Identity / purpose |
|---|---|---|
| GET | `/api/auth/config` | Public; native mode/signup readiness flags only. |
| POST | `/api/auth/register` | Public + canonical Origin; email/password/name and businessName/type, or an email-bound invitation token for joining directly. Issues HttpOnly cookie + csrfToken, never raw session JSON. |
| POST | `/api/auth/login` | Public + canonical Origin; email/password; cookie or an opaque MFA challenge. |
| POST | `/api/auth/login-mfa` | Public + canonical Origin; token (challenge) + code (TOTP/recovery); issues cookie. |
| POST | `/api/auth/request-reset` | Public + canonical Origin; email; uniform message, real 503 if mail unconfigured. |
| POST | `/api/auth/reset` | Public + canonical Origin; token + password; revokes all sessions, retains enabled MFA. |
| POST | `/api/auth/verify` | Public + canonical Origin; one-time token, no consumption through GET. |
| GET | `/api/auth/me`, `/api/auth/sessions` | Native session; safe account/membership/subscription/CSRF metadata and own active sessions. |
| GET | `/api/auth/team` | Native management team context; members/pending invitations, never password/session/MFA secrets. |
| POST | `/api/auth/logout`, `/api/auth/logout-all` | Native session + CSRF/Origin; server revocation + cookie expiry. |
| POST | `/api/auth/switch` | Native + CSRF/Origin; membershipId belonging to the account; session rotation. |
| POST | `/api/auth/create-workspace` | Native verified account + CSRF/Origin; businessName/type; blank trial, max three owned workspaces. |
| POST | `/api/auth/resend-verification` | Native + CSRF/Origin; queues fresh verification link. |
| POST | `/api/auth/invite` | Native verified management + CSRF/Origin; email + permitted role. |
| POST | `/api/auth/accept-invite` | Native + CSRF/Origin; token must match account email; rotates session. |
| POST | `/api/auth/revoke-invite` | Native verified management + CSRF/Origin; invitationId, tenant/creator-bound. |
| POST | `/api/auth/member-update` | Native verified owner + CSRF/Origin; target userId with role and/or disabled string (`true`/`false`); no owner changes. |
| POST | `/api/auth/change-password` | Native + CSRF/Origin; currentPassword/password/code (if MFA enabled); all sessions revoked. |
| POST | `/api/auth/mfa-setup`, `/api/auth/mfa-enable`, `/api/auth/mfa-disable` | Native + CSRF/Origin + currentPassword; setup returns TOTP secret, enable proves code and returns recovery codes once, disable also needs valid MFA. |
| POST | `/api/auth/revoke-session` | Native + CSRF/Origin; own sessionId only. |
| POST | `/api/admin/subscriptions` | Explicit deployment-admin Bearer credential; validated manual entitlement + reason, atomic audit, `paymentProcessed: false`. |

All auth POST bodies are streaming-bounded at 16 KB, field lengths are validated. Subscription expiry gives 402 on business writes; exhausted daily chat attempts give 429. Business reads still require ordinary tenant/RBAC authorization. These endpoints do not constitute a payment integration or proof of mail delivery.

### Execution and streaming recovery boundaries

Financial approval claim/effects/verification/terminal audit now commit in one SQLite transaction, with savepoint rollback for FAILED_SAFE and terminal-result recovery after a lost commit acknowledgement. Duplicate committed approval remains 409. Historical EXECUTING is never automatically reset.

Chat SSE cancellation stops transport without throwing on enqueue/close; bounded work may finish on a live server for same-turn replay. Actual browser abort/replay is tested, **not durable chat across process death** or every incomplete/concurrent turn. Each HTTP attempt still counts against daily quota.
