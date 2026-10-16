import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
async function main() {
  const conv = await p.conversation.findFirst({ where: { businessId: 'cmvav3pzy00gjorbm70rupsbp', userId: 'cmvav3pzz00glorbmnzoklps4' }, orderBy: { updatedAt: 'desc' } })
  console.log('conv:', conv?.id, conv?.updatedAt)
  const msgs = await p.message.findMany({ where: { conversationId: conv!.id }, orderBy: { createdAt: 'desc' }, take: 8, select: { role: true, text: true, createdAt: true, modelLabel: true } })
  for (const m of msgs) console.log(m.createdAt.toISOString(), m.role, (m.text || '').slice(0, 40).replace(/\n/g, ' '), m.modelLabel || '')
  await p.$disconnect()
}
main()
