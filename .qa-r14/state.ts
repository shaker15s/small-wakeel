import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const attar = await db.business.findFirst({ where: { name: 'عطارة المسك' } })
  if (!attar) return
  const items = await db.item.findMany({ where: { businessId: attar.id }, orderBy: { name: 'asc' } })
  for (const i of items) console.log('ITEM', i.name, i.unit, i.sellPrice, i.stockQty, i.lowStockThreshold)
  const cash = await db.cashEntry.findMany({ where: { businessId: attar.id }, orderBy: { createdAt: 'asc' } })
  const tin = cash.filter((c) => c.direction === 'in').reduce((s, c) => s + c.amount, 0)
  const tout = cash.filter((c) => c.direction === 'out').reduce((s, c) => s + c.amount, 0)
  console.log('CASH in=', tin, 'out=', tout, 'entries=', cash.length)
  for (const c of cash.slice(-12)) console.log('  CASH', c.direction, c.amount, c.createdAt.toISOString(), c.ref ?? '')
  const aud = await db.auditEvent.count({ where: { businessId: attar.id } })
  console.log('audit events:', aud)
  const tasks = await db.scheduledTask.findMany({ where: { businessId: attar.id } })
  console.log('tasks:', tasks.map((t) => `${t.title}:${t.status}`).join(' | '))
}
main().finally(() => db.$disconnect())
