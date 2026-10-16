import { db } from './src/lib/db'
const opId = process.argv[2]
async function main() {
  const res = await fetch(`http://localhost:3000/api/operations/${opId}/confirm`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'reject', userId: 'cmvav3psi000morbmn3gunex5', reason: 'QA' }),
  })
  const j = await res.json() as { operation?: { ref?: string; status?: string }; error?: string }
  console.log(res.status, j.operation?.ref, j.operation?.status, j.error ?? '')
}
main().catch(e => console.error(e)).finally(() => db.$disconnect())
