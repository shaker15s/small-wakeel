// GET /api/providers/health — the DeepSeek-harness «provider-check» pattern:
// before trusting a provider, call the endpoint DIRECTLY (its /models
// route, the canonical OpenAI-compat capability probe), measure latency,
// and report ok/down per provider.
//
// Security contract (same as the rest of the BYO layer):
//   • the API key NEVER leaves the server and NEVER appears in the response
//   • provider error bodies are truncated + redacted (a gateway echo could
//     leak request details)
//   • the guard requires admin scope, same as /api/providers
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { serverError } from '../../_lib/http'
import { guard } from '../../_lib/guard'
import { decryptProviderKey } from '@/lib/security/provider-secrets'
import { providerFetch } from '@/lib/security/provider-network'

export const dynamic = 'force-dynamic'

const PROBE_TIMEOUT_MS = 8_000

export async function GET(req: Request) {
  try {
    const gate = await guard(req, { scope: 'admin' })
    if (!gate.ok) return gate.res

    const providers = await db.modelProvider.findMany({
      include: { models: { where: { enabled: true }, select: { id: true, label: true } } },
    })

    const results = await Promise.all(
      providers.map(async (p) => {
        const url = `${p.baseUrl.replace(/\/$/, '')}/models`
        const t0 = Date.now()
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
        try {
          const res = await providerFetch(url, {
            method: 'GET',
            headers: { authorization: `Bearer ${decryptProviderKey(p.apiKey)}` },
            signal: ctrl.signal,
          })
          const ms = Date.now() - t0
          let modelCount = 0
          if (res.ok) {
            try {
              const json = (await res.json()) as { data?: unknown[] }
              modelCount = Array.isArray(json.data) ? json.data.length : 0
            } catch {
              modelCount = 0
            }
          }
          return {
            id: p.id,
            name: p.name,
            baseUrl: p.baseUrl,
            ok: res.ok,
            status: res.status,
            ms,
            modelCount,
            enabledModels: p.models.length,
          }
        } catch (err) {
          // redacted: the error text can carry gateway echoes
          const detail = err instanceof Error ? err.message.slice(0, 120) : 'تعذّر الاتصال'
          return {
            id: p.id,
            name: p.name,
            baseUrl: p.baseUrl,
            ok: false,
            status: null as number | null,
            ms: Date.now() - t0,
            modelCount: 0,
            enabledModels: p.models.length,
            detail,
          }
        } finally {
          clearTimeout(timer)
        }
      }),
    )

    return NextResponse.json({ providers: results, at: new Date().toISOString() })
  } catch (err) {
    return serverError('providers/health', err)
  }
}
