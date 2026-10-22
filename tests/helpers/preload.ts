// وكيل — Bun test preload.
//
// Points `DATABASE_URL` at a THROWAWAY copy of `db/custom.db` BEFORE any test
// module is loaded, so the Prisma singleton in `src/lib/db` can never bind to
// the real demo database.
//
// WHY this exists (a real bug caught by watching the data): `src/lib/db` is a
// module singleton. One test file that imported it at *collection* time (i.e.
// before any `beforeAll` ran) froze the handle onto the real database, and the
// whole suite then wrote its drafts into the owner's demo data — the pending
// approvals count went 32 → 38 across a single `bun test` run, which is exactly
// the kind of quiet data corruption CI must never allow.
//
// Setting the environment variable per file was never enough: whichever module
// graph loads first wins. A preload is the only place that is guaranteed to run
// first.
import { ensureTestDatabaseReady } from './test-db'

// Top-level await is intentional: preload scripts complete before Bun loads
// test modules, so no singleton can open the file while the migration/WAL mode
// transition is still in flight.
await ensureTestDatabaseReady()
