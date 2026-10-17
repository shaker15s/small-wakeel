// scripts/screens-audit.tsx — «شاشة بايضة» كبوابة قابلة للتشغيل.
//
// The owner's complaint was literal: «شاشات بايضة». So this script stops asking
// the API «هل بيرد؟» and starts rendering the ACTUAL screen components on the
// server, with the ACTUAL payloads, for each of the four businesses:
//
//   • real data      → the screen must show the shop's own numbers/names
//   • empty ledger   → a brand-new shop must SEE what to do next, not a blank
//   • network down   → every query in `error` state: the screen must say so and
//                      offer «جرّب تاني», never impersonate a quiet empty day
//
// Rendering React on the server is the same code path the browser runs for the
// first paint (hooks, derived state, conditional sections), so a crash, a
// missing field, or a section that silently disappears is caught here — in CI —
// without a browser.
//
//   bun run screens                    # all four businesses
//   bun run screens --only inventory   # one screen
//   bun run screens --url http://host:port
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement as h, type ReactElement } from 'react'

import { QUERY_KEYS } from '../src/lib/store'
import { egp } from '../src/lib/format'
import TodayView from '../src/components/views/TodayView'
import InventoryView from '../src/components/views/InventoryView'
import JournalView from '../src/components/views/JournalView'
import AccountsView from '../src/components/views/AccountsView'
import StatsView from '../src/components/views/StatsView'
import ReportsView from '../src/components/views/ReportsView'
import MemoryView from '../src/components/views/MemoryView'
import SettingsView from '../src/components/views/SettingsView'

const args = process.argv.slice(2)
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const BASE = opt('--url') ?? process.env.WAKIL_URL ?? 'http://localhost:3000'
const ONLY = opt('--only')

