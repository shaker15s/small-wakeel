import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const attar = await db.business.findFirst({ where: { name: 'عطارة المسك' } })
  if (!attar) return
  const [users, items, customers, suppliers, conversations] = await Promise.all([
    db.user.findMany({ where: { businessId: attar.id } }),
    db.item.findMany({ where: { businessId: attar.id } }),
    db.customer.findMany({ where: { businessId: attar.id } }),
    db.supplier.findMany({ where: { businessId: attar.id } }),
    db.conversation.findMany({ where: { businessId: attar.id } }),
  ])
  console.log('ATTAR', attar.id)
  console.log('users:', users.map((u) => `${u.name}:${u.id}:${u.role}`).join(' | '))
  console.log('items:\n' + items.map((i) => `${i.name} unit=${i.unit} sell=${i.sellPrice} stock=${i.stockQty}`).join('\n'))
  console.log('customers:', customers.map((c) => `${c.name} bal=${c.balance}`).join(' | '))
  console.log('conversations:', conversations.map((c) => `${c.id} "${c.title}" msgs=${c.messageCount}`).join(' | '))
  const gym = await db.business.findFirst({ where: { name: 'جيم أبطال' } })
  if (gym) {
    const gu = await db.user.findMany({ where: { businessId: gym.id } })
    console.log('GYM', gym.id, 'users:', gu.map((u) => `${u.name}:${u.id}:${u.role}`).join(' | '))
  }
  console.log('attar ops count:', await db.operation.count({ where: { businessId: attar.id } }))
  console.log('attar memories:', await db.agentMemory.count({ where: { businessId: attar.id } }))
  console.log('attar usageEvents:', await db.usageEvent.count({ where: { businessId: attar.id } }))
  const sup = await db.business.findFirst({ where: { name: 'سوبر ماركت النور' } })
  if (sup) {
    const su = await db.user.findMany({ where: { businessId: sup.id } })
    const chipsy = await db.item.findMany({ where: { businessId: sup.id, name: { contains: 'شيبسي' } } })
    const kamun = await db.item.findMany({ where: { businessId: sup.id, name: { contains: 'كمون' } } })
    console.log('SUP', sup.id, 'users:', su.map((u) => `${u.name}:${u.id}:${u.role}`).join(' | '))
    console.log('chipsy:', chipsy.map((i) => `${i.name}:${i.unit}:${i.sellPrice}`).join(' | '), '| kamun:', kamun.map((i) => `${i.name}:${i.unit}:${i.sellPrice}`).join(' | '))
  }
  const provs = await db.modelProvider.findMany({ include: { models: true } })
  for (const p of provs) console.log('PROVIDER', p.id, p.name, p.baseUrl, 'models:', p.models.map((m) => `${m.id}/${m.remoteId}/${m.enabled}`).join(','))
}
main().finally(() => db.$disconnect())
