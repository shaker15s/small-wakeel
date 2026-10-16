import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const b = 'cmvav3pzy00gjorbm70rupsbp'; const u = 'cmvav3pzz00glorbmnzoklps4'
  const ev = await db.usageEvent.findMany({ where: { businessId: b, userId: u }, orderBy: { createdAt: 'desc' }, take: 8 })
  for (const e of ev) console.log('USAGE', e.kind, `"${e.label}"`, e.createdAt.toISOString())
  const conv = await db.conversation.findUnique({ where: { id: 'cmvb502xc0073or3omzf5qje3' } })
  console.log('CONV', conv?.title, 'count=', conv?.messageCount, 'last=', conv?.lastMessageAt.toISOString())
}
main().finally(() => db.$disconnect())
