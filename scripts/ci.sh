#!/usr/bin/env bash
# Same gate locally and in .github/workflows/ci.yml.
# --fast skips only production build and its boot/HTTP/screens smoke.
set -euo pipefail
cd "$(dirname "$0")/.."
FAST=0
[ "${1:-}" = "--fast" ] && FAST=1
export DATABASE_URL="${DATABASE_URL:-file:./db/custom.db}"
export NEXT_TELEMETRY_DISABLED=1
export WAKIL_OFFLINE=1
step() { printf '\n▶ %s\n' "$1"; }
step "Frozen install + engine-free Prisma client"
bun install --frozen-lockfile
step "Versioned migrations on disposable schema-check copy"
SOURCE_DATABASE_URL="$DATABASE_URL"
CI_DB_DIR=$(mktemp -d)
MOCK_PROVIDER_PID=''
cleanup() {
  if [ -n "$MOCK_PROVIDER_PID" ]; then
    kill "$MOCK_PROVIDER_PID" 2>/dev/null || true
    wait "$MOCK_PROVIDER_PID" 2>/dev/null || true
  fi
  rm -rf "$CI_DB_DIR"
}
trap cleanup EXIT
cp "${SOURCE_DATABASE_URL#file:}" "$CI_DB_DIR/gate.db"
export DATABASE_URL="file:$CI_DB_DIR/gate.db"
bun scripts/migrate.ts
step "Schema drift (read only, migrated copy)"
bun run db:sync --check
step "Date storage (read only)"
bun run db:normalize-dates --check
step "Synthetic SQLite backup/restore drill"
bun run backup:drill
step "Typecheck"
bun run typecheck
step "Lint (app-owned code, not vendored CLI-Anything)"
bun run lint
step "Start deterministic local mock provider for protocol and speech tests"
bun mini-services/mock-provider/index.ts >"$CI_DB_DIR/mock-provider.log" 2>&1 &
MOCK_PROVIDER_PID=$!
MOCK_READY=0
for _ in $(seq 1 40); do
  if curl -fsS --max-time 1 http://127.0.0.1:3031/health | grep -q '"ok":true'; then
    MOCK_READY=1
    break
  fi
  if ! kill -0 "$MOCK_PROVIDER_PID" 2>/dev/null; then break; fi
  sleep 0.25
done
if [ "$MOCK_READY" -ne 1 ]; then
  cat "$CI_DB_DIR/mock-provider.log"
  printf '\\n✘ mock-provider did not become healthy on 127.0.0.1:3031\\n' >&2
  exit 1
fi
step "Unit + integration tests (each file isolated; full golden battery runs once below)"
bun scripts/run-bun-tests-isolated.mjs --exclude=golden-battery.test.ts
step "Financial SIGKILL/reopen/commit-ack recovery (disposable DB)"
bun scripts/financial-crash-smoke.ts
step "Golden Arabic routing evals (offline; disposable DB)"
bun run evals
if [ "$FAST" -eq 0 ]; then
  step "Production build"
  bun run build
  step "Production boot + HTTP security + server-rendered screens (disposable DB)"
  bun run smoke:production
  step "Packaged maintenance jobs (disposable DB, no email delivery)"
  bun scripts/maintenance-smoke.ts
  printf '\n✔ Full local gate passed. Chromium E2E + financial crash proof included; production-volume restore, real delivery/connectors and release signoff remain external gates.\n'
else
  printf '\n✔ Fast gate passed; production build/boot/screens NOT RUN (--fast).\n'
fi
