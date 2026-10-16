import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const ops = await db.operation.findMany({ where: { businessId: 'cmvav3pv0006jorbme9kf58ul' }, orderBy: { createdAt: 'asc' } })
  for (const o of ops) console.log(o.ref, o.type, o.status, o.createdAt.toISOString())
}
main().finally(() => db.$disconnect())
