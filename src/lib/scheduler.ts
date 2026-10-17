// وكيل — in-process scheduler.
//
// WHY: scheduled reminders and recurring reports only fired when someone hit
// POST /api/tasks/tick — so in practice they never fired. The agent promised
// «هفكرك يوم الجمعة» and then forgot. This module makes the promise real:
// a single interval (per server process) sweeps due tasks.
//
// Design notes
//   • Started from src/instrumentation.ts → runs once per Node process, in the
//     Node runtime only (never in the Edge runtime / browser bundle).
//   • Idempotent: the interval handle lives on globalThis, so dev HMR or a
//     double import cannot create two timers.
//   • Safe by construction: the runner claims each task with an atomic UPDATE,
//     so an external cron hitting /api/tasks/tick concurrently is harmless.
//   • Off switch: WAKIL_SCHEDULER=off (e.g. when an external cron owns ticks).
//   • Bounded: each sweep takes at most 10 tasks; errors never kill the timer.

import { requeueStuckTasks, runDueTasks } from './tasks/runner'
import { expireStaleDrafts } from './domain/hygiene'

const DEFAULT_INTERVAL_MS = 60_000

interface SchedulerState {
  timer: ReturnType<typeof setInterval> | null
  startedAt: number
  lastRunAt: number | null
  lastError: string | null
  runs: number
  tasksRun: number
}

const globalForScheduler = globalThis as unknown as { __wakilScheduler?: SchedulerState }

function state(): SchedulerState {
  globalForScheduler.__wakilScheduler ??= {
    timer: null,
    startedAt: Date.now(),
    lastRunAt: null,
    lastError: null,
    runs: 0,
    tasksRun: 0,
  }
  return globalForScheduler.__wakilScheduler
}

export function schedulerEnabled(): boolean {
  const flag = process.env.WAKIL_SCHEDULER?.trim().toLowerCase()
  if (flag === 'off' || flag === '0' || flag === 'false') return false
  const interval = Number(process.env.WAKIL_SCHEDULER_INTERVAL_MS)
  return !Number.isFinite(interval) || interval > 0
}

function intervalMs(): number {
  const raw = Number(process.env.WAKIL_SCHEDULER_INTERVAL_MS)
  return Number.isFinite(raw) && raw >= 5_000 ? raw : DEFAULT_INTERVAL_MS
}

async function sweep(): Promise<void> {
  const s = state()
  try {
    await requeueStuckTasks()
    // Retire drafts nobody approved (default: older than 72h). Cheap and
    // idempotent; a human decision already in flight wins the atomic update.
    const hygiene = await expireStaleDrafts()
    if (hygiene.expired > 0) console.log(`[scheduler] expired ${hygiene.expired} stale draft(s)`)
    const summary = await runDueTasks(10)
    s.runs += 1
    s.tasksRun += summary.ran
    s.lastRunAt = Date.now()
    s.lastError = null
    if (summary.ran > 0 || summary.failed > 0) {
      console.log(`[scheduler] ran=${summary.ran} failed=${summary.failed} ${summary.details.join(' ')}`)
    }
  } catch (err) {
    // Never let a database hiccup kill the timer.
    s.lastError = err instanceof Error ? err.message : String(err)
    s.lastRunAt = Date.now()
    console.warn('[scheduler] sweep failed:', s.lastError)
  }
}

/** Start the scheduler. Returns false when it was already running. */
export function startScheduler(): boolean {
  const s = state()
  if (s.timer) return false
  if (!schedulerEnabled()) {
    console.log('[scheduler] disabled (WAKIL_SCHEDULER=off)')
    return false
  }
  s.startedAt = Date.now()
  s.timer = setInterval(() => {
    void sweep()
  }, intervalMs())
  // Don't keep the event loop alive just for the sweep (matters for tests/CLI).
  s.timer.unref?.()
  console.log(`[scheduler] started — sweeping every ${Math.round(intervalMs() / 1000)}s`)
  // Fire once shortly after boot so a reminder that came due during a restart
  // is delivered without waiting a full interval.
  setTimeout(() => void sweep(), 3_000).unref?.()
  return true
}

export function stopScheduler(): void {
  const s = state()
  if (s.timer) clearInterval(s.timer)
  s.timer = null
}

/** Health/observability view of the scheduler. */
export function schedulerStatus(): {
  enabled: boolean
  running: boolean
  intervalMs: number
  startedAt: string | null
  lastRunAt: string | null
  lastError: string | null
  runs: number
  tasksRun: number
} {
  const s = state()
  return {
    enabled: schedulerEnabled(),
    running: s.timer !== null,
    intervalMs: intervalMs(),
    startedAt: s.timer ? new Date(s.startedAt).toISOString() : null,
    lastRunAt: s.lastRunAt ? new Date(s.lastRunAt).toISOString() : null,
    lastError: s.lastError,
    runs: s.runs,
    tasksRun: s.tasksRun,
  }
}

/** Test seam: run one sweep immediately. */
export async function runSchedulerOnce(): Promise<void> {
  await sweep()
}
