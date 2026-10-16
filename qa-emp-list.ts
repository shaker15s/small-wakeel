import { db } from './src/lib/db'
async function main() {
  const ops = await db.operation.findMany({ where: { businessId: 'cmvav3psg000iorbm9e9y9hb8', status: 'AWAITING_APPROVAL' }, orderBy: { createdAt: 'desc' }, select: { id: true, ref: true, type: true, risk: true, summary: true } })
  console.log(JSON.stringify(ops, null, 1))
}
main().catch(e => console.error(e)).finally(() => db.$disconnect())
