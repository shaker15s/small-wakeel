import { PrismaClient } from '@prisma/client'
const db = new PrismaClient({ datasourceUrl: 'file:/home/z/my-project/db/custom.db' })
const conv = await db.conversation.create({ data: { businessId: 'cmvav3pzy00gjorbm70rupsbp', userId: 'cmvav3pzz00glorbmnzoklps4', title: 'محادثة جديدة' } })
console.log('QA CONV:', conv.id)
await db.$disconnect()
