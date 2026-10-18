// Offline maintenance: snapshot SQLite + preserve old external key; stop ALL
// writers/mail workers. Rotates providers, MFA secrets and pending encrypted mail.
import { decryptProviderKey, encryptProviderKey } from '../src/lib/security/provider-secrets'
if (!process.env.DATABASE_URL) throw new Error('Set an explicit DATABASE_URL for maintenance')
const nextKey = process.env.WAKIL_NEW_SECRETS_KEY
if (!nextKey || !/^[a-fA-F0-9]{64}$/.test(nextKey)) throw new Error('WAKIL_NEW_SECRETS_KEY must be 32 bytes of hex')
const { db } = await import('../src/lib/db')
try {
  const providers = await db.modelProvider.findMany({ select: { id: true, apiKey: true } })
  const accounts = await db.account.findMany({ select: { id: true, mfaSecret: true, pendingMfaSecret: true } })
  const mail = await db.mailOutbox.findMany({ where: { payload: { not: '' } }, select: { id: true, payload: true } })
  const decodedProviders = providers.map((row) => ({ ...row, plain: decryptProviderKey(row.apiKey) }))
  const decodedAccounts = accounts.map((row) => ({ ...row, plain: row.mfaSecret ? decryptProviderKey(row.mfaSecret) : null, pending: row.pendingMfaSecret ? decryptProviderKey(row.pendingMfaSecret) : null }))
  const decodedMail = mail.map((row) => ({ ...row, plain: decryptProviderKey(row.payload) }))
  process.env.WAKIL_SECRETS_KEY = nextKey
  if (process.argv.includes('--apply')) {
    await db.$transaction(async (tx) => {
      for (const row of decodedProviders) {
        if ((await tx.modelProvider.updateMany({ where: { id: row.id, apiKey: row.apiKey }, data: { apiKey: encryptProviderKey(row.plain) } })).count !== 1) throw new Error('Provider changed during rotation')
      }
      for (const row of decodedAccounts) {
        if ((await tx.account.updateMany({ where: { id: row.id, mfaSecret: row.mfaSecret, pendingMfaSecret: row.pendingMfaSecret }, data: { mfaSecret: row.plain ? encryptProviderKey(row.plain) : null, pendingMfaSecret: row.pending ? encryptProviderKey(row.pending) : null } })).count !== 1) throw new Error('Account changed during rotation')
      }
      for (const row of decodedMail) {
        if ((await tx.mailOutbox.updateMany({ where: { id: row.id, payload: row.payload }, data: { payload: encryptProviderKey(row.plain) } })).count !== 1) throw new Error('Mail changed during rotation')
      }
    }, { timeout: 60_000 })
    console.log('Rotated provider/MFA/mail envelopes. Configure the new key before restarting.')
  } else {
    console.log(`Validated ${providers.length} provider rows, ${accounts.length} account rows and ${mail.length} mail envelopes. Dry run only; use --apply with writers stopped.`)
  }
} finally { await db.$disconnect() }
