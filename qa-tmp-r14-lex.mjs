import { PrismaClient } from '@prisma/client'
const db = new PrismaClient({ datasourceUrl: 'file:/home/z/my-project/db/custom.db' })
const BIZ = 'cmvav3pzy00gjorbm70rupsbp'
const USER = 'cmvav3pzz00glorbmnzoklps4'
const mems = await db.agentMemory.findMany({ where: { businessId: BIZ, userId: USER }, orderBy: { createdAt: 'desc' }, take: 5 })
for (const m of mems) console.log('MEM:', m.createdAt.toISOString(), m.id.slice(-6), m.kind, m.category, 'active:', m.active, 'usage:', m.usageCount, JSON.stringify(m.text.slice(0, 70)))
await db.$disconnect()
