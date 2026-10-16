import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const items = await db.item.findMany({ where: { businessId: 'cmvav3psg000iorbm9e9y9hb8' } })
  for (const i of items) console.log(i.name, '|', JSON.stringify(i.aliases), '| unit:', i.unit, '| sell:', i.sellPrice, '| stock:', i.stockQty)
}
main().finally(() => db.$disconnect())
