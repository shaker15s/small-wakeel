// One-shot job. Schedule every minute against the SAME durable DB as the web.
import { randomUUID } from 'node:crypto'
import { db } from '../src/lib/db'
import { deliverMailBatch } from '../src/lib/saas/mail'
const runId = randomUUID()
try {
  await db.workerHeartbeat.upsert({ where: { id: 'mail' }, create: { id: 'mail', runId, startedAt: new Date() }, update: { runId, startedAt: new Date(), finishedAt: null, ok: null } })
  try {
    const result = await deliverMailBatch()
    await db.workerHeartbeat.updateMany({ where: { id: 'mail', runId }, data: { finishedAt: new Date(), ok: true } })
    console.log(JSON.stringify(result))
  } catch (e) {
    await db.workerHeartbeat.updateMany({ where: { id: 'mail', runId }, data: { finishedAt: new Date(), ok: false } })
    throw e
  }
} finally { await db.$disconnect() }
