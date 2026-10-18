// R40-1: the engine moved to `src/lib/db-migrations.ts` (single source of
// truth — shared with the dev-server auto-migrate in instrumentation).
// This file stays as the scripts/ entry point for explicit production runs.
export { applyMigrations, findMigrationsDir } from '../../src/lib/db-migrations'
