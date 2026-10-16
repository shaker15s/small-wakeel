import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
async function main() {
  // find messages whose card JSON contains WKL-1013
  const msgs = await p.message.findMany({ where: { card: { contains: 'WKL-1013' } }, select: { id: true, conversationId: true, role: true, text: true } })
  console.log('messages with WKL-1013 card:', msgs.length)
  for (const m of msgs) console.log(m.conversationId, m.role, (m.text||'').slice(0,60))
  const convs = await p.conversation.findMany({ where: { businessId: 'cmvav3psg000iorbm9e9y9hb8' }, select: { id: true, title: true, userId: true, updatedAt: true } })
  for (const c of convs) console.log('conv:', c.id, c.title, c.userId, c.updatedAt.toISOString())
  await p.$disconnect()
}
main()
