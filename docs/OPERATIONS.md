# وكيل — Controlled pilot operations

**Not a public launch runbook approval.** Read [SECURITY.md](SECURITY.md) and [current SaaS verification](SAAS_VERIFICATION_2026-10-18.md) and [SaaS operations](SAAS.md) first. Commands below assume synthetic data until the remaining release gates are closed.

## 1. Reproducible local gate

Use Bun **1.3.11** and Node **22**:

```bash
bun install --frozen-lockfile
bun run ci             # complete gate, including build + production boot
bun run ci:fast        # explicitly skips build / production HTTP + screens
```

The full gate checks schema drift/date storage without modifying the source DB; tests/evals, backup rehearsal and the production smoke use temporary copies. The production HTTP smoke also exercises financial confirmations on fixture drafts and one complete offline Arabic chat expense/approval/replay flow. SSR covers live/empty/error inputs separately from real headless Chromium: signup/verify/invite/MFA, Arabic expense approval, role/tenant denial, desktop navigation, mobile RTL and actual SSE abort/replay. Financial SIGKILL/reopen checkpoints also run before the build. All use disposable synthetic data, not external mail/payment/model services. The active workflow is `.github/workflows/ci.yml`, with the same commands and an uploaded SHA-labelled log. Require `CI / launch-gate` in GitHub repository rules separately.

`bun run lint` covers app-owned code and currently reports existing unused-disable warnings. Vendored CLI-Anything sources are outside this lint gate.

## 2. Development only

```bash
cp .env.example .env
DATABASE_URL="file:$PWD/db/custom.db" bun run db:migrate # explicit; writes the selected dev DB
bun run dev                   # bound to 0.0.0.0:3000
bun run db:sync --check        # read-only additive drift detector
bun run db:normalize-dates --check
bun run db:generate            # engine-free Prisma generation
```

The checked-in DB is a synthetic showcase. `bun run db:seed` **replaces demo state**; never run it on customer data. `db:push --accept-data-loss` and `db:reset` are destructive developer tools, not production migration procedures. `db:sync` supports additive changes only and is not a versioned migration engine.

There is no supported local BYO/mock provider bypass: provider URLs must be public HTTPS. Use `WAKIL_OFFLINE=1` for deterministic local testing. Offline evals prove routing for the current ten cases, not model/tool-calling capability.

## 3. Pilot production configuration

Before `bun run build && bun run start`:

- Explicit **absolute** `DATABASE_URL=file:/persistent/path/wakil.db` on a persistent volume.
- Either native SaaS configuration from [SAAS.md](SAAS.md), or `WAKIL_AUTH_CREDENTIALS` containing hashed per-user pilot credentials bound to existing users. Customer ownership never grants deployment administration. No shared `WAKIL_ACCESS_TOKEN` fallback in production.
- Apply the versioned migration with writers stopped and an explicit absolute SQLite path, even for existing pilot installations. External `WAKIL_SECRETS_KEY` covers provider/MFA/mail data; rotate all envelopes with the updated offline script, never provider rows alone. Migrate legacy plaintext provider keys offline before enabling them.
- `WAKIL_ALLOWED_ORIGINS` matching the HTTPS dashboard; review forwarding headers at the reverse proxy.
- Keep `WAKIL_SCHEDULER=off` until the deployment's scheduling/retry/delivery architecture has been tested.
- Consider `WAKIL_STRICT_APPROVALS=1` (management-only approvals, **not** four-eyes segregation; management can approve its own drafts). Review the capability matrix in SECURITY.md and the remaining endpoint/tool read/write policy.

The web app shows native SaaS login when enabled, or pilot credential entry on 401/403 instead of loading forever. Only pilot bearer credentials are tab-scoped; native sessions are revocable HttpOnly cookies. Bootstrap shows only the authenticated user and shop; development actor switching is not a login mechanism.

`docker compose up --build` requires credentials, the external key, a health credential and allowed origins in the operator environment. Compose defaults the scheduler off and uses strict approvals. The old unverified internal mock provider is not provisioned. **Docker/container execution has not been verified in this sandbox.**

### Health

`/api/health` is deployment-admin-only (global counts/diagnostics). Configure `WAKIL_HEALTH_TOKEN` with a valid admin credential for the container healthcheck. Do not log this value. For manual probes use a private operator environment:

```bash
curl --fail --silent --show-error "$BASE/api/health" \
  -H "Authorization: Bearer $WAKIL_HEALTH_TOKEN"
```

200 = DB reachable (healthy or degraded); 503 = DB unavailable; 401/403 = credential/configuration failure. Inspect `operational.alerts`, not just HTTP status. Alerts cover EXECUTING, oldest pending mail >300s, terminal-failed mail, failed worker, missing/stale worker completion (>300s when SaaS/mail are configured), and signup without configured mail. Heartbeat completion is runId-fenced. Aggregates exclude recipients/payload/secrets; `externalDelivery:not_probed`. Configure a trusted external poller/pager and schedule the one-shot worker frequently enough. Heartbeat is job execution, not inbox delivery or provider connectivity. Test scheduling/restarts and actual delivery separately.

## 4. Full DB snapshots and restore

Do not copy only a live SQLite main file while WAL/writers may be active. Logical `/api/export` includes catalog and operation/cash/audit data, but not every table/account/security state; `/api/restore` imports catalog only, never the ledger. Neither replaces full-DB recovery.

```bash
# Explicit path and output are required; destination must not already exist.
DATABASE_URL=file:/persistent/path/wakil.db \
  bun run db:snapshot --output /secure-backups/wakil-2026-10-17.db

# Rehearsal against a disposable COPY of the synthetic showcase only:
bun run backup:drill
```

