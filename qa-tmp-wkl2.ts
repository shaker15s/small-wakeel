import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
async function main() {
  const op = await p.operation.findUnique({ where: { ref: 'WKL-1013' }, select: { id: true, conversationId: true, status: true } })
  console.log('op conversationId:', op?.conversationId)
  if (op?.conversationId) {
    const msgs = await p.message.findMany({ where: { conversationId: op.conversationId }, orderBy: { createdAt: 'asc' }, select: { role: true, text: true, card: true } })
    for (const m of msgs) {
      const card = m.card ? JSON.parse(m.card) : null
      console.log('-', m.role, (m.text||'').slice(0,50).replace(/\n/g,' '), '| card ref:', card?.ref ?? '')
    }
    const conv = await p.conversation.findUnique({ where: { id: op.conversationId }, select: { id: true, title: true, userId: true, updatedAt: true } })
    console.log('conv:', JSON.stringify(conv))
  }
  await p.$disconnect()
}
main()
