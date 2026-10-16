import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const ev = await db.usageEvent.findMany({ where: { businessId: 'cmvav3pv0006jorbme9kf58ul' }, orderBy: { createdAt: 'desc' }, take: 4 })
  for (const e of ev) console.log('GYM USAGE', e.kind, `"${e.label}"`, e.createdAt.toISOString())
}
main().finally(() => db.$disconnect())
