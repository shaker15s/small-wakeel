import { PrismaClient } from '@prisma/client'
const db = new PrismaClient({ datasourceUrl: 'file:/home/z/my-project/db/custom.db' })
const BIZ = 'cmvav3pzy00gjorbm70rupsbp'
const ref = await db.operation.findFirst({ where: { businessId: BIZ, ref: 'WKL-5022' } })
console.log('WKL-5022 payload:', ref.payload)
console.log('WKL-5022 result:', ref.result)
console.log('WKL-5022 risk/status/exec:', ref.risk, ref.status, ref.executedAt?.toISOString(), ref.decidedAt?.toISOString())
const aud = await db.auditEvent.findMany({ where: { businessId: BIZ, ref: 'WKL-5022' }, orderBy: { createdAt: 'asc' } })
for (const a of aud) console.log('AUDIT:', a.createdAt.toISOString(), a.action, String(a.detail).slice(0, 130))
await db.$disconnect()
