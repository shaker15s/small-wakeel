# وكيل — Operations runbook

## 1. Health & observability

```bash
curl -s localhost:3000/api/health            | jq        # status, db, scheduler, models, security
curl -s "localhost:3000/api/usage?businessId=$BIZ&days=7" | jq  # latency/fallback ledger
curl -s localhost:3000/api | jq .endpoints    # self-documenting API index
tail -f dev.log                               # dev server log
```

`/api/health` returns

```jsonc
{
  "status": "healthy | degraded | unhealthy",
  "version": "2.0.0",
  "uptimeSec": 1234,
  "db": { "ok": true, "latencyMs": 2, "counts": { "items": 70, "operations": 95, "pendingOps": 25 } },
  "scheduler": { "enabled": true, "running": false, "intervalMs": 60000, "runs": 42, "lastRunAt": "…", "lastError": null },
  "models": [ { "id": "builtin-deep", "tier": "deep", "source": "builtin" } ],
  "security": { "accessTokenRequired": false, "allowedOrigins": [], "localWebhooksAllowed": false }
}
```

* `200 healthy` — DB reachable, fewer than 25 drafts waiting for approval.
* `200 degraded` — DB fine but a backlog of >25 unapproved drafts (the owner should open the app).
* `503 unhealthy` — the DB is unreachable; nothing else is meaningful until that is fixed.

**Watch these `/api/usage` numbers:** `fallbackRate` (a rising rate means a provider is flaking — check `scheduler.lastError` and the model ladder logs), `latencyP95` per `kind`, and `ttftP50` for chat.

## 2. Routine operations

| Task | Command |
|---|---|
| Start dev | `bun run dev` (:3000, hot reload, logs to `dev.log`) |
| Production build | `bun run build && bun run start` (standalone, honours `PORT`) |
| Full quality gate | `bun run check && bun run evals && bun run db:sync --check` |
| Schema drift check | `bun run db:sync --check` (exit 1 = drift, prints the exact statements) |
| Apply schema additions | `bun run db:sync` (additive only, one transaction) |
| Regenerate Prisma client | `bun run db:generate` (offline-safe) |
| Snapshot the database | `bun run db:snapshot` → `db/custom.db.backup.<timestamp>.db` |
| Reseed the demo data | `bun run db:seed` |
| Disable background sweeps | `WAKIL_SCHEDULER=off bun run dev` |
| Drive sweeps from cron instead | `curl -X POST localhost:3000/api/tasks/tick` |

## 3. Backups and restore

The SQLite file *is* the product state.

```bash
# 1. file-level snapshot (fast, exact)
bun run db:snapshot

# 2. logical export (portable, human-readable)
curl -s "http://localhost:3000/api/export?businessId=$BIZ" > backup.json

# 3. restore a catalog from a backup — ALWAYS preview first
jq '{businessId, userId, mode:"preview"} + .' backup.json \
  | curl -s -X POST localhost:3000/api/restore -H 'content-type: application/json' -d @- | jq
# then mode:"merge" for real
```

`/api/restore` deliberately restores **only** the catalog (items, customers, suppliers). Operations, cash entries and audit events are never rewritten from a file: a tampered backup must not be able to restate history the owner already saw.

## 4. Incident playbook

**«الموديل مش راد» / the agent answers from rules only**
1. `curl -s localhost:3000/api/health | jq .models` — is there any enabled BYO model?
2. Check the model ladder in the logs: `grep '\[llm\]' dev.log` — each failed attempt is logged with its label and error.
3. `POST /api/providers/probe {modelConfigId}` — verifies streaming, measures TTFT/TPS, and stores the capability row (the ladder prefers probed-OK models).
4. If the built-in gateway is unreachable but a BYO provider works, the ladder already covers the turn; the reply label names the model that actually answered.
5. Worst case: `WAKIL_OFFLINE=1` is the documented deterministic mode — the shop keeps working with the rule ladder.

**A draft will not approve**
`POST /api/operations/:id/confirm` returns `409` when the operation is not `AWAITING_APPROVAL` (already executed, rejected, or cancelled). Check the current status in the response body — it is never a silent no-op.

**Stock and the shelf disagree**
Every operation stores read-back `checks[]`. Open the operation in سجل العمليات, compare `stockBefore/stockAfter`, and use «تسوية مخزون» (`stock_adjustment`, R2, needs approval + reason) to correct the count. Never edit the database by hand.

**Scheduled reminders did not fire**
1. `GET /api/health` → `scheduler.enabled` must be true and `lastError` null.
2. `POST /api/tasks/tick` once — it reports `ran/due/failed/requeued`.
3. Rows stuck in `running` longer than 10 minutes are automatically requeued with an Arabic `failReason`.

**Database locked / corrupt**
SQLite + libsql retries locks automatically. If a query keeps failing: stop the server, `bun run db:snapshot`, then `sqlite3 db/custom.db 'PRAGMA integrity_check;'`. Restore the latest snapshot if it fails. Run `bun run db:sync` afterwards to re-apply any missing schema additions.

## 5. Performance notes

* 28+ composite indexes cover the hot paths; if you add a list endpoint, add its index to `prisma/schema.prisma` and run `bun run db:sync`.
* `/api/usage` keeps only the last 5 000 events in memory per request and aggregates them in one pass.
* Chat latency is dominated by the model provider; `ttftP50` in `/api/usage` is the honest number to quote.
* The UI loads no remote fonts or scripts, so first paint does not depend on any third party.

## 6. Hosting checklist

- [ ] `WAKIL_ACCESS_TOKEN` set to a long random value; `?token=` sharing links understood.
- [ ] `WAKIL_ALLOWED_ORIGINS` set to the real dashboard origin(s), if any.
- [ ] `WAKIL_EMBED_ORIGINS` set only if the app is embedded elsewhere.
- [ ] HTTPS terminated in front (Caddy/nginx/Vercel) — HSTS is sent only in production.
- [ ] `bun run db:snapshot` on a schedule (cron) and copy the file off the machine.
- [ ] `/api/health` wired to the uptime monitor; alert on `status != healthy`.
- [ ] Model providers probed after any credential change; `fallbackRate` reviewed weekly.
