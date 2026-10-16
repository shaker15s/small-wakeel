import { PrismaClient } from '@prisma/client'
const db = new PrismaClient({ datasourceUrl: 'file:/home/z/my-project/db/custom.db' })
const CONV = 'cmvav3q2700l3orbmy92vaetz'
const BIZ = 'cmvav3pzy00gjorbm70rupsbp'
const USER = 'cmvav3pzz00glorbmnzoklps4'
// 1) delete the interrupted prior R14-brain run's test messages (>= 15:00)
const delMsgs = await db.message.deleteMany({ where: { conversationId: CONV, createdAt: { gte: new Date('2026-10-16T15:00:00Z') } } })
console.log('deleted messages:', delMsgs.count)
// 2) delete its test memories (4: rule + pref + 2 lexicon)
const memIds = ['cmvb3ixuh0017or3oode5zkwl','cmvb3iix7000vor3ov9jkx5dr','cmvb3h6uo000jor3one6zfges','cmvb3h0r8000bor3o0l3og8wd']
const delMems = await db.agentMemory.deleteMany({ where: { id: { in: memIds } } })
console.log('deleted memories:', delMems.count)
// 3) delete its test drafts WKL-5024/5025 (+ their audit events + cash none)
for (const ref of ['WKL-5024','WKL-5025']) {
  const op = await db.operation.findFirst({ where: { businessId: BIZ, ref } })
  if (op) {
    await db.auditEvent.deleteMany({ where: { businessId: BIZ, ref } })
    await db.message.updateMany({ where: { conversationId: CONV, card: { contains: op.id } }, data: { card: null } })
    await db.operation.delete({ where: { id: op.id } })
    console.log('deleted op', ref)
  }
}
// 4) delete its usage events (attar عم سيد >= 15:00)
const delUse = await db.usageEvent.deleteMany({ where: { businessId: BIZ, userId: USER, createdAt: { gte: new Date('2026-10-16T15:00:00Z') } } })
console.log('deleted usage events:', delUse.count)
// 5) reset conversation counters to reality
const remaining = await db.message.count({ where: { conversationId: CONV } })
const last = await db.message.findFirst({ where: { conversationId: CONV }, orderBy: { createdAt: 'desc' } })
await db.conversation.update({ where: { id: CONV }, data: { messageCount: remaining, lastMessageAt: last?.createdAt ?? new Date() } })
console.log('conversation messageCount now:', remaining, 'lastMessageAt:', last?.createdAt?.toISOString())
await db.$disconnect()
