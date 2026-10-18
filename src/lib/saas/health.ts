// Operator-only aggregates: never recipient/subject/payload/session secrets.
import { db } from '@/lib/db'
import { mailReady } from './mail'
export async function operationalHealth() {
  const now = Date.now()
  const [mailGroups, oldest, worker, executing, accounts, disabled] = await Promise.all([
    db.mailOutbox.groupBy({ by: ['status'], _count: { _all: true } }),
    db.mailOutbox.findFirst({ where: { status: { in: ['pending', 'sending'] }, expiresAt: { gt: new Date(now) } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
    db.workerHeartbeat.findUnique({ where: { id: 'mail' }, select: { startedAt: true, finishedAt: true, ok: true } }),
    db.operation.count({ where: { status: 'EXECUTING' } }),
    db.account.count(), db.account.count({ where: { disabledAt: { not: null } } }),
  ])
  const mail = Object.fromEntries(mailGroups.map((g) => [g.status, g._count._all]))
  const oldestPendingAgeSec = oldest ? Math.max(0, Math.floor((now - oldest.createdAt.getTime()) / 1000)) : null
  const configured = mailReady()
  const expected = process.env.WAKIL_SAAS_ENABLED === '1' && configured
  const lastCompletionAgeSec = worker?.finishedAt ? Math.max(0, Math.floor((now - worker.finishedAt.getTime()) / 1000)) : null
  const alerts: string[] = []
  if (executing) alerts.push('financial_execution_requires_review')
  if ((oldestPendingAgeSec ?? 0) > 300) alerts.push('mail_queue_delayed')
  if (mail.failed) alerts.push('mail_terminal_failures')
  if (expected && (lastCompletionAgeSec === null || lastCompletionAgeSec > 300)) alerts.push('mail_worker_missing_or_stale')
  if (worker?.ok === false) alerts.push('mail_worker_failed')
  if (process.env.WAKIL_SIGNUP_ENABLED === '1' && !configured) alerts.push('signup_mail_not_configured')
  return { alerts, executingOperations: executing, accounts: { total: accounts, disabled }, mail: { counts: mail, oldestPendingAgeSec, configured, externalDelivery: 'not_probed' as const, worker: { ...worker, lastCompletionAgeSec } } }
}
