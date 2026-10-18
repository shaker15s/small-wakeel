// وكيل — Next.js instrumentation hook: runs ONCE per server process, before
// the first request is served.
//
// Today it:
//   1. DEV-ONLY auto-migrates the local database (idempotent ledger) so a
//      fresh clone serves with `bun install && bun dev` — no manual
//      `db:migrate` step (R40-1). Production keeps explicit migrations
//      (`bun run db:migrate` in the deploy runbook); WAKIL_AUTO_MIGRATE=0
//      opts out of the dev behaviour.
//   2. Starts the in-process scheduler (due reminders / recurring reports),
//      which is what turns «هفكرك يوم الجمعة» from a stored row into a
//      delivered message.
//
// Both are deliberately dynamic-imported and guarded so that:
//   • the Edge runtime never pulls in Prisma/bun:sqlite,
//   • a failure to start can never prevent the app from serving,
//   • dev-server HMR does not spawn duplicate timers (the scheduler keeps its
//     state on globalThis).
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  // 1) Dev auto-migrate: local `file:` databases only, dev only, opt-out
  //    available. Must finish before the Prisma client serves any query, so
  //    it runs here (process start) — synchronously, and fast when up to date
  //    (a ledger lookup per migration, sub-millisecond).
  if (process.env.NODE_ENV !== 'production' && process.env.WAKIL_AUTO_MIGRATE !== '0') {
    try {
      const { databaseUrl } = await import('@/lib/db')
      const url = databaseUrl()
      if (url.startsWith('file:')) {
        const filePart = url.slice('file:'.length)
        if (filePart && filePart !== ':memory:' && !/^https?:|^libsql:/i.test(url)) {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { applyMigrations } = await import('@/lib/db-migrations')
          const { isAbsolute, join } = await import('node:path')
          const p = isAbsolute(filePart) ? filePart : join(process.cwd(), filePart)
          const { existsSync } = await import('node:fs')
          if (existsSync(p)) {
            const res = await applyMigrations(p)
            if (res.applied.length > 0) {
              console.log(`[db] dev auto-migrate: ${res.applied.length} migration(s) applied (${res.applied.join(', ')})`)
            }
          }
        }
      }
    } catch (err) {
      // Fail soft: a broken migration must not take the dev server down, but
      // it must SCREAM — the app would otherwise serve a drifted schema.
      console.error('[db] dev auto-migrate FAILED — run `bun run db:migrate` manually:', err)
    }
  }

  // 2) Scheduler (unchanged)
  try {
    const { startScheduler } = await import('@/lib/scheduler')
    startScheduler()
  } catch (err) {
    console.error('[instrumentation] scheduler did not start:', err)
  }
}
