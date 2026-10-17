// وكيل — API smoke: hit EVERY read endpoint the screens depend on, for every
// seeded business, and fail loudly.
//
// «شاشات بايضة» almost always means one of these answered 500 (or nothing), and
// the browser only shows an empty panel. This script walks the surface the way
// the views do (overview → items → customers → suppliers → journal → tasks →
// memories → tools → notes → usage → health → search) and prints the status +
// payload shape of each, per business. A single non-200 fails the run.

import { db } from '../src/lib/db'

const args = process.argv.slice(2)
const urlArg = args.indexOf('--url')
const BASE = urlArg >= 0 ? args[urlArg + 1] : process.env.WAKIL_URL ?? 'http://localhost:3000'

interface Probe {
  name: string
  path: (ctx: Ctx) => string
  /** optional shape check on the parsed JSON */
  check?: (json: unknown) => string | null
}

interface Ctx {
  businessId: string
  userId: string
}

const listCheck = (key: string) => (json: unknown) => {
  const obj = json as Record<string, unknown>
  if (!obj || typeof obj !== 'object') return 'مش JSON'
  const value = obj[key]
  if (value === undefined) return `مفيش «${key}» في الرد`
  if (!Array.isArray(value) && typeof value !== 'object') return `«${key}» نوعه غلط`
  return null
}

const PROBES: Probe[] = [
  { name: 'bootstrap', path: () => `/api/bootstrap`, check: listCheck('businesses') },
  { name: 'overview', path: (c) => `/api/overview?businessId=${c.businessId}&userId=${c.userId}` },
  { name: 'items', path: (c) => `/api/items?businessId=${c.businessId}` },
  { name: 'operations', path: (c) => `/api/operations?businessId=${c.businessId}` },
  { name: 'operations:pending', path: (c) => `/api/operations?businessId=${c.businessId}&status=AWAITING_APPROVAL` },
  { name: 'members', path: (c) => `/api/members?businessId=${c.businessId}` },
  { name: 'reports:7d', path: (c) => `/api/reports?businessId=${c.businessId}&range=7d` },
  { name: 'reports:30d', path: (c) => `/api/reports?businessId=${c.businessId}&range=30d` },
  { name: 'tasks', path: (c) => `/api/tasks?businessId=${c.businessId}`, check: listCheck('tasks') },
  { name: 'memories', path: (c) => `/api/memories?businessId=${c.businessId}&userId=${c.userId}` },
  { name: 'conversations', path: (c) => `/api/conversations?businessId=${c.businessId}&userId=${c.userId}` },
  { name: 'chat-history', path: (c) => `/api/chat?businessId=${c.businessId}&userId=${c.userId}` },
  { name: 'radar', path: (c) => `/api/radar?businessId=${c.businessId}&userId=${c.userId}` },
  { name: 'tools', path: (c) => `/api/tools?businessId=${c.businessId}&userId=${c.userId}` },
  { name: 'suggestions', path: (c) => `/api/suggestions?businessId=${c.businessId}&userId=${c.userId}` },
  { name: 'quick-commands', path: (c) => `/api/quick-commands?businessId=${c.businessId}` },
  { name: 'usage', path: (c) => `/api/usage?businessId=${c.businessId}&days=7` },
  { name: 'search', path: (c) => `/api/search?businessId=${c.businessId}&q=${encodeURIComponent('لبن')}&limit=5` },
  { name: 'export', path: (c) => `/api/export?businessId=${c.businessId}` },
  { name: 'providers', path: () => `/api/providers` },
  { name: 'health', path: () => `/api/health` },
  { name: 'api-index', path: () => `/api` },
]

const businesses = await db.business.findMany({ include: { users: true } })
let failures = 0
let checked = 0

console.log(`\n🔎 وكيل — فحص واجهات الشاشات (${BASE})\n${'─'.repeat(76)}`)

for (const b of businesses) {
  const ctx: Ctx = { businessId: b.id, userId: b.users[0].id }
  const rows: string[] = []
  for (const p of PROBES) {
    checked++
    const path = p.path(ctx)
    let status = 0
    let note = ''
    const started = Date.now()
    try {
      const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } })
      status = res.status
      const text = await res.text()
      if (status !== 200) {
        note = text.slice(0, 120).replace(/\s+/g, ' ')
        failures++
      } else if (p.check) {
        try {
          const json = JSON.parse(text)
          const problem = p.check(json)
          if (problem) {
            note = problem
            failures++
          }
        } catch {
          note = 'رد مش JSON'
          failures++
        }
      }
    } catch (err) {
      status = -1
      note = `شبكة: ${(err as Error).message}`
      failures++
    }
    const ms = Date.now() - started
    rows.push(`${status === 200 && !note ? '✅' : '❌'} ${p.name.padEnd(14)} ${String(status).padStart(3)} ${String(ms).padStart(4)}ms ${note}`)
  }
  console.log(`\n▸ ${b.type} — ${b.name}`)
  for (const r of rows) console.log(`  ${r}`)
}

console.log(`\n${'─'.repeat(76)}`)
console.log(`اتفحص ${checked} نداء · فشل ${failures}`)
if (failures > 0) process.exitCode = 1
await db.$disconnect()
