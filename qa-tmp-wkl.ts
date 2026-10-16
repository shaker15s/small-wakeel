import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
async function main() {
  const ops = await p.operation.findMany({ where: { ref: { in: ['WKL-1013','WKL-5018','WKL-5011','WKL-5012'] } }, select: { ref: true, status: true, summary: true, businessId: true } })
  console.log(JSON.stringify(ops, null, 1))
  await p.$disconnect()
}
main()
