# وكيل — Runtime contract (R68)

## Canonical runtime: Bun
Everything in `package.json` (dev, build, `bun test`, db scripts) targets **bun**.
CI (`.github/workflows/ci.yml`) installs the latest stable bun and runs:
`bun install` → `bun run typecheck` → `bun test` (full suite, including the
golden battery). `bunfig.toml` wires `tests/helpers/preload.ts` so every test
process starts on a **throwaway copy** of `db/custom.db` — tests must never
write into the demo database (this is a real bug class that once moved the
owner's pending-approvals count mid-run).

## Fallback runtime: plain Node ≥ 22.18
Locked-down sandboxes sometimes cannot install the bun binary (network
allowlists). The repo therefore carries a **fallback runner — not a second
suite**: the same test files, same assertions, same preload, executed by node's
native TS type-stripping plus `tests/node/`:

| File | Role |
| --- | --- |
| `tests/node/register.mjs` | `--import` entry: bun-global polyfill + resolve/load hooks |
| `tests/node/hooks.mjs` | `@/` alias, extensionless + bare-subpath resolution, `bun:test` → shim, `mock.module` registry lookup, `.tsx` transform (esbuild, `--no-save`) |
| `tests/node/bun-test-shim.ts` | bun:test surface: matchers (incl. `.not`, `.rejects`, asymmetric), describe hook inheritance, timeouts, `mock.module` (per-PID registry so a child's mocks never leak across processes) |
| `tests/node/bun-polyfill.mjs` | `Bun.sleep` / `Bun.spawn` (remaps `bun file.ts` → `node --import … file.ts`), Web-ReadableStream stdout/stderr, `exited` promise |
| `tests/node/run-suite.mjs` | per-file runner with the preload — `npm run test:node` |

Rules that keep the fallback honest:
1. **No test may depend on bun-only globals without the shim covering them**
   (add to the shim + a regression file here, not around it).
2. **No test may import `src/lib/db` before the preload runs** — the preload
   is the only guarantee that the Prisma singleton binds to the temp copy.
3. The golden battery spawns its runner with the right runtime automatically
   (`process.versions.bun` check in `tests/integration/golden-battery.test.ts`).
4. If a feature requires bun-only semantics, document it in this file and keep
   the fallback red-loud, never silently green on a partial suite.

## Mini-services
`mini-services/mock-provider` serves on `Bun.serve` when bun is present and
bridges to `node:http` (same WHATWG dispatch, SSE streamed chunk by chunk)
otherwise; `start.sh` picks the available runtime.
