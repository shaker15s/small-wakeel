# وكيل — Security model

Threat model: a multi-tenant shop assistant that can move money, holds customer/supplier debts and speaks to third-party model providers. The interesting adversaries are (1) a malicious or curious employee of the same shop, (2) another tenant, (3) a compromised model provider, and (4) someone who reaches the app from the internet.

---

## 1. Request gate — every `/api/*` call

`src/app/api/_lib/guard.ts` runs, in order:

| Step | Check | Failure |
|---|---|---|
| 1 | **Access token** — `WAKIL_ACCESS_TOKEN` when configured, accepted via `Authorization: Bearer`, `x-wakil-token`, `?token=` or `wakil_token` cookie. Comparison is constant-time (`safeEqual`). | `401` |
| 2 | **Origin / CSRF** — non-GET requests must come from the same origin or an origin in `WAKIL_ALLOWED_ORIGINS`. Requests without an `Origin` header (curl, cron, server-to-server) are allowed because they cannot carry a victim's cookies. | `403` |
| 3 | **Rate limit** — token buckets per client IP × class: read 600/min (burst 120), write 120/min (burst 40), chat 40/min (burst 12). Configurable via `WAKIL_RATE_LIMIT*`. | `429` + `Retry-After` |
| 4 | **Tenant** — the `businessId` (and `userId`) in the request is resolved against the database, and the user **must belong to that business**. Nothing downstream trusts an id that has not passed this check. Ownership for row-level operations (notes, tools, memories, conversations, quick commands) is verified against the row's own `businessId`, so guessing an id from another shop yields `404/403`, never data. | `403` / `404` |

Guards are declared **per route with an explicit scope**, so forgetting one is a code-review-visible omission:
`guard(req, { businessId, userId })` (actor) · `guard(req, { businessId, scope: 'business' })` (tenant data) · `guard(req, { scope: 'open' })` (public index/health/probe).

## 2. Input validation

* **zod at every boundary** (`src/lib/security/validate.ts`) — ids, Arabic text limits, piastres ranges, http(s)-only URLs, enum allow-lists, arrays with hard caps.
* `parseBody()` collapses malformed JSON / wrong shapes into a single Arabic message that names the offending field.
* Prompt-injection defence: chat text is length-capped, control characters are stripped, and model output is *data* — the agent's structured JSON is validated, recomputed and grounded against the database before it can become a draft.
* Uploaded/imported data (CSV, JSON restore) is size-capped, row-capped, and validated per row.

## 3. Money paths

* A write needs a draft **and** an approve step; approval is an atomic `AWAITING_APPROVAL → EXECUTING` claim, so replay/duplicate approval cannot double-execute.
* The risk ladder (R0–R4) decides *who may draft* and *who may approve*; R3 requires a written reason; R4 is never approvable.
* `WAKIL_STRICT_APPROVALS=1` enforces segregation of duties (no role approves its own class of write).
* Every effect is one transaction and is verified by a read-back (`checks[]`).
* The ledger (`Operation`, `CashEntry`, `AuditEvent`) is append-only: no endpoint rewrites or deletes history, and `/api/restore` explicitly refuses to touch it.

## 4. Secrets & providers

* Model provider API keys live server-side only. Read endpoints serialize providers *without* the key; the agent gateway holds them in memory for the duration of a call.
* Provider URLs must be `http(s)` and are SSRF-guarded: loopback/private ranges are refused unless the operator opts in with `WAKIL_LOCAL_WEBHOOKS=1` (needed for the bundled mock provider on `localhost:3031`). Tenant webhooks are **read-only data fetches** — they never trigger actions.
* `z-ai-web-dev-sdk` credentials are read from the environment, never persisted.
* `.env`, `.env.*` are git-ignored (`.env.example` documents every variable).

## 5. Browser-side

* CSP: `default-src 'self'`, no remote script/style/font/connect origins, `object-src 'none'`, `base-uri 'self'`.
* Framing: `frame-ancestors 'self'` by default, with an explicit embed allow-list (`WAKIL_EMBED_ORIGINS`, plus `https://*.e2b.app` in development for sandbox previews). `X-Frame-Options: DENY` is sent whenever no wildcard embedder is allowed.
* Plus `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera off, microphone self), and HSTS in production.
* API responses are `Cache-Control: no-store` — tenant data never sits in a shared cache or the browser's back/forward cache.
* No third-party scripts, no remote fonts, no analytics beacons.

## 6. What is intentionally *not* here (and what to add before multi-user hosting)

| Gap | Why it is acceptable now | Add before public hosting |
|---|---|---|
| Single shared access token instead of per-user sessions | The product is a per-shop install; everyone using it is in the same room | Real login (per-user credentials + signed session cookie), password/2FA for the owner |
| SQLite file as the store | One shop = one file, trivially backed up and audited | Managed Postgres (change `DATABASE_URL` + provider to `postgresql`) |
| In-memory rate limits | Single process | Redis-backed buckets when running more than one instance |
| No encryption at rest | The file lives on the shop's own machine | Disk encryption / managed DB encryption |
| Arabic free-text audit reasons | Human review by the owner | Structured reasons + notifications on R3/R4 |

## 7. Dependency hygiene

* Dependencies are pinned by `bun.lock`; CI installs with `--frozen-lockfile` where the
  environment allows it, so a build never silently picks up a new transitive version.
* `package.json` carries `overrides` for the dev-tooling chains (eslint → minimatch/ajv, the
  Babel chain behind `eslint-config-next`, `humanfs`, `baseline-browser-mapping`). Those
  advisories are DoS-in-a-linter, i.e. **not** reachable from the running app, but they turn
  Dependabot red and train people to ignore alerts — so they are pinned to the patched
  releases and the alert noise stays meaningful.
* Runtime dependencies (`next`, `@prisma/client`, `@libsql/client`, `zod`, `framer-motion`)
  are deliberately few; the browser bundle never talks to a model provider, so a provider-side
  compromise cannot reach the client.
* `bun audit` on the stale lockfile in an offline sandbox is **not** a security signal: it
  audits whatever the lock still lists. Read Dependabot on the default branch, or regenerate
  the lock first.

## 8. Reporting a vulnerability

Open a private security advisory on the repository (GitHub → Security → Advisories) with reproduction steps. Please do not post exploits publicly before a fix ships.
