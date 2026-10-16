#!/usr/bin/env bash
# وكيل — the one command that must pass before anything ships.
#
# Runs the same gate as docs/ci/github-actions.yml, so a local run and CI can
# never disagree:
#   install → prisma client → schema drift → typecheck → lint → tests → evals → build
#
#   ./scripts/ci.sh            # full gate
#   ./scripts/ci.sh --fast     # everything except the production build
set -euo pipefail

cd "$(dirname "$0")/.."

FAST=0
[ "${1:-}" = "--fast" ] && FAST=1

export DATABASE_URL="${DATABASE_URL:-file:./db/custom.db}"
export NEXT_TELEMETRY_DISABLED=1
# Deterministic model ladder: no network, no flaky provider calls in the gate.
export WAKIL_OFFLINE="${WAKIL_OFFLINE:-1}"

step() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }

step "Prisma client"
bun run db:generate >/dev/null

step "Schema drift (db:sync --check)"
bun run db:sync --check

step "Typecheck"
bun run typecheck

step "Lint"
bun run lint

step "Unit + integration tests"
bun test

step "Golden Arabic evals"
bun run evals

if [ "$FAST" -eq 0 ]; then
  step "Production build"
  bun run build
fi

printf '\n\033[32m✔ كله تمام — كل البوابات عدّت\033[0m\n'