`db:snapshot` (or packaged `bun maintenance/db-snapshot.js --output <new-file>`) uses readonly SQLite `VACUUM INTO` for a consistent local snapshot; private directory mode 0700, exclusive output 0600, no overwrite. The DB snapshot contains plaintext PII despite encrypted secret fields. Copy snapshots off-host using encrypted storage and restricted access. Preserve the external provider/MFA/mail encryption keys separately. The automated **synthetic** drill restores a snapshot and compares integrity, foreign keys, schema, every table count and cash/stock aggregates. It does not prove the production volume, off-host retention or keys can be recovered.

Deployment restore procedure (must be rehearsed before customer data):
1. Disable inbound writes/scheduler and stop the service. Preserve the failed DB for investigation.
2. Restore the complete snapshot to a **new path**, not over the only remaining source copy.
3. Supply the appropriate external key. Run integrity/FK/schema/date read-only gates, apply reviewed additive migrations offline if required, then quarantine BEFORE starting web or mail. Source: `DATABASE_URL=file:/absolute/restored/wakil.db bun run recovery:quarantine`, inspect dry-run, then repeat with `--apply`. Packaged: `bun maintenance/restore-quarantine.js [--apply]`.
4. Apply disables ALL native accounts, revokes sessions/links, scrubs queued mail and pending MFA, clears heartbeat and preserves active MFA/finance. It does not revoke external pilot/operator credentials. A restored backup may resurrect revoked roles, old passwords/MFA/recovery codes or entitlements: reconcile all post-backup security changes against trusted evidence. No automatic reactivation; do not enable accounts just because integrity passed. Disabling signup alone does not contain old sessions.
5. Reconcile operation counts, cash/debt/stock and lost/duplicate external effects against the manifest and post-backup evidence. Probe active MFA/provider decryption without exposing secrets; issue fresh security links only after authorized identity recovery, never replay the old outbox. Approve controlled reactivation under an operator-reviewed recovery procedure.
6. Start one isolated instance, verify authenticated reads and a synthetic financial flow, then switch traffic only after approval. Record recovery time, snapshot age/data loss, operator and artifact SHA. Set actual RPO/RTO/retention targets; none are certified locally.

For schema changes: back up, test on a restored copy, use reviewed versioned migrations/forward fixes, and keep a rollback path. Do not treat `db:sync` as a safe rename/drop/data-transformation system.

## 5. Incidents / kill switches

- **Provider unavailable:** admin probe, check sanitized diagnostics, revoke compromised upstream key; `WAKIL_OFFLINE=1` disables model calls but does not make arbitrary financial actions safe.
- **Unverified desktop connector:** expected `409 not_connected`. Do not mark it connected, register a pretend adapter or propose inventory settlements without external evidence.
- **Credential compromised:** remove its hash from `WAKIL_AUTH_CREDENTIALS` and redeploy/reload configuration; revoke upstream provider keys separately where needed.
- **Scheduler delivery failure:** disable scheduler and external automation; the general in-process task scheduler is not a certified durable job system. The new mail outbox is separate and has its own worker/lease protocol. Do not blindly replay financial writes.
- **Unknown financial outcome / stuck `EXECUTING`:** stop approvals and preserve a consistent snapshot. Inspect operation status, payload, cash rows, balances/stock and audit history. The new execution path commits claim/effects/terminal status/audit together; synthetic SIGKILL proof covers pre/postcommit, but does not retroactively repair historical rows or certify the target disk. Do not reset/reapprove it blindly or assume an old pre-hardening operation has the new guarantees. Reconcile with an operator-reviewed procedure; do not invent a safe outcome when storage is unavailable. Local SSE interruption and financial process-kill proofs now pass, but durable chat across process loss and production-volume acceptance remain open.
- **Database corrupt/locked:** stop writes, preserve forensic copy, follow the rehearsed full snapshot restore procedure. A catalog JSON import is not ledger recovery.

## 6. Remaining acceptance gates

The local full gate includes financial Chromium/SSE abort-replay and financial SIGKILL/reopen proofs, not production readiness. Remaining: complete endpoint/tool/field RBAC matrix; production identity/mail/abuse acceptance; paid billing/reconciliation if sold; external connector read-back; real volume/container/backup/off-host keys/quarantine rehearsal and RPO/RTO; external monitoring/paging and scheduler soak; memory/forget, accessibility/keyboard/screen-reader and load tests; privacy/retention/account deletion and human release signoff. Keep public paid launch **NO-GO** until release-SHA evidence closes the relevant gates.


## Native SaaS addition — 18 October 2026

[SAAS.md](SAAS.md) is the operative account/team/trial/manual-contract/mail/migration/key-rotation runbook. `bun run build` now creates source-independent Bun maintenance jobs; the Dockerfile copies them under `/app/maintenance`. Packaged-job smoke tests run without access to `src`/`tsconfig`, including provider+MFA+pending-MFA+outbox rotation, wrong-key refusal, dry-run, migration checksum checks and worker housekeeping. This is **not** evidence that Docker was run here. The production smoke boots native HTTP and a fourth native-SaaS server behind local TLS for Chromium and tests real cookies/CSRF/invitations/MFA/reset/expiry/quotas, using encrypted test outbox links rather than external email.

Schedule the mail worker through a trusted operator job against the same persistent DB/key. Compose now exposes an opt-in `mail` worker profile; the web process does not autonomously run the job; merely setting mail variables cannot deliver messages. Keep public signup closed until end-to-end mail reception and monitoring have been proved on the actual domain.
