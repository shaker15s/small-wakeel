import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const msgs = await db.message.findMany({ where: { createdAt: { gte: new Date('2026-10-16T15:49:00Z') } }, orderBy: { createdAt: 'asc' }, include: { conversation: true } })
  console.log('messages since 15:49 (post-parallel-agent):', msgs.length)
  for (const m of msgs) console.log(' ', m.createdAt.toISOString(), m.role, m.conversationId.slice(-6), JSON.stringify(m.text.slice(0, 40)))
  const ops = await db.operation.findMany({ where: { businessId: 'cmvav3pzy00gjorbm70rupsbp', ref: { gte: 'WKL-5030' } }, orderBy: { createdAt: 'asc' } })
  console.log('my QA attar ops:', ops.map((o) => `${o.ref}:${o.type}:${o.status}`).join(' | '))
  const sops = await db.operation.findMany({ where: { businessId: 'cmvav3psg000iorbm9e9y9hb8', createdAt: { gte: new Date('2026-10-16T15:40:00Z') } }, orderBy: { createdAt: 'asc' } })
  console.log('my QA supermarket ops:', sops.map((o) => `${o.ref}:${o.type}:${o.status}`).join(' | '))
  const gops = await db.operation.findMany({ where: { businessId: 'cmvav3pv0006jorbme9kf58ul', createdAt: { gte: new Date('2026-10-16T15:40:00Z') } }, orderBy: { createdAt: 'asc' } })
  console.log('my QA gym ops:', gops.map((o) => `${o.ref}:${o.type}:${o.status}`).join(' | '))
}
main().finally(() => db.$disconnect())
