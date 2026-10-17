// وكيل — «أدوات بتاعتك» (R16): the user-extensible tool registry the AGENT
// actually uses. The shop owner adds his own tools (a web source scoped to a
// site he trusts, or a read-only webhook that returns DATA), and the
// deep-research pipeline runs them during the gather phase — Claude-style
// skills, but for an Egyptian shop owner.
//
// HARD SAFETY CONTRACTS:
//   1. A tool failure NEVER breaks the turn — every path returns a graceful
//      Arabic result and the pipeline continues («كمّلت من غيرها»).
//   2. Webhooks are READ-ONLY DATA FETCHES: the response is read as text and
//      truncated (2000 chars). It is NEVER executed, NEVER parsed into code,
//      and NEVER auto-triggers actions — data only, citation-grade.
//   3. SSRF guard: local/private/link-local hostnames are rejected unless
//      ALLOW_LOCAL_WEBHOOKS==='1' (dev escape hatch), redirects are refused,
//      and every fetch is capped at 8s via AbortController.
//
// Config JSON shapes (stored as a string on CustomTool.config):
//   web_source: { "site": "drogal.com", "queryTemplate": "أسعار المنظفات" }
//     — site: REQUIRED hostname (no scheme); queryTemplate: OPTIONAL (defaults
//       to the user's question). Ran as web_search with `site:` scoping.
//   webhook: { "url": "https://...", "method": "GET" | "POST", "bodyTemplate": "{}", "note": "اختياري" }
//     — url: REQUIRED valid http(s); method: default GET; bodyTemplate:
//       OPTIONAL raw JSON body (must parse) sent on POST.

import type { CustomTool } from '@prisma/client'
import ZAI from 'z-ai-web-dev-sdk'
import { db } from '@/lib/db'
import type { SourceDTO } from '@/lib/types'

/** A prisma CustomTool row (the agent-side handle for one of the owner's tools). */
export type CustomToolRow = CustomTool

export type CustomToolKind = 'web_source' | 'webhook'

/** The result of running one user tool — never throws, never breaks the turn. */
export interface UserToolRun {
  ok: boolean
  /** the tool name (what the user called it) */
  label: string
  /** short Egyptian-Arabic outcome line (shown in thinking step details / notes) */
  summary: string
  /** gathered evidence — only present for successful runs with results */
  sources?: SourceDTO[]
}

// ---------------------------------------------------------------------------
// Config parsing (the JSON string column → typed shape, defensively)
// ---------------------------------------------------------------------------

const CONFIG_KEYS = ['site', 'queryTemplate', 'url', 'method', 'bodyTemplate', 'note'] as const

