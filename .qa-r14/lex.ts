import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const coke = await db.item.findFirst({ where: { name: { contains: 'كوكاكولا' } } })
  console.log('item:', coke?.name, '| aliases:', JSON.stringify(coke?.aliases), '| unit:', coke?.unit, '| sell:', coke?.sellPrice)
}
main().finally(() => db.$disconnect())
