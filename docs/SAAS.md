# وكيل — Native SaaS implementation and operator guide

**18 October 2026.** This is implemented application code, not a proposed identity design. It is still **not approval for public paid launch**. See [current verification](SAAS_VERIFICATION_2026-10-18.md), [security](SECURITY.md) and [operations](OPERATIONS.md).

For the Arabic release-gate matrix, recovery acceptance criteria, staging/rollback procedure and operator sign-off checklist, see [وثيقة استكمال وإطلاق SaaS](SAAS_LAUNCH_PLAN_AR.md). It describes remaining work, not additional completed features.

## What now exists

- Arabic email/password signup/login, confirmation/reset links, optional TOTP MFA and ten single-use recovery codes. Password reset preserves enabled MFA. Signup makes a **blank** workspace (zero opening cash, no synthetic staff/catalog/sales). An email-bound invitation can instead create an account directly in that team, without a surplus owned workspace.
- One global `Account` → `Membership` → one per-business `User`/role. Existing demo/pilot users are **never claimed** by matching a name/email. An account can own at most three workspaces; switching rotates the current session. Other devices retain their own selected membership.
- Hashed, revocable opaque sessions; no session token in JSON, browser storage or query strings. Production uses `__Host-wakil_session`, HttpOnly, Secure, SameSite=Lax, Path=/, no Domain. Seven-day absolute and 24-hour idle expiration; at most ten live sessions/account.
- Cookie writes require the canonical application Origin **and** a constant-time-checked CSRF header. Auth links carry one-time tokens in a URL **fragment**, are consumed only by an explicit POST/button and have a reset/verification/invitation lifetime of 30 minutes/24 hours/72 hours.
- Verified email, live account/membership and an active subscription are required for business writes. Domain checks also apply when agent tools bypass an HTTP handler. Disabled membership/role changes revoke that membership's sessions; logout-all and password/security changes revoke account sessions. Subsequent requests must reauthenticate; this is not cancellation of every already-running HTTP request.
- Owner team administration: email-bound invitations, reception/cashier/supervisor roles, revocation, suspension/reactivation. Supervisors cannot grant a supervisor role. No invitation/member-update can grant or alter an owner. Pending invitations reserve seats; reactivation cannot spend those reserved seats.
- Trial: **14 days, 5 active/reserved seats, 50 chat HTTP attempts per workspace per UTC day**. Retries/replays count, even when they do not call a model. This is a server request allowance, **not token metering or monetary billing**. Persistent counters are transactionally checked. Trial expiry/suspension blocks business mutations; authorized reads/export remain available. Existing RBAC still governs export (owner only); the existing JSON export is catalog data, not a full financial/account backup.
- Explicit, audited **operator-managed contracts**, not pretend checkout. A deployment administrator can change seats, request cap, trial or manual active/suspended entitlement. Customer ownership is never deployment-admin authority. There are no card collections, payment webhooks, automated renewals, invoices, tax calculations or refunds in this implementation.
- Encrypted durable mail outbox, a packaged one-shot worker, retry/backoff, stale-lease fencing, retention and idempotency keys. Provider/MFA/pending-MFA/outbox encryption rotates together in one offline transaction.

The interface is integrated with the real app: unauthenticated access → native login, fragment links → explicit action screen, and Settings → account/team/workspace/MFA/session controls. Verification/expired-plan notices are visible across the app, not only after a failed write. Global provider administration is not presented to native customer sessions. Existing controlled-pilot API credentials remain supported for explicit operator integration.

## Configuration

Start with `.env.example`. Provision secrets **outside Git, SQLite, browser code and chat**:

```dotenv
WAKIL_SAAS_ENABLED=1
WAKIL_SIGNUP_ENABLED=1
WAKIL_APP_URL=https://your-owned-domain.example
WAKIL_ALLOWED_ORIGINS=https://your-owned-domain.example
# Configure privately: WAKIL_MAIL_ENDPOINT, WAKIL_MAIL_TOKEN, WAKIL_SECRETS_KEY.
DATABASE_URL=file:/persistent/wakil/wakil.db
WAKIL_SCHEDULER=off
```

`WAKIL_APP_URL` is the canonical HTTPS origin used by browser sessions and email links. Configure the reverse proxy accordingly, and strip/replace user-supplied forwarding headers. General per-IP route buckets are process-local; persistent authentication throttles and daily tenant quotas use SQLite. Distributed password guessing is also limited per email account, MFA attempts per challenge/account and reset mail per email. These controls are not a hosted WAF, bot-detection service or multi-region rate limiter.

