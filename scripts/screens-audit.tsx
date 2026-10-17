// scripts/screens-audit.tsx — «شاشات بايضة» as a repeatable gate.
//
// Every screen is SERVER-RENDERED with real data from the live API and then
// again with the payload of a brand-new business (nothing recorded yet). A
// screen that crashes, renders nothing, or shows no guidance when the ledger is
// empty fails the gate — that is exactly what «شاشة بايضة» means in practice.
//
//   bun run screens                     # all screens, owner of the supermarket
//   bun run screens --all-businesses    # every vertical × owner
//   bun run screens --only inventory    # one screen
//   bun run screens --url http://localhost:3000
//
// It needs the dev server (and, for chat turns, the mock provider) running.
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { QUERY_KEYS } from '../src/lib/store'
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
const ALL = args.includes('--all-businesses')

const BUSINESSES = [
  { key: 'super', name: 'سوبر ماركت النور', biz: 'cmvav3psg000iorbm9e9y9hb8', user: 'cmvav3psh000korbmqwag4fcz' },
  { key: 'gym', name: 'جيم أبطال', biz: 'cmvav3pv0006jorbme9kf58ul', user: 'cmvav3pv1006lorbmi34gwdhm' },
  { key: 'pharmacy', name: 'صيدلية الشفاء', biz: 'cmvav3pxd00b6orbmj7dvqgdr', user: 'cmvav3pxe00b8orbmvlpvjlrh' },
  { key: 'attar', name: 'عطارة المسك', biz: 'cmvav3pzy00gjorbm70rupsbp', user: 'cmvav3pzz00glorbmnzoklps4' },
]

