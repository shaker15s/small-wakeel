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
trap 'rm -rf "$CI_DB_DIR"' EXIT
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
step "Unit + integration tests (disposable DB)"
bun test
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
