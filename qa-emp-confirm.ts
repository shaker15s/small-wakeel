import { db } from './src/lib/db'
const opId = process.argv[2]
const userId = process.argv[3] ?? 'cmvav3psi000morbmn3gunex5'
async function main() {
  const res = await fetch(`http://localhost:3000/api/operations/${opId}/confirm`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'approve', userId }),
  })
  const j = await res.json() as { operation?: { ref?: string; status?: string }; outcome?: { ok?: boolean; checks?: unknown; effects?: unknown; failReason?: string }; error?: string }
  console.log(res.status, JSON.stringify({ ref: j.operation?.ref, status: j.operation?.status, ok: j.outcome?.ok, failReason: j.outcome?.failReason, checks: j.outcome?.checks, effects: j.outcome?.effects }, null, 1))
}
main().catch(e => console.error(e)).finally(() => db.$disconnect())