const realFetch = globalThis.fetch
// The browser resolves `/api/...` against the origin; node does not.
const fetchJson = async <T,>(path: string): Promise<T> => {
  const res = await realFetch(`${BASE}${path}`)
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`)
  return (await res.json()) as T
}

/** Empty-ledger payloads: what a shop sees on day one. */
const EMPTY = {
  overview: {
    cash: { balance: 0, in: 0, out: 0 },
    today: { sales: 0, purchases: 0, expenses: 0, collections: 0, salesCount: 0 },
    pendingOps: [],
    lowStock: [],
    expiring: [],
    receivables: [],
    payables: [],
    recentOps: [],
  },
  items: [],
  operations: [],
  memories: [],
  reports: { range: '30d', daily: [], totals: { sales: 0, purchases: 0, expenses: 0, collections: 0, profit: 0 }, topItems: [], byType: [] },
  tasks: { tasks: [] },
  providers: { providers: [] },
  radar: [],
  suggestions: [],
  tools: [],
  bootstrap: { businesses: [], activeBusinessId: null, activeUserId: null },
}

type ScreenResult = { name: string; ok: boolean; problems: string[]; bytes: number }

const LANDMARK: Record<string, RegExp> = {
  today: /النهاردة|اليوم|الخزنة|آخر الحركات/,
  inventory: /المخزون|الأصناف|بحث/,
  journal: /العمليات|سجل|WKL-|الحركات/,
  accounts: /العملاء|الحسابات|مديون/,
  stats: /المبيعات|الإيرادات|أداء/,
  reports: /تقرير|المبيعات|آخر ٣٠|30 يوم/,
  memory: /فاكرها|اتعلمته|ذاكرتي|الذاكرة|أدوات بتاعتك/,
  settings: /الإعدادات|المزوّد|الموديل/,
}
/** What a first-day shop must READ when there is no data yet. */
const EMPTY_HINT = /مفيش|لسه|لا يوجد|ابدأ|ابدا|ضيف|سجّل|سجل|فاضي|فاضية|هنا|البداية|نضيف|جديد|قيد|أول|اول/

function cacheKeys(biz: string, user: string): (readonly unknown[])[] {
  return [
    QUERY_KEYS.overview(biz, user),
    QUERY_KEYS.items(biz),
    QUERY_KEYS.operations(biz),
    QUERY_KEYS.memories(biz),
    QUERY_KEYS.reports(biz, '7d'),
    QUERY_KEYS.reports(biz, '30d'),
    QUERY_KEYS.tasks(biz),
    QUERY_KEYS.providers,
    QUERY_KEYS.radar(biz),
    QUERY_KEYS.suggestions(biz, user),
    QUERY_KEYS.tools(biz, user),
    ['bootstrap'],
  ]
}

function buildClient(payload: Record<string, unknown>, biz: string, user: string): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  })
  const put = (key: readonly unknown[], value: unknown) => qc.setQueryData(key as never, value as never)
  put(QUERY_KEYS.overview(biz, user), payload.overview)
  put(QUERY_KEYS.items(biz), payload.items)
  put(QUERY_KEYS.operations(biz), payload.operations)
  put(QUERY_KEYS.memories(biz), payload.memories)
  put(QUERY_KEYS.reports(biz, '7d'), payload.reports)
  put(QUERY_KEYS.reports(biz, '30d'), payload.reports)
  put(QUERY_KEYS.tasks(biz), payload.tasks)
  put(QUERY_KEYS.providers, payload.providers)
  put(QUERY_KEYS.radar(biz), payload.radar)
  put(QUERY_KEYS.suggestions(biz, user), payload.suggestions)
  put(QUERY_KEYS.tools(biz, user), payload.tools)
  put(['bootstrap'], payload.bootstrap)
  return qc
}

/**
 * «الشبكة وقعت» path: every query is already in `error` state, so the screen
 * renders its FAILURE branch synchronously. A screen that shows «فاضي» or
 * four zeros here is lying to the owner — that is the worst failure mode for
 * a shop app, so the gate treats it as a failure.
 */
function errorClient(biz: string, user: string): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } })
  for (const key of cacheKeys(biz, user)) {
    // `enabled:false` is what makes this DETERMINISTIC: the observer is not
    // allowed to kick off a real request on mount (a real fetch would flip the
    // screen back to «loading» and the check would pass without testing the
    // failure branch).
    qc.setQueryDefaults(key, { enabled: false, retryOnMount: false })
    const query = qc.getQueryCache().build(qc as never, { queryKey: key } as never) as unknown as {
      setState: (state: Record<string, unknown>) => void
    }
    query.setState({
      status: 'error',
      error: new Error('تعذر الاتصال بالسيرفر'),
      fetchStatus: 'idle',
      dataUpdatedAt: Date.now(),
      errorUpdatedAt: Date.now(),
    })
  }
  return qc
}

async function livePayload(biz: string, user: string): Promise<Record<string, unknown>> {
  const [overview, items, operations, memories, reports, tasks, providers, radar, suggestions, tools, bootstrap] = await Promise.all([
    fetchJson(`/api/overview?businessId=${biz}&userId=${user}`),
    fetchJson(`/api/items?businessId=${biz}`),
    fetchJson(`/api/operations?businessId=${biz}`),
    fetchJson(`/api/memories?businessId=${biz}`),
    fetchJson(`/api/reports?businessId=${biz}&range=30d`),
    fetchJson(`/api/tasks?businessId=${biz}`),
    fetchJson('/api/providers'),
    fetchJson(`/api/radar?businessId=${biz}&userId=${user}`),
    fetchJson(`/api/suggestions?businessId=${biz}&userId=${user}`),
    fetchJson(`/api/tools?businessId=${biz}&userId=${user}`),
    fetchJson('/api/bootstrap'),
  ])
  return { overview, items, operations, memories, reports, tasks, providers, radar, suggestions, tools, bootstrap }
}

const SCREENS: { key: string; render: (ctx: { biz: string; user: string; qc: QueryClient; businessName: string }) => React.ReactElement }[] = [
  {
    key: 'today',
    render: ({ biz, user, qc }) =>
      h(QueryClientProvider, { client: qc }, h(TodayView, { businessId: biz, userId: user, onNavigate: () => {} })),
  },
  {
    key: 'inventory',
    render: ({ biz, user, qc }) =>
      h(QueryClientProvider, { client: qc }, h(InventoryView, { businessId: biz, userId: user, onNavigate: () => {} })),
  },
  {
    key: 'journal',
    render: ({ biz, user, qc }) =>
      h(QueryClientProvider, { client: qc }, h(JournalView, { businessId: biz, userId: user, onNavigate: () => {} })),
  },
  {
    key: 'accounts',
    render: ({ biz, user, qc }) =>
      h(QueryClientProvider, { client: qc }, h(AccountsView, { businessId: biz, userId: user, onNavigate: () => {} })),
  },
  {
    key: 'stats',
    render: ({ biz, user, qc }) =>
      h(QueryClientProvider, { client: qc }, h(StatsView, { businessId: biz, userId: user, onNavigate: () => {} })),
  },
  {
    key: 'reports',
    render: ({ biz, user, qc, businessName }) =>
      h(QueryClientProvider, { client: qc }, h(ReportsView, { businessId: biz, userId: user, businessName })),
  },
  {
    key: 'memory',
    render: ({ biz, user, qc }) =>
      h(QueryClientProvider, { client: qc }, h(MemoryView, { businessId: biz, userId: user, onNavigate: () => {} })),
  },
  {
    key: 'settings',
    render: ({ biz, user, qc }) =>
      h(QueryClientProvider, { client: qc }, h(SettingsView, { businessId: biz, userId: user, onNavigate: () => {} })),
  },
]

function renderOne(
  screen: (typeof SCREENS)[number],
  payload: Record<string, unknown>,
  biz: string,
  user: string,
  businessName: string,
  client?: QueryClient,
) {
  const qc = client ?? buildClient(payload, biz, user)
  const errors: string[] = []
  const origError = console.error
  console.error = (...a: unknown[]) => {
    const line = a.map(String).join(' ')
    // React logs missing-key etc. — those are noise; real crashes surface as throws
    if (!/Warning:|key` prop|validateDOMNesting/.test(line)) errors.push(line.slice(0, 200))
  }
  try {
    const html = renderToStaticMarkup(screen.render({ biz, user, qc, businessName }))
    return { html, errors }
  } finally {
    console.error = origError
  }
}

