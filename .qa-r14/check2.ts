import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const msgs = await db.message.findMany({ where: { createdAt: { gte: new Date('2026-10-16T15:39:00Z') } }, orderBy: { createdAt: 'asc' }, include: { conversation: true } })
  for (const m of msgs) console.log(m.createdAt.toISOString(), m.role, JSON.stringify(m.text.slice(0, 50)), 'conv:', m.conversation.title, m.conversationId)
}
main().finally(() => db.$disconnect())
