import { PrismaClient } from '@prisma/client'
const db = new PrismaClient({ datasourceUrl: 'file:/home/z/my-project/db/custom.db' })
const msgs = await db.message.findMany({ where: { conversationId: 'cmvb3zcbw0001orgx04rq5sir' }, orderBy: { createdAt: 'asc' } })
for (const m of msgs.slice(-4)) console.log('====', m.createdAt.toISOString(), m.role, JSON.stringify(m.text.slice(0, 300)))
await db.$disconnect()
