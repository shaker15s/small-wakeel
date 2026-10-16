import { PrismaClient } from '@prisma/client'
const db = new PrismaClient({ datasourceUrl: "file:/home/z/my-project/db/custom.db" })
const BIZ = 'cmvav3pzy00gjorbm70rupsbp'
const USER = 'cmvav3pzz00glorbmnzoklps4'
const convs = await db.conversation.findMany({ where: { businessId: BIZ, userId: USER }, orderBy: { updatedAt: 'desc' }, include: { _count: { select: { messages: true } } } })
for (const c of convs) console.log('CONV:', c.id, '|', c.title, '| msgs:', c._count.messages, '| messageCount:', c.messageCount)
const mems = await db.agentMemory.findMany({ where: { businessId: BIZ, userId: USER }, orderBy: { createdAt: 'desc' } })
for (const m of mems) console.log('MEM:', m.id, m.kind, m.category, m.active, JSON.stringify(m.text).slice(0, 90), 'usage:', m.usageCount)
const items = await db.item.findMany({ where: { businessId: BIZ }, select: { id: true, name: true, unit: true, sellPrice: true, stockQty: true, lowStockThreshold: true, aliases: true } })
for (const i of items) console.log('ITEM:', i.name, '| unit:', i.unit, '| sell:', i.sellPrice, '| stock:', i.stockQty, '| low:', i.lowStockThreshold, '| aliases:', i.aliases)
const customers = await db.customer.findMany({ where: { businessId: BIZ }, select: { id: true, name: true, balance: true } })
for (const c of customers) console.log('CUST:', c.id, c.name, c.balance)
await db.$disconnect()