Public signup stays disabled unless **both flags and syntactically valid mail/key/HTTPS configuration** exist. Config readiness is not a successful-delivery probe. Missing mail produces a real 503, not a fake success. Existing users can still log in when public signup is disabled. An invitation does not bypass the signup flag for new accounts. Account reset gives the same outward response for existing/nonexisting email; no constant-latency non-enumeration claim is made.

### Mail gateway contract

`WAKIL_MAIL_ENDPOINT` must be a public HTTPS endpoint you operate or provision. No embedded URL credentials, private/loopback DNS destinations or redirect forwarding. The pinned transport checks every DNS answer at socket lookup, not only before a later unchecked fetch.

The worker POSTs JSON `{ "to": "…", "subject": "…", "text": "…" }` with `Authorization: Bearer <WAKIL_MAIL_TOKEN>` and `Idempotency-Key: <stable-outbox-id>`. Subject controls/newlines are removed. Security-message text is a plain action URL; it is not user HTML. Return a 2xx response **only after accepting the message durably**. Implement idempotency on this key; delivery is at-least-once, not exactly-once. Configure real sender identity, SPF/DKIM/DMARC, bounce/complaint handling, service limits and monitoring at the gateway/provider.

No commercial mail vendor, domain or credentials have been provisioned by this change. Tests use a stub transport, or inspect encrypted fixture mail; they do not send external mail.

### Worker / housekeeping

Schedule once per minute, with the **same durable database and encryption key** as the web process:

```bash
# Source checkout (Bun 1.3.11):
bun run mail:deliver
# Production image / packaged build, working directory /app:
bun maintenance/mail-worker.js
```

Use your host's cron/job supervisor, or an equivalent trusted container job mounting the same persistent volume and secret injection. The web server does not schedule this worker automatically. Compose includes an opt-in `mail` profile with a supervised one-minute loop (`docker compose --profile mail up -d` after build/offline migration and real configuration). It shares the DB volume/key; a job failure exits for restart/monitoring. The web service still needs an explicit operator credential for its health probe. Docker/Compose execution was not available in this sandbox. Monitor nonzero exits and queue age/failed counts; a successfully empty batch is not a successful-delivery certification. Batches default to 20 messages, maximum 50; delivery timeout is 10 seconds. Five attempts with exponential backoff; a sending lease older than five minutes becomes eligible again. Completions are fenced by the claimed lease and cannot overwrite a later owner. An exhausted crashed lease becomes failed. Failed messages remain encrypted until link expiry, then their payload is scrubbed. Request a fresh link after resolving delivery failure.

Housekeeping occurs **only when this job runs**: pending MFA setup expires after ten minutes; auth throttle metadata after 24 hours; expired tokens/sessions after 30 days beyond expiration; quota buckets and terminal mail metadata after 90 days. Sent/expired payloads are scrubbed. Account/business/audit/financial data are not automatically erased by this job. Self-service account deletion, comprehensive retention/consent policy and regulatory/legal approval remain release work.

## Offline schema migration

All modes, including existing pilot/demo installations, must apply the additive versioned migration before running this revision. The base checked-in synthetic DB intentionally remains unmigrated; tests migrate disposable copies. This is not a new empty-database bootstrap: start with the application's existing base schema. Never seed over customer data.

1. Stop the web server, mail job, scheduler and **all** other DB writers.
2. Take an online-consistent SQLite snapshot, preserve the old application artifact and external encryption key separately; test a restore copy first.
3. Use an explicit absolute local SQLite URL:

```bash
DATABASE_URL=file:/absolute/path/wakil.db bun run db:migrate
# In the production image, from /app:
DATABASE_URL=file:/absolute/path/wakil.db bun maintenance/migrate.js
```

4. Check schema/date storage, DB integrity and foreign keys, then start the new version and verify authenticated reads/flows before reopening signup.

Migrations use a checksummed ledger and an immediate SQLite transaction; a changed applied migration is refused. No automatic API-startup migration, demo identity claiming or destructive reset. `db:sync` is a development drift helper, not this migration procedure. The migration CLI currently supports local SQLite files only; remote libsql/serverless/horizontal deployment needs a separately validated migration/storage/job design.

## Manual subscription administration

Only an explicit `WAKIL_AUTH_CREDENTIALS` deployment administrator may POST `/api/admin/subscriptions`. Native cookies are deliberately never admin credentials, even for owners. Supply a private Bearer header and JSON:

```json
{
  "businessId": "an-actual-business-id",
  "plan": "manual",
  "status": "active",
  "trialEndsAt": "2026-11-01T00:00:00.000Z",
  "seatLimit": 10,
  "dailyChatLimit": 200,
  "reason": "Operator-approved contract reference, recorded outside this sample"
}
```

