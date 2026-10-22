# وكيل — Security model and remaining release blockers

**Status: controlled synthetic-data pilot hardening, NOT approval for paid public SaaS.** See [current SaaS verification](SAAS_VERIFICATION_2026-10-18.md) and [the financial launch verification](LAUNCH_VERIFICATION_2026-10-17.md). This document describes implemented boundaries, not a security certification.

## 1. Request identity

Every exported API HTTP handler must await `guard()` and return its failure. Tests inspect each handler, not merely its enclosing file.

### Development/demo

With no `WAKIL_AUTH_CREDENTIALS` and `WAKIL_SAAS_ENABLED` off, development/test may use the seeded actor picker. `WAKIL_ACCESS_TOKEN` is an optional shared demo shell (header, query or cookie); it is **not user authentication**. Never expose this mode to customers or use real financial data in it.

### Production / controlled pilot

`NODE_ENV=production` **always** requires identity: native SaaS cookies (when enabled) or explicit per-user pilot credentials. The following bearer-credential section describes only the pilot/operator path. `WAKIL_AUTH_CREDENTIALS` also enables it in development. Absent, malformed, empty or ambiguous credential configuration fails closed; the shared demo token cannot override this.

The configuration is a JSON array of `{ "userId": "existing-db-user-id", "tokenHash": "64-lowercase-sha256-hex", "admin": false }`. Each user must have a different cryptographically random token (at least 32 characters; recommend 32 random bytes encoded as hex). Only the SHA-256 hash is configured server-side. Use an operator secret store/environment, not the database, Git, issue comments or chat.

An operator can generate a token and its hash locally:

```bash
node -e 'const c=require("node:crypto"); const token=c.randomBytes(32).toString("hex"); console.log(JSON.stringify({token,tokenHash:c.createHash("sha256").update(token).digest("hex")}))'
```

Deliver the raw token privately. Pilot credentials accept only `Authorization: Bearer` / `x-wakil-token`, **not query strings or legacy token cookies**; native SaaS uses its own HttpOnly session cookie. The production web entry screen accepts the user's key and stores it in **sessionStorage for that tab**, not a sharing URL. Reload on credential change clears the previous React Query cache. Closing the tab removes its credential. This pilot bearer credential is still accessible to same-origin JavaScript and should not be the customer SaaS identity path. Native SaaS now implements revocable HttpOnly sessions, logout and MFA; XSS resistance and independent release acceptance remain essential. A managed identity provider is optional rather than falsely treated as implemented.

On every request the guard loads the configured DB user and current business membership. All supplied actor IDs (including conflicting body/query options and headers) must match. Deleting the user or removing the configured hash revokes subsequent requests. `bootstrap` returns only that business and that user; its initial discovery request does not replay stale actor-picker headers.

### Native SaaS sessions

See [SAAS.md](SAAS.md) for configuration, exact lifetimes, mail/rotation procedures and limitations. Passwords use salted scrypt (N=32768,r=8,p=1); concurrent hashing is bounded. Session tokens and one-time links are stored hashed; MFA and queued mail are AES-GCM encrypted with an external key. TOTP rejects replay; recovery codes are hashed, single-use and shown once. Reset does not disable MFA. Production session cookies are HttpOnly/Secure/__Host; every cookie mutation requires canonical Origin plus CSRF. Native signup creates a blank tenant or atomically accepts an email-bound invitation. No legacy demo actor is claimed or client-supplied admin/owner role honored.

Live account/membership/plan checks protect business mutations and direct domain calls; role/suspension/password/security changes revoke affected sessions. Team invitations reserve seats and cannot grant ownership. General route buckets remain process-local; authentication throttles and daily tenant quotas are persistent. Daily limits count chat HTTP attempts, including retries, not provider tokens or payments. Trial expiration permits authorized reads/export, not financial writes. The manual subscription route requires an explicit deployment-admin credential and audits entitlement updates; it does not process payment.

Public auth has a strict route whitelist, canonical Origin for POST and a streaming 16 KB body bound. GET never consumes a security link. Fragment tokens avoid HTTP request/referrer logs but remain available to same-origin JavaScript and browser history until the explicit action/return clears them; XSS and device security still matter. Email existence responses for reset are uniform, not certified constant-latency. Mail delivery is at-least-once with stable gateway idempotency keys; actual provider delivery/bounce/security configuration remains external acceptance work.

