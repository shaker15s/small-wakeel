import { PrismaClient } from '@prisma/client'
const db = new PrismaClient({ datasourceUrl: 'file:/home/z/my-project/db/custom.db' })
const r = await db.agentMemory.deleteMany({ where: { businessId: 'cmvav3pzy00gjorbm70rupsbp', text: { contains: 'اعمل ايه لو العميل متأخر' } } })
console.log('deleted bad rule memories:', r.count)
await db.$disconnect()
