import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const attar = await db.business.findFirst({ where: { name: 'عطارة المسك' } })
  if (!attar) return
  const mems = await db.agentMemory.findMany({ where: { businessId: attar.id }, orderBy: { createdAt: 'asc' } })
  for (const m of mems) console.log('MEM', m.id, m.kind, m.category, `conf=${m.confidence}`, `active=${m.active}`, `use=${m.usageCount}`, `"${m.text.slice(0, 70)}"`)
  const sup = await db.business.findFirst({ where: { name: 'سوبر ماركت النور' } })
  if (sup) {
    const items = await db.item.findMany({ where: { businessId: sup.id } })
    console.log('SUP items:', items.map((i) => i.name).join(' | '))
    const sCustomers = await db.customer.findMany({ where: { businessId: sup.id } })
    console.log('SUP customers:', sCustomers.map((c) => `${c.name}:${c.balance}`).join(' | '))
  }
  const ops = await db.operation.findMany({ where: { businessId: attar.id }, orderBy: { createdAt: 'desc' }, take: 30 })
  for (const o of ops) console.log('OP', o.ref, o.type, o.status, o.createdAt.toISOString(), `"${o.summary.slice(0, 50)}"`)
  const convs = await db.conversation.findMany({ where: { businessId: attar.id } })
  for (const c of convs) {
    const cnt = await db.message.count({ where: { conversationId: c.id } })
    console.log('CONV', c.id, `"${c.title}"`, `count=${cnt}`, `stored=${c.messageCount}`, `created=${c.createdAt.toISOString()}`, `last=${c.lastMessageAt.toISOString()}`)
  }
}
main().finally(() => db.$disconnect())