Scopes:
- `actor`: authenticated user and tenant; sensitive routes additionally require a backend capability, and financial executors recheck the live DB role.
- `business`: the authenticated user's tenant (does not permit arbitrary business IDs).
- `open`: authenticated identity but no extra role check; currently bootstrap.
- `auth`: only the whitelisted public config/register/login/MFA/reset/verify routes, never a general guard bypass.
- `admin`: explicitly configured **deployment administrator** (`admin: true`), not any shop owner by virtue of a client-supplied role.

The provider registry remains **deployment-global**, managed only by deployment admins (list/create/update/delete/probe). Bootstrap exposes safe model choices, never keys. Health diagnostics, the API inventory, host diagnostics, business provisioning and the global scheduler tick are admin-only. Deployment admins are trusted operators; global health/tick can inspect/operate aggregate deployment state. Per-tenant BYO secrets/provider quotas are **not implemented**; do not sell them as isolated tenant resources.

A production request with missing/invalid credentials receives 401; a valid identity trying another actor or an admin-only endpoint receives 403. Some other handlers validate request shape before invoking the guard; malformed requests can return 400 without authentication, but must not expose tenant data.

## 2. CSRF and rate limiting

State-changing requests with an Origin must match the proxy host or `WAKIL_ALLOWED_ORIGINS`. Non-browser clients without Origin are accepted only after credential validation. Configure the reverse proxy to overwrite forwarded host/IP headers; do not trust arbitrary inbound forwarding headers. Rate limits are in-memory, per IP/route class: they are not distributed abuse protection. Exact scheme/port origin handling and proxy trust deserve a deployment-specific review.

## 3. Provider and webhook network boundary

`provider-network.ts` uses an explicit Undici dispatcher, not a check followed by an unguarded second DNS resolution:
- HTTPS only; embedded credentials/fragments are refused. Provider base URLs also reject query strings.
- Literal IPs and **all** DNS answers must be public unicast. IPv4-mapped IPv6 is normalized; loopback/private/link-local/metadata/reserved/translation ranges are refused.
- The socket lookup returns the validated addresses directly. Each new connection is checked; redirects are always errors, so Authorization is never forwarded to another target.
- Creation, saved-provider probes and both LLM completion/streaming paths use this transport, including legacy stored URLs.
- Webhooks use the same HTTPS/public/DNS/redirect boundary. `ALLOW_LOCAL_WEBHOOKS=1` only permits the legacy local transport in **non-production**. There is no local-provider bypass, including for the old mock service.
- Network tests exercise URL/IP policy, injected DNS answers and production local-webhook denial. A real provider/connectivity or hostile-DNS end-to-end test is still needed in staging.

Webhook responses are treated as untrusted data, not code. The current GET/POST webhook feature does **not** prove that the remote endpoint is read-only: HTTP method and downstream side effects require a reviewed connector contract. Tool administration/config reads are management-only. Response-size/resource limits, downstream execution permissions and broader data-disclosure policy still need further review.

## 4. Secrets at rest

Provider keys are AES-256-GCM envelopes (`wakil:v1:`) with a fresh 12-byte IV. `WAKIL_SECRETS_KEY` is exactly 32 bytes encoded as 64 hex characters and lives **outside** SQLite and its backups. Production refuses plaintext provider keys and absent/invalid encryption configuration; DTOs omit API keys. Losing the external key loses access to encrypted credentials; possession of it plus a backup can decrypt them.

Legacy plaintext migration / rotation is an **offline maintenance operation**:

1. Stop all writers, take a consistent full DB snapshot, and preserve the old external key separately.
2. Set explicit `DATABASE_URL`. For existing encrypted rows supply the old `WAKIL_SECRETS_KEY`. For legacy plaintext run the maintenance command in development mode on the offline DB, never open the production web server in that mode.
3. Set `WAKIL_NEW_SECRETS_KEY` to a newly generated 64-hex key. Run `bun run secrets:rotate` (dry run), then `bun run secrets:rotate --apply`.
4. The script updates all rows transactionally and detects concurrent changes. It does not print credentials or key material.
5. Configure the new `WAKIL_SECRETS_KEY` in the deployment, restart and probe providers. Revoke the provider's own API key if compromised; rotating the encryption key alone does not revoke upstream access.

No claim of comprehensive log redaction or external SDK secret protection is made. Error/trace collection and third-party gateway configuration need a separate secrets/log review.

