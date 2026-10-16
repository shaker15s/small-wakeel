import { PrismaClient } from '@prisma/client'
const db = new PrismaClient({ datasourceUrl: 'file:/home/z/my-project/db/custom.db' })
const CONV = 'cmvav3q2700l3orbmy92vaetz'
const msgs = await db.message.findMany({ where: { conversationId: CONV }, orderBy: { createdAt: 'asc' }, select: { id: true, role: true, text: true, createdAt: true, card: true, actions: true, modelLabel: true } })
for (const m of msgs) console.log(m.createdAt.toISOString(), '|', m.role, '|', JSON.stringify(m.text.slice(0, 60)), '| card:', m.card ? 'Y' : '-', '| actions:', m.actions ? 'Y' : '-')
const mems = await db.agentMemory.findMany({ where: { businessId: 'cmvav3pzy00gjorbm70rupsbp' }, orderBy: { createdAt: 'asc' }, select: { id: true, createdAt: true, kind: true, text: true, userId: true } })
for (const m of mems) console.log('MEM@', m.createdAt.toISOString(), m.kind, JSON.stringify(m.text.slice(0, 60)))
const usage = await db.usageEvent.findMany({ orderBy: { createdAt: 'asc' } })
console.log('USAGE EVENTS:', usage.length)
for (const u of usage.slice(0, 40)) console.log('USE@', u.createdAt.toISOString(), u.businessId.slice(-6), u.userId.slice(-6), u.kind, JSON.stringify(u.label))
const ops = await db.operation.findMany({ where: { businessId: 'cmvav3pzy00gjorbm70rupsbp' }, orderBy: { createdAt: 'desc' }, take: 12, select: { ref: true, type: true, status: true, summary: true, createdAt: true } })
for (const o of ops) console.log('OP@', o.createdAt.toISOString(), o.ref, o.type, o.status, JSON.stringify(o.summary.slice(0, 60)))
await db.$disconnect()
