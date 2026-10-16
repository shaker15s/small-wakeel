import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const c = await db.conversation.findUnique({ where: { id: process.argv[2] ?? '' } })
  console.log('TITLE:', JSON.stringify(c?.title), 'count:', c?.messageCount)
  const seed = await db.conversation.findFirst({ where: { businessId: 'cmvav3pv0006jorbme9kf58ul' } , orderBy: { updatedAt: 'asc' }})
  console.log('gym latest convs:')
  const all = await db.conversation.findMany({ where: { businessId: 'cmvav3pv0006jorbme9kf58ul' }, orderBy: { updatedAt: 'desc' } })
  for (const x of all) console.log(' -', x.id, '«'+x.title+'»', 'count='+x.messageCount, 'last='+x.lastMessageAt.toISOString())
}
main().finally(() => db.$disconnect())
