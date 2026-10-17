// وكيل — Next.js instrumentation hook: runs ONCE per server process, before
// the first request is served.
//
// Today it starts the in-process scheduler (due reminders / recurring reports),
// which is what turns «هفكرك يوم الجمعة» from a stored row into a delivered
// message. It is deliberately dynamic-imported and guarded so that:
//   • the Edge runtime never pulls in Prisma,
//   • a failure to start can never prevent the app from serving,
//   • dev-server HMR does not spawn duplicate timers (the scheduler keeps its
//     state on globalThis).

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  try {
    const { startScheduler } = await import('@/lib/scheduler')
    startScheduler()
  } catch (err) {
    console.error('[instrumentation] scheduler did not start:', err)
  }
}
