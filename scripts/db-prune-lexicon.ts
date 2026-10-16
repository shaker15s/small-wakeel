// scripts/db-prune-lexicon.ts — remove junk dialect-alias memories from the DB.
//
// Why: the lexicon is learned from real sentences, and the older learning rule
// accepted any token that merely OVERLAPPED an item name. The shipped demo DB
// ended up with rows like «شوكولاتة» = «كوكاكولا 1 لتر» and «أحمد» = «قهوة
// أحمد», i.e. a chocolate sentence drafted a cola and a customer's name matched
// a coffee. The runtime now verifies every alias before using it
// (pruneLexicon/aliasFitsEntity); this script removes the rows so the data is
// clean too — the owner never sees a wrong «I remember» line.
//
//   bun scripts/db-prune-lexicon.ts          # report
//   bun scripts/db-prune-lexicon.ts --apply  # delete
import { db } from '../src/lib/db'
import { staleLexiconRows } from '../src/lib/agent/memory'

const apply = process.argv.includes('--apply')
const businesses = await db.business.findMany({ select: { id: true, name: true } })
let totalJunk = 0

for (const b of businesses) {
  const [rows, items, customers, suppliers] = await Promise.all([
    db.agentMemory.findMany({
      where: { businessId: b.id, kind: 'lexicon' },
      select: { id: true, text: true, entityRef: true },
    }),
    db.item.findMany({ where: { businessId: b.id }, select: { id: true, name: true, aliases: true } }),
    db.customer.findMany({ where: { businessId: b.id }, select: { name: true } }),
    db.supplier.findMany({ where: { businessId: b.id }, select: { name: true } }),
  ])
  const junk = staleLexiconRows(rows, items, [...customers.map((c) => c.name), ...suppliers.map((s) => s.name)])
  if (junk.length === 0) {
    console.log(`✅ ${b.name}: ${rows.length} alias — كله سليم`)
    continue
  }
  totalJunk += junk.length
  for (const row of rows.filter((r) => junk.includes(r.id))) console.log(`🗑️  ${b.name}: ${row.text}`)
  if (apply) {
    await db.agentMemory.updateMany({ where: { id: { in: junk } }, data: { active: false } })
  }
}

console.log(
  apply
    ? `اتشال ${totalJunk} صف غلط من الذاكرة (اتقفلوا مش اتمسحوا — ممكن ترجعهم لو محتاج).`
    : `${totalJunk} صف غلط محتاج يتشال — شغّل بـ --apply.`,
)
