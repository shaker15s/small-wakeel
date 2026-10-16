import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
async function main() {
  const msgs = await p.message.findMany({ where: { modelLabel: { contains: 'void' } }, select: { id: true, modelLabel: true, createdAt: true } })
  console.log(JSON.stringify(msgs, null, 1))
  await p.$disconnect()
}
main()
