// OFFLINE containment after a full DB restore. Stop all writers first. A restore
// can resurrect old sessions/links and revoked accounts/roles. Do NOT serve it
// until account + financial reconciliation against post-backup evidence is done.
import { isAbsolute } from 'node:path'
const url = process.env.DATABASE_URL
if (!url?.startsWith('file:') || !isAbsolute(url.slice(5))) throw new Error('Set an explicit absolute local SQLite DATABASE_URL; stop ALL writers first')
const { db } = await import('../src/lib/db')
try {
  const integrity = await db.$queryRawUnsafe<{ integrity_check: string }[]>('PRAGMA integrity_check')
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('Restore integrity check failed; keep traffic stopped')
  if ((await db.$queryRawUnsafe<unknown[]>('PRAGMA foreign_key_check')).length) throw new Error('Restore foreign-key check failed; keep traffic stopped')
  const now = new Date()
  const result = await db.$transaction(async (tx) => {
    const pending = {
      accounts: await tx.account.count({ where: { disabledAt: null } }),
      sessions: await tx.session.count({ where: { revokedAt: null } }),
      links: await tx.accountToken.count({ where: { usedAt: null } }),
      mail: await tx.mailOutbox.count({ where: { payload: { not: '' } } }),
    }
    if (process.argv.includes('--apply')) {
      await tx.account.updateMany({ where: { disabledAt: null }, data: { disabledAt: now } })
      await tx.session.updateMany({ where: { revokedAt: null }, data: { revokedAt: now } })
      await tx.accountToken.updateMany({ where: { usedAt: null }, data: { usedAt: now } })
      await tx.mailOutbox.updateMany({ where: { payload: { not: '' } }, data: { status: 'expired', payload: '', lockedAt: null } })
      await tx.account.updateMany({ data: { pendingMfaSecret: null, pendingMfaAt: null } })
      await tx.workerHeartbeat.deleteMany()
    }
    return pending
  })
  console.log(JSON.stringify({ applied: process.argv.includes('--apply'), ...result, warning: 'ALL native accounts quarantined on apply. Reconcile identities, roles, password/MFA changes, pilot credentials, entitlements and financial deltas before controlled recovery. No automatic reactivation.' }))
} finally { await db.$disconnect() }
