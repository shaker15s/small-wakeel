#!/usr/bin/env bash
# وكيل — Prisma client generation that works on locked-down networks.
#
# The Prisma CLI eagerly resolves (and downloads) its Rust engines from
# binaries.prisma.sh before doing anything — even for `generate`, and even with
# `--no-engine`. This project runs Prisma WITHOUT the Rust engine
# (`engineType = "client"` + the libsql driver adapter), so the engine files are
# never needed at runtime. When they are missing we point the CLI at harmless
# stubs so generation proceeds offline; when real engines are present (a normal
# developer machine / CI with CDN access) nothing changes.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! ls node_modules/@prisma/engines/schema-engine-* >/dev/null 2>&1; then
  echo "• Prisma engines not found — generating with engine-free client (offline mode)"
  export PRISMA_SCHEMA_ENGINE_BINARY="${PRISMA_SCHEMA_ENGINE_BINARY:-/usr/bin/true}"
  export PRISMA_QUERY_ENGINE_LIBRARY="${PRISMA_QUERY_ENGINE_LIBRARY:-/usr/bin/true}"
fi

exec npx prisma generate "$@"
