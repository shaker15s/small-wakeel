import { PrismaClient } from '@prisma/client'
const db = new PrismaClient({ datasourceUrl: 'file:/home/z/my-project/db/custom.db' })
const BIZ = 'cmvav3pzy00gjorbm70rupsbp'
const USER = 'cmvav3pzz00glorbmnzoklps4'
const usage = await db.usageEvent.findMany({ where: { businessId: BIZ, userId: USER }, orderBy: { createdAt: 'asc' } })
for (const u of usage) console.log('USE:', u.createdAt.toISOString(), u.kind, JSON.stringify(u.label))
await db.$disconnect()