const results: ScreenResult[] = []
const businesses = ALL ? BUSINESSES : BUSINESSES.slice(0, 1)

for (const b of businesses) {
  console.log(`\n${b.name} — ${b.key}\n${'─'.repeat(72)}`)
  let payload: Record<string, unknown> = {}
  let liveError: string | null = null
  try {
    payload = await livePayload(b.biz, b.user)
  } catch (e) {
    liveError = e instanceof Error ? e.message : String(e)
  }

  for (const screen of SCREENS) {
    if (ONLY && ONLY !== screen.key) continue
    const problems: string[] = []
    let bytes = 0

    // ---- 1) real data ----------------------------------------------------
    if (liveError) problems.push(`تعذر تحميل البيانات: ${liveError}`)
    else {
      try {
        const { html, errors } = renderOne(screen, payload, b.biz, b.user, b.name)
        bytes = html.length
        if (html.length < 400) problems.push(`شاشة فاضية (${html.length} حرف)`)
        const text = html.replace(/<[^>]+>/g, ' ')
        if (!LANDMARK[screen.key].test(text)) problems.push(`مفيش أثر للمحتوى المتوقع (${LANDMARK[screen.key]})`)
        if (errors.length > 0) problems.push(`خطأ أثناء الرسم: ${errors[0]}`)
      } catch (e) {
        problems.push(`الشاشة وقعت: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // ---- 2) first day (empty ledger) ------------------------------------
    if (!ONLY || ONLY === screen.key) {
      try {
        const { html, errors } = renderOne(
          screen,
          { ...EMPTY, bootstrap: { businesses: [{ id: b.biz, name: b.name, users: [{ id: b.user, name: 'صاحب الشغل', role: 'owner' }] }] } },
          b.biz,
          b.user,
          b.name,
        )
        const text = html.replace(/<[^>]+>/g, ' ')
        if (ba_size(html) < 300) problems.push(`شاشة فاضية أول يوم (${html.length} حرف)`)
        else if (!EMPTY_HINT.test(text)) problems.push('مفيش أي إرشاد لما مفيش بيانات (شاشة بيضة أول يوم)')
        if (errors.length > 0) problems.push(`خطأ أول يوم: ${errors[0]}`)
      } catch (e) {
        problems.push(`شاشة أول يوم وقعت: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // ---- 3) network failure (every query errored) ------------------------
    if (!ONLY || ONLY === screen.key) {
      try {
        const { html, errors } = renderOne(screen, {}, b.biz, b.user, b.name, errorClient(b.biz, b.user))
        const text = html.replace(/<[^>]+>/g, ' ')
        // A real failure branch: says something went wrong AND offers a retry.
        // «مفيش بيانات» alone is a lie when the request itself failed.
        const saysFailed = /مش قادرين|تعذر|مشكلة|فشل|الخطأ/.test(text)
        const saysRetry = /جرّب تاني|إعادة المحاولة|حاول تاني|تاني/.test(text)
        if (!saysFailed) problems.push('شاشة الشبكة الواقعة مش بتقول إن فيه مشكلة (بتظهر كأنها فاضية)')
        else if (!saysRetry) problems.push('شاشة الخطأ مفيهاش زر «جرّب تاني»')
        if (errors.length > 0) problems.push(`خطأ في رسم شاشة الخطأ: ${errors[0]}`)
      } catch (e) {
        problems.push(`شاشة الخطأ وقعت: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    const ok = problems.length === 0
    results.push({ name: `${b.key}/${screen.key}`, ok, problems, bytes })
    console.log(`${ok ? '✅' : '❌'} ${screen.key.padEnd(10)} ${ok ? `${bytes} حرف` : problems.join(' · ')}`)
  }
}

function ba_size(s: string): number {
  return s.length
}

const passed = results.filter((r) => r.ok).length
console.log(`\n${'─'.repeat(72)}\nالنتيجة: ${passed}/${results.length} شاشة سليمة\n`)
process.exit(passed === results.length ? 0 : 1)
