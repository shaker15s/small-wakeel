import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const cap = await db.providerCapability.findUnique({ where: { modelConfigId: 'cmvawdr88000korvohnarg1qj' } })
  console.log('CAPABILITY persisted:', JSON.stringify({ ok: cap?.ok, streaming: cap?.supportsStreaming, tools: cap?.supportsTools, ttft: cap?.ttftMs, tps: cap?.tps, note: cap?.note, probedAt: cap?.probedAt }))
  const p = await db.modelProvider.create({ data: { name: 'QA-DEAD', baseUrl: 'http://localhost:9999/v1', apiKey: 'x' } })
  const m = await db.modelConfig.create({ data: { providerId: p.id, remoteId: 'dead-model', label: 'QA dead', tier: 'air', enabled: false } })
  console.log('DEAD_MODEL', m.id)
}
main().finally(() => db.$disconnect())
