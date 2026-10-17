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

step "Date storage (db:normalize-dates --check)"
# Mixed INTEGER/TEXT DateTime storage silently zeroes date filters — the stats
# screens read all-zero for a month that was fully recorded. Fail loudly here.
bun run db:normalize-dates -- --check

step "Typecheck"
bun run typecheck

step "Lint"
bun run lint

step "Unit + integration tests"
bun test

step "Golden Arabic evals"
bun run evals

step "Screens (real · first-day · network-failure)"
# «شاشة بايضة» and «الشبكة وقعت» are both failure modes an owner sees before
# any test does. The audit server-renders all 8 screens three ways: live data,
# empty ledger, and every query in `error` state (must show the retry card).
# It needs a running server; skip cleanly when there is none, never silently
# pretend it passed.
if [ "${WAKIL_SCREENS:-auto}" = "0" ]; then
  echo "⤼ اتخطّت (WAKIL_SCREENS=0)"
elif curl -sf -o /dev/null --max-time 3 "${WAKIL_URL:-http://localhost:3000}/api/bootstrap"; then
  bun run screens --all-businesses
else
  echo "⤼ مفيش سيرفر على ${WAKIL_URL:-http://localhost:3000} — شغّل «bun run dev» الأول، أو WAKIL_SCREENS=0 للتخطي"
fi

if [ "$FAST" -eq 0 ]; then
  step "Production build"
  bun run build
fi

printf '\n\033[32m✔ كله تمام — كل البوابات عدّت\033[0m\n'
