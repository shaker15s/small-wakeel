// Production search has no fixture backend or silent synthetic fallback.
import { zaiAvailable } from './llm'
import { publicFetch } from '@/lib/security/provider-network'

export interface WebResult {
  title: string
  url: string
  snippet: string
  host: string
  /** which backend produced this result — surfaced in the UI/debug */ 
  via: 'zai' | 'http'
}

export interface WebSearchOutcome {
  results: WebResult[]
  backend: 'zai' | 'http' | 'none'
  error?: string
  ms: number
}

export function searchBackend(): 'zai' | 'http' | 'none' {
  if (zaiAvailable()) return 'zai'
  if ((process.env.WAKIL_SEARCH_URL ?? '').trim()) return 'http'
  return 'none'
}

const SEARCH_TIMEOUT_MS = 8_000

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** Normalise the handful of JSON shapes search endpoints actually return. */
function normalise(json: unknown): { title: string; url: string; snippet: string }[] {
  const obj = json as Record<string, unknown> | null
  if (!obj || typeof obj !== 'object') return []
  const raw =
    (Array.isArray(obj.results) && obj.results) ||
    (Array.isArray(obj.hits) && obj.hits) ||
    (Array.isArray(obj.items) && obj.items) ||
    (Array.isArray(obj.data) && obj.data) ||
    (Array.isArray(json) ? (json as unknown[]) : [])
  if (!Array.isArray(raw)) return []
  const out: { title: string; url: string; snippet: string }[] = []
  for (const item of raw) {
    const r = item as Record<string, unknown>
    if (!r || typeof r !== 'object') continue
    const url = String(r.url ?? r.link ?? r.href ?? '')
    const title = String(r.title ?? r.name ?? r.headline ?? url)
    const snippet = String(r.snippet ?? r.description ?? r.text ?? r.summary ?? '').slice(0, 400)
    if (!url && !title) continue
    out.push({ title: title.slice(0, 200), url, snippet })
  }
  return out
}

async function httpSearch(url: string, query: string, num: number): Promise<WebResult[]> {
  const target = `${url}${url.includes('?') ? '&' : '?'}q=${encodeURIComponent(query)}&num=${num}`
  const res = await publicFetch(target, {
    headers: {
      accept: 'application/json',
      ...(process.env.WAKIL_SEARCH_KEY ? { authorization: `Bearer ${process.env.WAKIL_SEARCH_KEY}` } : {}),
    },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`مزوّد البحث رجع ${res.status}`)
  const json = (await res.json()) as unknown
  return normalise(json).map((r) => ({ ...r, host: hostOf(r.url), via: 'http' as const }))
}

async function zaiSearch(query: string, num: number): Promise<WebResult[]> {
  const ZAI = (await import('z-ai-web-dev-sdk')).default
  const zai = await ZAI.create()
  const results = (await zai.functions.invoke('web_search', { query, num })) as unknown
  return normalise(results).map((r) => ({ ...r, host: hostOf(r.url), via: 'zai' as const }))
}

/**
 * Search the web. Never throws — an unreachable backend is a fact the caller
 * reports, not an exception that kills a turn.
 */
export async function searchWeb(query: string, num = 5): Promise<WebSearchOutcome> {
  const started = Date.now()
  const backend = searchBackend()
  if (backend === 'none') {
    return { results: [], backend: 'none', error: 'مفيش مزوّد بحث مظبوط (WAKIL_SEARCH_URL أو .z-ai-config)', ms: 0 }
  }
  try {
    const results =
      backend === 'zai'
        ? await zaiSearch(query, num)
        : await httpSearch(process.env.WAKIL_SEARCH_URL ?? '', query, num)
    return { results: results.slice(0, num).map((r) => ({ ...r, via: backend })), backend, ms: Date.now() - started }
  } catch (err) {
    return { results: [], backend, error: err instanceof Error ? err.message : 'فشل البحث', ms: Date.now() - started }
  }
}

/** Honest one-line status for the health endpoint / settings screen. */
export function searchStatus(): { backend: string; url: string | null } {
  const backend = searchBackend()
  return { backend, url: backend === 'http' ? (process.env.WAKIL_SEARCH_URL ?? null) : null }
}
