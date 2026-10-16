import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
async function main() {
  const msgs = await p.message.findMany({ orderBy: { createdAt: 'desc' }, take: 6, select: { role: true, text: true, createdAt: true, modelLabel: true } })
  for (const m of msgs) console.log(m.createdAt.toISOString(), m.role, (m.text || '').slice(0, 30).replace(/\n/g, ' '), m.modelLabel || '')
  await p.$disconnect()
}
main()