## 5. Financial and connector boundaries

### Implemented backend capabilities

`src/lib/security/permissions.ts` is the backend policy, not the model prompt. The guard can require a capability; agent/domain mutation helpers independently check their current DB actor. Unknown roles receive no management capabilities.

| Action | owner | supervisor | cashier / reception |
|---|---|---|---|
| Full JSON export (including financial/audit data) | Yes | No | No |
| Catalog CSV import / restore preview and merge | Yes | Yes | No |
| Tool config reads / tool and plugin administration | Yes | Yes | No |
| Explicit memory save/edit/forget and implicit rule learning | Yes | Yes | No |
| Background dispatch / scheduling | Yes | Yes | No |
| Business configuration / shared persona | Yes | Yes | No |
| Personal scratchpad notes | Own conversation only | Own conversation only | Own conversation only |
| Edit/delete another user's shared quick command | Yes | Yes | No; usage touch remains allowed |

Draft/approval permission is **operation-type AND risk** dependent (`risk.ts`). **The owner is the only approver by default for every formal state change**, even when a cashier/supervisor created the draft. Cashiers and reception can never approve. A supervisor may be explicitly delegated R1/R2 approval only by setting `WAKIL_ALLOW_DELEGATED_APPROVALS=1`; R3 remains owner-only. `WAKIL_STRICT_APPROVALS=1` overrides delegation and forces owner-only approval. R3 also requires a nonempty decision/payload reason. This is not four-eyes segregation: the owner can approve their own draft. An author can cancel their own still-pending permitted draft separately. No cancellation can overwrite an execution already claimed. R85 stores a separate request-payload hash so an idempotent retry can be checked against the original input even when validation materializes defaults into the approved payload; rows predating that binding fail closed when equivalence cannot be proven.

The decision middleware no longer fabricates an owner role, and reading a starter plugin no longer installs it under the first/owner user's identity. Background authorization is checked on dispatch, individual enqueue and worker start. Catalog helper callers must supply an explicit authorized user. Management helper checks are additional boundaries, not a complete policy engine for every internal system write.

This remains a **bounded RBAC increment**, not a complete field-level authorization policy. Native SaaS account/team/plan boundaries are implemented, but have not received independent production security certification. Ordinary business reports/catalog reads still share the tenant's operational data; field-level read grants, full endpoint/tool coverage review and role-aware browser UX remain release work. Personal preferences and ad-hoc business rules currently share the conservative management write capability; any more permissive product policy needs explicit design/tests.

### Atomic financial execution

- Draft creation checks current membership/type permission, tenant-bound references, optional conversation ownership and idempotency ownership. A reused key may return only the same actor/tenant/type's stored draft. Ref allocation, draft and audit commit together; globally unique numeric `WKL-…` refs no longer collide when different businesses start at zero.
- Numeric/quantity/party validation runs before drafting **and again inside execution**. Money is integer piastres; invalid/negative payment values, overpayment, nonpositive/fractional base quantities, duplicate basket item IDs and unassigned credit fail closed. Caller-supplied risk may raise but cannot lower computed risk, including collection/payment amounts and opening balances.
- Basket prices/default paid/total values are materialized into the new draft and persisted on successful execution. A later catalog price change does not silently reprice the reviewed basket; reversals use the persisted effective payload.
- Approval claim, business effects, independent stock/cash/debt/expiry read-back, terminal status, reversal links and audit commit in **one interactive SQLite transaction**. EXECUTING is not a durable intermediate state in this path. A savepoint rolls effects back before recording FAILED_SAFE; inability to roll back or record failure aborts the whole transaction, including the claim. Cancellation is a pending-only CAS plus audit in its own transaction.
- Simultaneous approvals, approval/cancellation, different sales competing for stock and two reversals of one original have regression coverage. Purchase reversal refuses to create negative stock. Fault-injection triggers prove rollback on cash/audit write failures, missing stock/cash/debt movements and reversal verification failure.
- Unexpected DB error text is not returned as the financial failure reason. A committed success is re-read before recording failure. If DB access itself is unavailable, the executor does not blindly relabel the outcome safe.

**Recovery boundary:** five actual SIGKILL/reopen checkpoints now prove precommit rollback and postcommit exactly-one effect/audit on synthetic local storage. A separate injected lost commit acknowledgement recovers the terminal result prepared by that transaction. Double storage/audit failure tests preserve pending state; historical EXECUTING is left unchanged and requires operator reconciliation, never blind reset/reapproval. This does not certify power-loss/full-disk behavior or the production volume.

