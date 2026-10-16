import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
async function main() {
  const ops = await p.operation.findMany({ where: { businessId: 'cmvav3pxd00b6orbmj7dvqgdr' }, orderBy: { createdAt: 'desc' }, take: 3, select: { ref: true, type: true, status: true, summary: true, createdAt: true } })
  for (const o of ops) console.log(o.ref, o.type, o.status, o.summary.slice(0, 60), o.createdAt.toISOString())
  await p.$disconnect()
}
main()
