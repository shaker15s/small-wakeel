import { PrismaClient } from '@prisma/client'
const db = new PrismaClient({ datasourceUrl: 'file:/home/z/my-project/db/custom.db' })
const ops = await db.operation.findMany({ where: { businessId: 'cmvav3pzy00gjorbm70rupsbp', createdAt: { gte: new Date('2026-10-16T15:10:00Z') } }, orderBy: { createdAt: 'asc' } })
for (const o of ops) console.log(o.createdAt.toISOString(), o.ref, o.type, o.status, o.summary.slice(0, 70))
const item = await db.item.findFirst({ where: { businessId: 'cmvav3pzy00gjorbm70rupsbp', name: 'كركديه' } })
console.log('كركديه stock now:', item.stockQty)
const cash = await db.cashEntry.findMany({ where: { businessId: 'cmvav3pzy00gjorbm70rupsbp', createdAt: { gte: new Date('2026-10-16T15:10:00Z') } } })
for (const c of cash) console.log('CASH:', c.createdAt.toISOString(), c.direction, c.amount, c.reason, c.ref)
await db.$disconnect()
