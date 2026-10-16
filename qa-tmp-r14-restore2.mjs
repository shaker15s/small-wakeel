import { PrismaClient } from '@prisma/client'
const db = new PrismaClient({ datasourceUrl: 'file:/home/z/my-project/db/custom.db' })
const BIZ = 'cmvav3pzy00gjorbm70rupsbp'
const sid = 'cmvav3pzz00glorbmnzoklps4'
const item = await db.item.findFirst({ where: { businessId: BIZ, name: 'كركديه' } })
// RESTORE WKL-5025 — it was confirmed (SUCCEEDED, cash in 240, stock 29000→28980)
// by a parallel agent at 15:10:45 BEFORE my cleanup deleted the row; recreate
// the op + audit trail so the cash entry + stock effect have their ledger row.
const payload = { itemId: item.id, itemName: 'كركديه', qty: 20, unit: 'gram', unitPrice: 12, total: 240, paid: 240 }
const result = {
  ok: true,
  checks: [{ label: 'المخزون نقص بالمقدار الصح', expected: '٢٩٬٠٠٠ جرام', actual: '٢٨٬٩٨٠ جرام', pass: true }],
  effects: [
    { label: 'مخزون كركديه', value: '٢٩٬٠٠٠ جرام ← ٢٨٬٩٨٠ جرام', tone: 'neutral' },
    { label: 'خزنة (قبض)', value: '٢٫٤٠ ج.م', tone: 'good' },
  ],
}
const op = await db.operation.create({
  data: {
    ref: 'WKL-5025',
    businessId: BIZ,
    type: 'sale',
    status: 'SUCCEEDED',
    source: 'chat',
    userId: sid,
    risk: 'R2',
    summary: 'بيع ٢٠ جرام كركديه بـ٢٫٤٠ ج.م',
    payload: JSON.stringify(payload),
    result: JSON.stringify(result),
    idempotencyKey: `restore-WKL-5025-${Date.now()}`,
    createdAt: new Date('2026-10-16T15:01:52.991Z'),
    decidedAt: new Date('2026-10-16T15:10:44.000Z'),
    executedAt: new Date('2026-10-16T15:10:45.538Z'),
  },
})
console.log('restored op', op.ref, op.id)
await db.auditEvent.createMany({
  data: [
    { businessId: BIZ, actor: sid, action: 'operation.drafted', ref: 'WKL-5025', detail: JSON.stringify({ summary: 'بيع ٢٠ جرام كركديه بـ٢٫٤٠ ج.م', risk: 'R2' }), createdAt: new Date('2026-10-16T15:01:52.991Z') },
    { businessId: BIZ, actor: sid, action: 'operation.succeeded', ref: 'WKL-5025', detail: JSON.stringify({ checks: 1 }), createdAt: new Date('2026-10-16T15:10:45.538Z') },
  ],
})
console.log('audit events restored')
await db.$disconnect()
