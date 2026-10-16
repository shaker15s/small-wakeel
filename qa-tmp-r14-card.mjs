import { PrismaClient } from '@prisma/client'
const db = new PrismaClient({ datasourceUrl: 'file:/home/z/my-project/db/custom.db' })
const msgs = await db.message.findMany({ where: { conversationId: 'cmvav3q2700l3orbmy92vaetz', createdAt: { gte: new Date('2026-10-16T15:00:00Z') } }, orderBy: { createdAt: 'asc' } })
for (const m of msgs) {
  console.log('====', m.createdAt.toISOString(), m.role)
  if (m.card) console.log('CARD:', m.card.slice(0, 1200))
}
await db.$disconnect()
