import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const conv = await db.conversation.findFirst({ where: { title: 'مسك الغزال والناقص في المحل' } })
  if (!conv) return
  const msgs = await db.message.findMany({ where: { conversationId: conv.id }, orderBy: { createdAt: 'asc' } })
  for (const m of msgs) console.log(m.createdAt.toISOString(), m.role, JSON.stringify(m.text.slice(0, 60)))
}
main().finally(() => db.$disconnect())