Production HTTP smoke covers 38 financial/security requests and 49 native SaaS requests, plus real Chromium over local TLS: signup/verify/invite, cookie/CSRF, tenant/role denial, Arabic expense approval, workspace switching, MFA/recovery/reset/revocation, desktop navigation and 390px RTL. A real browser cancels SSE after start and retries the same turn after persistence without a second draft/effect. Transport cancellation no longer throws enqueue/close errors; bounded work may finish on a live server. **Chat is not a durable job across process loss**, and concurrent/incomplete turns need separate acceptance; quota still counts every HTTP attempt. No live-model/mail delivery, production-volume stress or complete authorization coverage is claimed. Test Chromium uses no-sandbox because of the sandbox environment; browser web security remains enabled.

After full DB restore, `recovery:quarantine` defaults to dry-run. Offline --apply disables ALL native accounts, revokes sessions/links, scrubs queued mail/pending MFA and heartbeat, preserving active MFA and finance. This prevents resurrected native sessions becoming live automatically; it does not reconcile post-backup password/MFA/role/revocation changes, external pilot/admin credentials or financial deltas. No automatic reactivation. See OPERATIONS before any traffic. Snapshots contain plaintext PII even when secret fields remain encrypted: 0600/private directory, encrypted off-host storage, versioned keys separately.

CLI-Anything discovery is **not a connector**. Bridge creation/execution returns `ok: false`, `status: not_connected`, with no external numbers, no generated capabilities and no new fake plugin registration. Legacy `app_cli_` plugins are refused before pipeline execution. Host scans are disabled in production. No Excel/POS invoice sync, inventory reconciliation, external writes or background synchronization is verified by these changes.

### Brain context and outcome boundaries

See [brain/harness evidence](BRAIN_HARNESS_2026-10-18_AR.md). Recent dialogue keeps user/assistant roles; stored evidence is bounded/escaped, not authority. Personal semantic indexes are scoped by tenant AND actor, and direct turns recheck conversation ownership. Canonical argument signatures retain the prior tool verdict on duplicate calls, including denial. Current permission hints are derived from backend policy, not model grants. Draft prose cannot claim a completed financial effect.

Common credential-like memory is refused, and implicit learning rejects quoted/hypothetical/question/negative statements conservatively; neither is comprehensive DLP nor deletion of the original chat log. The gateway preserves system roles across adapters. Per-completion and whole-stream deadlines bound waiting; a non-cancellable SDK may still finish its read-only network request. Once content starts, another model cannot be spliced into a partial answer. These are tested local contracts with model doubles, not a complete prompt-injection defense, live-provider quality evaluation or security certification.

## 6. Deployment and browser controls

Supported pilot assumption: **one long-lived process + persistent local SQLite volume**. No horizontally scaled/serverless durability claim. Enable the scheduler only after choosing and validating the deployment's job architecture. Test actual backup restore, retention, encryption, RPO/RTO and incident recovery on that deployment.

CSP/security headers and no-store API responses remain enabled; system fonts remove build-time Google requests. Inline scripts/styles remain allowed by the current CSP and are a limitation, not a strict nonce-based policy. Local Chromium proves desktop navigation, one 390px RTL viewport and SSE abort/replay with an Arabic financial journey. Keyboard/screen-reader/zoom, additional browsers/networks and production-proxy behavior still need independent release acceptance; reduced-motion emulation is not a comprehensive accessibility audit.

## 7. CI and disclosure

The active workflow is `.github/workflows/ci.yml`; `docs/ci/github-actions.yml` is an exact reference copy. Frozen installs use Bun 1.3.11. The gate covers types, app-owned lint, DB drift/storage, unit/integration tests, offline Arabic routing evals, synthetic backup restore, build, financial SIGKILL/reopen proof, production HTTP security/financial smoke, server-rendered screens, real Chromium and packaged restore/quarantine/snapshot/mail/rotation jobs. Vendored `cli-anything/**` is excluded from the app lint; this is **not an audit of the vendored project**.

Workflow existence does not mean GitHub has executed it or required it. A repository administrator must require `CI / launch-gate` in branch protection/rulesets and verify a green run on the release SHA.

Report vulnerabilities privately through GitHub Security Advisories; do not publish secrets or customer data in issues.