/** Parse CustomTool.config into its typed shape; invalid/missing → {}. */
export function parseToolConfig(raw: string | null | undefined): Partial<Record<(typeof CONFIG_KEYS)[number], string>> {
  try {
    const parsed = JSON.parse(raw ?? '') as Record<string, unknown> | null
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Partial<Record<(typeof CONFIG_KEYS)[number], string>> = {}
    for (const key of CONFIG_KEYS) {
      const v = parsed[key]
      if (typeof v === 'string' && v.trim()) out[key] = v.trim()
    }
    return out
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// Registry access + prompt line
// ---------------------------------------------------------------------------

/**
 * The business's ACTIVE tools, name ASC. Never throws — on DB trouble it
 * returns [] so the turn continues as if the owner had no tools.
 */
export async function activeTools(businessId: string): Promise<CustomToolRow[]> {
  try {
    return await db.customTool.findMany({
      where: { businessId, active: true, kind: { in: ['web_source', 'webhook'] } },
      orderBy: { name: 'asc' },
    })
  } catch (e) {
    console.error('[userTools] activeTools failed (كمّلت من غير الأدوات):', e)
    return []
  }
}

const KIND_PROMPT_AR: Record<string, string> = {
  web_source: 'مصدر ويب',
  webhook: 'أمر خارجي',
}

const AR_ORDINALS = ['١', '٢', '٣', '٤', '٥', '٦', '٧', '٨']

/**
 * One compact line for the system prompt telling the agent the OWNER added
 * his own tools («أدوات خاصة أضافها صاحب الشغل بنفسه: (١) … [مصدر ويب] —
 * استخدمها لما تكون مناسبة للسؤال»). Empty string when no active tools —
 * callers append it additively, so the prompt stays byte-identical without
 * tools.
 */
export function userToolsPromptLine(tools: CustomToolRow[]): string {
  const active = tools.filter((t) => t.active).slice(0, 8)
  if (active.length === 0) return ''
  const items = active
    .map((t, i) => `(${AR_ORDINALS[i]}) ${t.name} [${KIND_PROMPT_AR[t.kind] ?? t.kind}]`)
    .join('، ')
  return `أدوات خاصة أضافها صاحب الشغل بنفسه: ${items} — استخدمها لما تكون مناسبة للسؤال`
}

// ---------------------------------------------------------------------------
// The SSRF guard — webhooks only ever touch public http(s) hosts
// ---------------------------------------------------------------------------

/** Private/loopback/link-local/metadata hostnames the agent must never fetch. */
function isBlockedHost(hostname: string): boolean {
  if (process.env.ALLOW_LOCAL_WEBHOOKS === '1') return false
  const h = hostname.toLowerCase().replace(/\.$/, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal')) return true
  if (h === '0.0.0.0' || h === '::' || h === '::1') return true // IPv6 any/loopback
  if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true // IPv6 ULA / link-local
  if (/^127\./.test(h)) return true // 127.0.0.0/8 loopback
  if (/^10\./.test(h)) return true // 10.0.0.0/8 private
  if (/^169\.254\./.test(h)) return true // 169.254.0.0/16 link-local (+ cloud metadata)
  if (/^192\.168\./.test(h)) return true // 192.168.0.0/16 private
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true // 172.16.0.0/12 private
  return false
}

// ---------------------------------------------------------------------------
// The runners
// ---------------------------------------------------------------------------

/** usageCount++ + lastUsedAt=now — fire-and-forget, telemetry only. */
function markUsed(toolId: string): void {
  void db.customTool
    .update({ where: { id: toolId }, data: { usageCount: { increment: 1 }, lastUsedAt: new Date() } })
    .catch(() => {})
}

/**
 * Run ONE of the owner's tools against the current question. NEVER throws —
 * any failure comes back as { ok: false } with a graceful Egyptian-Arabic
 * summary so the turn continues («الأداة ما ردتش — كمّلت من غيرها»).
 */
export async function runUserTool(tool: CustomToolRow, question: string): Promise<UserToolRun> {
  const config = parseToolConfig(tool.config)
  try {
    const out =
      tool.kind === 'webhook' ? await runWebhook(tool, config) : await runWebSource(tool, config, question)
    return out
  } catch (e) {
    // timeout / network / SDK hiccup — a dead tool must never kill the turn
    console.error('[userTools] runUserTool failed (كمّلت من غيرها):', e)
    return { ok: false, label: tool.name, summary: 'الأداة ما ردتش — كمّلت من غيرها' }
  } finally {
    markUsed(tool.id)
  }
}

/** web_source: `${queryTemplate || question} site:${site}` → z-ai web_search (backend only). */
async function runWebSource(
  tool: CustomToolRow,
  config: Partial<Record<(typeof CONFIG_KEYS)[number], string>>,
  question: string,
): Promise<UserToolRun> {
  const site = (config.site ?? '').toLowerCase()
  if (!site) return { ok: false, label: tool.name, summary: 'الأداة ناقصة اسم الموقع — عدّلها من «ذاكرة وكيل»' }
  const query = `${(config.queryTemplate || question).trim().slice(0, 120)} site:${site}`
  let results: unknown
  try {
    const zai = await ZAI.create()
    results = await zai.functions.invoke('web_search', { query, num: 5 })
  } catch (e) {
    // the search backend throws 422 "No search results available" when the
    // scoped query simply has nothing — that's an honest empty answer, not a
    // dead tool (it still lands as a graceful step, never a broken turn)
    const msg = e instanceof Error ? e.message : String(e ?? '')
    if (/No search results/i.test(msg)) {
      return { ok: true, label: tool.name, summary: `الموقع ${site} رجّع صفر نتايج للسؤال ده`, sources: [] }
    }
    throw e
  }
  if (!Array.isArray(results)) {
    return { ok: false, label: tool.name, summary: 'الأداة ما ردتش — كمّلت من غيرها' }
  }
  const sources: SourceDTO[] = []
  for (const r of results) {
    if (!r || typeof r.url !== 'string' || !/^https?:\/\//.test(r.url)) continue
    sources.push({
      title: String(r.name ?? r.url).trim() || r.url,
      url: r.url,
      snippet: String(r.snippet ?? '').trim(),
      host: String(r.host_name ?? '').trim() || site,
    })
  }
  if (sources.length === 0) {
    return { ok: true, label: tool.name, summary: `الموقع ${site} رجّع صفر نتايج للسؤال ده`, sources: [] }
  }
  return {
    ok: true,
    label: tool.name,
    summary: `${toArabicDigits(sources.length)} نتيجة من ${site}`,
    sources,
  }
}

/** webhook: SSRF-guarded, 8s-capped, GET|POST read-only data fetch. */
async function runWebhook(
  tool: CustomToolRow,
  config: Partial<Record<(typeof CONFIG_KEYS)[number], string>>,
): Promise<UserToolRun> {
  const urlRaw = (config.url ?? '').trim()
  let parsed: URL
  try {
    parsed = new URL(urlRaw)
  } catch {
    return { ok: false, label: tool.name, summary: 'الرابط مش مكتوب صح — عدّل الأداة' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, label: tool.name, summary: 'الرابط لازم يبدأ بـ http أو https' }
  }
  if (isBlockedHost(parsed.hostname)) {
    return { ok: false, label: tool.name, summary: 'الرابط ده داخلي — سياسة الأمان بتمنع وكيل يطلبه' }
  }
  const method = config.method === 'POST' ? 'POST' : 'GET'
  const bodyTemplate = (config.bodyTemplate ?? '').trim()
  let body: string | undefined
  if (method === 'POST' && bodyTemplate) {
    try {
      JSON.parse(bodyTemplate) // must be valid JSON — never a loose string
      body = bodyTemplate
    } catch {
      return { ok: false, label: tool.name, summary: 'الـbody مش JSON سليم — عدّل الأداة' }
    }
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8_000) // hard 8s cap
  try {
    const res = await fetch(parsed.toString(), {
      method,
      ...(body ? { body } : {}),
      headers: {
        accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      signal: ctrl.signal,
      redirect: 'error', // a redirect could bounce past the SSRF guard — refuse
      cache: 'no-store',
    })
    if (!res.ok) {
      return { ok: false, label: tool.name, summary: `الرابط رد بكود ${toArabicDigits(res.status)} — كمّلت من غيرها` }
    }
    // DATA ONLY: read as text, cap at 2000 chars, never executed, never
    // auto-triggers any action — it becomes citation-grade evidence at most.
    const text = (await res.text()).slice(0, 2000)
    if (!text.trim()) {
      return { ok: true, label: tool.name, summary: 'الرابط رد بس فاضي', sources: [] }
    }
    return {
      ok: true,
      label: tool.name,
      summary: `الرابط رد ببيانات (${toArabicDigits(text.length)} حرف)`,
      sources: [{ title: tool.name, url: parsed.toString(), snippet: text, host: parsed.hostname }],
    }
  } finally {
    clearTimeout(timer)
  }
}

function toArabicDigits(n: number): string {
  return String(n).replace(/[0-9]/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)])
}