`trial` pairs with `trialing`; `manual` pairs with `active` or `suspended`. A manual active contract **does not auto-expire** at `trialEndsAt`; that field controls trialing only. The operator must explicitly suspend it when entitlement ends. No money is processed (`paymentProcessed: false`). Do not interpret this response as payment or invoice evidence. Lowering seats below current active members plus pending invitations is refused with 409. Updates and a `saas.subscription.operator_updated` audit record commit together. Preserve contractual/payment evidence outside this API; never include bank/card secrets in the audit reason. A complete paid-billing lifecycle still requires a chosen provider and verified webhooks/reconciliation.

## External-key rotation

`secrets:rotate` / `maintenance/rotate-provider-secrets.js` now cover **all four** encrypted data classes: provider keys, MFA secrets, pending MFA secrets and unsent mail payloads. Dry-run validates decryptability without modifying SQLite. Apply re-encrypts atomically with compare-and-swap checks; no plaintext/key logging.

Stop **all writers/workers**, snapshot and preserve the old external key, then privately inject the old `WAKIL_SECRETS_KEY` and new `WAKIL_NEW_SECRETS_KEY`:

```bash
DATABASE_URL=file:/absolute/path/wakil.db bun run secrets:rotate
DATABASE_URL=file:/absolute/path/wakil.db bun run secrets:rotate --apply
# Packaged equivalents: bun maintenance/rotate-provider-secrets.js [--apply]
```

Deploy the **new** key everywhere before restarting; the script does not modify your secret store. Keep old keys only with the historical backups that need them, under your retention/access policy. A lost key cannot be reconstructed from SQLite. Legacy plaintext provider conversion is a separately controlled offline maintenance run with `NODE_ENV=development` (to permit legacy reads), a valid new key and a staged restore verification; production rejects plaintext reads. Never enable public traffic in development mode.

## Recovery and operational diagnostics

`bun run build:maintenance` packages five source-independent Bun entrypoints: migration, key rotation, mail worker, SQLite snapshot and restore quarantine. After schema/client changes rebuild the standalone artifact too; an old standalone Prisma client cannot operate on the new WorkerHeartbeat model.

`db:snapshot` / `maintenance/db-snapshot.js --output <new-file>` require an explicit absolute local DATABASE_URL. Readonly SQLite VACUUM INTO creates a consistent full DB snapshot without mutating the source, exclusive/no-overwrite, private directory (0700) and output (0600). The snapshot contains plaintext customer PII; encrypt off-host storage and preserve matching external key versions separately.

`recovery:quarantine` / `maintenance/restore-quarantine.js` are OFFLINE restored-copy containment, dry-run unless --apply. Stop ALL writers. Apply disables all native accounts, revokes sessions/links, scrubs mail payload and pending MFA and clears worker heartbeat; active MFA is preserved. Reconcile post-backup identities/passwords/MFA/roles/revocations, entitlements and financial deltas with trusted evidence before controlled reactivation. No automatic account reactivation and no change to external pilot/operator credentials. See OPERATIONS.

The checksummed operations migration adds WorkerHeartbeat. Mail-worker start/completion is fenced by runId. Operator-only `/api/health` includes aggregate queue states/age, worker last-completion age and alerts for stale/missing/failed worker, delayed/terminal-failed mail, EXECUTING and signup without mail configuration. A configured expected worker is stale after 300 seconds. These are diagnostics, not push alerts or delivery probes (`externalDelivery:not_probed`); polling/paging/job supervision remain deployment work.

## Verification / still not delivered

`bun run ci` now includes real Chromium financial/native identity journeys and SSE cancellation/replay, financial process SIGKILL/reopen proof, tests/evals, synthetic full-DB restore, standalone HTTP/SSR, and all five packaged maintenance jobs. See [latest evidence](SAAS_VERIFICATION_2026-10-18.md): 391 tests / 1731 assertions plus separate process/browser checks.

The financial claim/effects/terminal audit now share one transaction; the former separate-claim crash gap is closed for the new path on tested local storage. Historical EXECUTING requires manual reconciliation. Continuing a disconnected SSE turn on a live server is not durable chat execution across process death.

Not certified: real mail/DNS/delivery, Docker or production-volume/power-loss/full-disk recovery, remote CI/release artifact, payment services/reconciliation, external connectors, complete endpoint/tool/field policy, comprehensive accessibility/load testing, legal/retention/account-deletion policy or HA architecture. No public paid launch approval.

آخر إضافة وظيفية: [التخصيص الحقيقي ومعرفة الأنشطة ونتيجة اختبار الموديل الحي](WORKSPACE_BRAIN_ACCEPTANCE_2026-10-18_AR.md). قبول الموديل الحي حاليًا blocked، منفصل عن نجاح الاختبارات المحلية.
