import { PrismaClient } from '@prisma/client'
const db = new PrismaClient({ datasourceUrl: 'file:/home/z/my-project/db/custom.db' })
const caps = await db.providerCapability.findMany({ orderBy: { probedAt: 'desc' } })
for (const c of caps) console.log('CAP:', c.modelConfigId, c.ok, c.supportsStreaming, c.supportsTools, c.ttftMs, c.tps, c.probedAt.toISOString(), JSON.stringify(c.note))
await db.$disconnect()