interface Biz {
  id: string
  name: string
  type: string
  userId: string
}

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`)
  return (await res.json()) as T
}

/** Everything the eight screens can read, fetched once per business. */
async function payloadFor(biz: Biz) {
  const [overview, items, operations, memories, reports7, reports30, tasks, providers, radar, suggestions, tools, bootstrap, brief] = await Promise.all([
    api(`/api/overview?businessId=${biz.id}&userId=${biz.userId}`),
    api(`/api/items?businessId=${biz.id}`),
    api(`/api/operations?businessId=${biz.id}`),
    api(`/api/memories?businessId=${biz.id}`),
    api(`/api/reports?businessId=${biz.id}&range=7d`),
    api(`/api/reports?businessId=${biz.id}&range=30d`),
    api(`/api/tasks?businessId=${biz.id}`),
    api('/api/providers'),
    api(`/api/radar?businessId=${biz.id}&userId=${biz.userId}`),
    api(`/api/suggestions?businessId=${biz.id}&userId=${biz.userId}`),
    api(`/api/tools?businessId=${biz.id}&userId=${biz.userId}`),
    api('/api/bootstrap'),
    api(`/api/morning-brief?businessId=${biz.id}&userId=${biz.userId}`),
  ])
  return { overview, items, operations, memories, reports7, reports30, tasks, providers, radar, suggestions, tools, bootstrap, brief }
}

type Payload = Awaited<ReturnType<typeof payloadFor>>

const ZERO_OVERVIEW = {
  cash: { opening: 0, in: 0, out: 0, net: 0 },
  today: { sales: 0, purchases: 0, expenses: 0, collections: 0, payments: 0, opsCount: 0, doneCount: 0 },
  pendingOps: [],
  lowStock: [],
  expiring: [],
  receivables: [],
  payables: [],
  recentOps: [],
}
const ZERO_REPORT = {
  range: '7d',
  daily: [],
  totals: { sales: 0, purchases: 0, expenses: 0, collections: 0, profit: 0 },
  topItems: [],
  byType: [],
}

function clientFor(biz: Biz, p: Payload | null): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } })
  const put = (key: readonly unknown[], value: unknown) => qc.setQueryData(key as never, value as never)
  if (p) {
    put(QUERY_KEYS.overview(biz.id, biz.userId), p.overview)
    put(QUERY_KEYS.items(biz.id), p.items)
    put(QUERY_KEYS.operations(biz.id), p.operations)
    put(QUERY_KEYS.memories(biz.id), p.memories)
    put(QUERY_KEYS.reports(biz.id, '7d'), p.reports7)
    put(QUERY_KEYS.reports(biz.id, '30d'), p.reports30)
    put(QUERY_KEYS.tasks(biz.id), p.tasks)
    put(QUERY_KEYS.providers, p.providers)
    put(QUERY_KEYS.radar(biz.id), p.radar)
    put(QUERY_KEYS.suggestions(biz.id, biz.userId), p.suggestions)
    put(QUERY_KEYS.tools(biz.id, biz.userId), p.tools)
    put(QUERY_KEYS.morningBrief(biz.id, biz.userId), p.brief)
    put(['bootstrap'], p.bootstrap)
  } else {
    put(QUERY_KEYS.overview(biz.id, biz.userId), ZERO_OVERVIEW)
    put(QUERY_KEYS.items(biz.id), [])
    put(QUERY_KEYS.operations(biz.id), [])
    put(QUERY_KEYS.memories(biz.id), [])
    put(QUERY_KEYS.reports(biz.id, '7d'), ZERO_REPORT)
    put(QUERY_KEYS.reports(biz.id, '30d'), ZERO_REPORT)
    put(QUERY_KEYS.tasks(biz.id), { tasks: [] })
    put(QUERY_KEYS.providers, { providers: [] })
    put(QUERY_KEYS.radar(biz.id), [])
    put(QUERY_KEYS.suggestions(biz.id, biz.userId), [])
    put(QUERY_KEYS.tools(biz.id, biz.userId), [])
    put(QUERY_KEYS.morningBrief(biz.id, biz.userId), { headline: 'كل حاجة تحت السيطرة — مفيش حاجة مستعجلة النهاردة', items: [] })
    put(['bootstrap'], { businesses: [{ id: biz.id, name: biz.name, type: biz.type, users: [{ id: biz.userId, name: 'صاحب الشغل', role: 'owner' }] }] })
  }
  return qc
}

/** Every query the screens read is in `error` state (a dead API). */
function errorClient(biz: Biz): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } })
  const keys = [
    QUERY_KEYS.overview(biz.id, biz.userId),
    QUERY_KEYS.items(biz.id),
    QUERY_KEYS.operations(biz.id),
    QUERY_KEYS.memories(biz.id),
    QUERY_KEYS.reports(biz.id, '7d'),
    QUERY_KEYS.reports(biz.id, '30d'),
    QUERY_KEYS.tasks(biz.id),
    QUERY_KEYS.providers,
    QUERY_KEYS.radar(biz.id),
    QUERY_KEYS.suggestions(biz.id, biz.userId),
    QUERY_KEYS.tools(biz.id, biz.userId),
    ['bootstrap'] as const,
  ]
  for (const key of keys) {
    // retryOnMount:false keeps the state error instead of silently refetching
    // during render; without it the statically rendered screen shows skeletons
    // and the audit would pass a screen the owner sees as «فاضية».
    qc.setQueryDefaults(key as never, { enabled: false, retryOnMount: false, staleTime: Infinity })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q = qc.getQueryCache().build(qc, { queryKey: key as any })
    q.setState({ status: 'error', error: new Error('تعذر الاتصال بالسيرفر'), fetchStatus: 'idle' })
  }
  return qc
}

interface Screen {
  key: string
  /** a real-data screen must contain this — evidence it rendered the ledger */
  signal: RegExp
  /** an empty screen must contain this — evidence it guides the first day */
  emptySignal: RegExp
  render: (biz: Biz) => ReactElement
}

const SCREENS: Screen[] = [
  {
    key: 'today',
    signal: /رصيد الخزنة|مبيعات النهاردة|آخر الحركات|النهاردة|ابدأ يومك/,
    emptySignal: /ابدأ|ضيف|سجّل|لسه|مفيش/,
    render: (b) => h(TodayView, { businessId: b.id, userId: b.userId }),
  },
  {
    key: 'inventory',
    signal: /ج\.م/,
    emptySignal: /ضيف|مفيش|لسه|ابدأ|أول/,
    render: (b) => h(InventoryView, { businessId: b.id, userId: b.userId }),
  },
  {
    key: 'journal',
    signal: /WKL-|سجل|العمليات/,
    emptySignal: /مفيش|لسه|أول|ابدأ/,
    render: (b) => h(JournalView, { businessId: b.id, userId: b.userId }),
  },
  {
    key: 'accounts',
    signal: /عليه|مديون|العملاء|الحسابات/,
    emptySignal: /مفيش|لسه|ضيف|ابدأ/,
    render: (b) => h(AccountsView, { businessId: b.id, userId: b.userId }),
  },
  {
    key: 'stats',
    signal: /ج\.م|مبيعات|إيراد/,
    emptySignal: /مفيش|لسه|أول|ابدأ|سجّل/,
    render: (b) => h(StatsView, { businessId: b.id, userId: b.userId }),
  },
  {
    key: 'reports',
    signal: /ج\.م|تقرير|مبيعات/,
    emptySignal: /مفيش|لسه|أول|ابدأ|سجّل/,
    render: (b) => h(ReportsView, { businessId: b.id, userId: b.userId, businessName: b.name }),
  },
  {
    key: 'memory',
    signal: /ذاكرتي|فاكرها|اتعلمته|أدوات/,
    emptySignal: /مفيش|لسه|علّمني|احفظ|أضف|ضيف/,
    render: (b) => h(MemoryView, { businessId: b.id, userId: b.userId }),
  },
  {
    key: 'settings',
    signal: /المزوّد|الموديل|الإعدادات/,
    emptySignal: /المزوّد|الموديل|الإعدادات|ضيف/,
    render: (b) => h(SettingsView, { businessId: b.id, userId: b.userId }),
  },
]

interface Result {
  name: string
  problems: string[]
}

function renderScreen(screen: Screen, biz: Biz, qc: QueryClient): string {
  return renderToStaticMarkup(h(QueryClientProvider, { client: qc }, screen.render(biz)))
}

/** Readable text out of the markup (tags stripped, entities collapsed). */
const textOf = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()

async function main() {
  const boot = await api<{ businesses: { id: string; name: string; type: string; users: { id: string; name: string; role: string }[] }[] }>(
    '/api/bootstrap',
  )
  const businesses: Biz[] = boot.businesses.map((b) => {
    const owner = b.users.find((u) => u.role === 'owner') ?? b.users[0]
    return { id: b.id, name: b.name, type: b.type, userId: owner.id }
  })
  if (businesses.length === 0) throw new Error('مفيش أنشطة في /api/bootstrap — الداتابيز فاضية؟')

  console.log(`\n🖥️  وكيل — كل شاشة بتترسم فعليًا (${BASE})\n${'─'.repeat(78)}`)
  const results: Result[] = []

  for (const biz of businesses) {
    console.log(`\n${biz.name} — ${biz.type}`)
    const payload = await payloadFor(biz)
    const itemNames = (payload.items as { name: string }[]).slice(0, 40).map((i) => i.name)

    for (const screen of SCREENS) {
      if (ONLY && ONLY !== screen.key) continue
      const problems: string[] = []

      // ---- 1) real ledger ------------------------------------------------
      try {
        const html = renderScreen(screen, biz, clientFor(biz, payload))
        const text = textOf(html)
        if (text.length < 250) problems.push(`الشاشة شبه فاضية (${text.length} حرف مقروء)`)
        if (!screen.signal.test(text)) problems.push(`مفيش أثر للبيانات الحقيقية (${screen.signal})`)
        // A screen can render, look right, and still show the WRONG number (or
        // zero) — «بايضة» in the owner's words. The KPI the API returned must be
        // the KPI on the screen, byte for byte after `egp()`.
        const expected: string | null =
          screen.key === 'stats'
            ? egp((payload.reports7 as { totals: { sales: number } }).totals.sales)
            : screen.key === 'reports'
              ? egp((payload.reports7 as { totals: { sales: number } }).totals.sales)
              : screen.key === 'today'
                ? egp((payload.overview as { cash: { net: number } }).cash.net)
                : null
        if (expected && !text.includes(expected)) problems.push(`الرقم الظاهر مش رقم السجل (المتوقع ${expected})`)
        // «الشاشة تاخد عرض اللاب/الكمبيوتر/الموبايل بالكامل» — a screen that
        // caps itself at a phone-sized column leaves dead gutters on a 27".
        if (/max-w-5xl|max-w-4xl/.test(html)) {
          problems.push('الشاشة محصورة في عمود ضيق (max-w-5xl) — مش بتستخدم عرض الشاشة')
        }
        if (!/max-w-\[1800px\]/.test(html)) {
          problems.push('الشاشة مش داخلة حاوية PAGE المشتركة')
        }
        // the shop's own catalog must appear on the inventory screen
        if (screen.key === 'inventory' && itemNames.length > 0) {
          const shown = itemNames.filter((n) => text.includes(n.split(' ')[0])).length
          if (shown === 0) problems.push('مفيش أي صنف من أصناف المحل ظاهر في المخزون')
        }
      } catch (e) {
        problems.push(`الشاشة وقعت: ${e instanceof Error ? e.message : String(e)}`)
      }

      // ---- 2) first day (empty ledger) -----------------------------------
      try {
        const html = renderScreen(screen, biz, clientFor(biz, null))
        const text = textOf(html)
        if (text.length < 120) problems.push(`أول يوم: الشاشة فاضية (${text.length} حرف مقروء)`)
        else if (!screen.emptySignal.test(text)) problems.push('أول يوم: مفيش أي إرشاد للخطوة اللي بعدها')
      } catch (e) {
        problems.push(`أول يوم وقعت: ${e instanceof Error ? e.message : String(e)}`)
      }

      // ---- 3) network down (every query in `error` state) -----------------
      try {
        const html = renderScreen(screen, biz, errorClient(biz))
        const text = textOf(html)
        // The right answer is short — an error card with a retry button. What
        // must NOT happen is a quiet empty ledger that looks like a slow day.
        if (!/مش قادرين|تعذر|حصلت مشكلة/.test(text)) {
          problems.push('الشبكة واقعة: الشاشة ما بتقولش إن فيه مشكلة (بتبان فاضية)')
        } else if (!/جرّب تاني/.test(text)) {
          problems.push('الشبكة واقعة: مفيش زرار «جرّب تاني»')
        }
      } catch (e) {
        problems.push(`الشبكة واقعة: الشاشة وقعت (${e instanceof Error ? e.message : String(e)})`)
      }

      const ok = problems.length === 0
      results.push({ name: `${biz.type}/${screen.key}`, problems })
      console.log(`${ok ? '✅' : '❌'} ${screen.key.padEnd(10)} ${ok ? 'اترسمت: بيانات حقيقية + أول يوم + شبكة واقعة' : problems.join(' · ')}`)
    }
  }

  const failed = results.filter((r) => r.problems.length > 0)
  console.log(`\n${'─'.repeat(78)}\nالنتيجة: ${results.length - failed.length}/${results.length} شاشة سليمة\n`)
  if (failed.length > 0) process.exit(1)
}

await main()
