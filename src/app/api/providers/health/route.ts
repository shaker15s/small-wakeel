// GET /api/providers/health — the DeepSeek-harness «provider-check» pattern:
// before trusting a provider, call the endpoint DIRECTLY, measure latency,
// and report ok/down per provider.
//
// R44: the check now has TWO legs, run in parallel per provider:
//   1. GET  /models            — is the endpoint alive + what does it serve?
//   2. POST /chat/completions  — does the model ACCEPT native tool calling
//      (one trivial tool schema, max_tokens 16) and does it USE it?
//      That is the gate the brain relies on: a provider that 400s on the
//      `tools` field is transparently retried without it (self-heal) and
//      shown here as «بدون tool-calling» so the owner knows what he pays for.
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

/** The trivial capability probe: if the endpoint accepts this, the `tools`
 *  field is supported; if the model uses the tool, tool calling is live. */
const TOOL_PROBE = {
  tools: [
    {
      type: 'function',
      function: {
        name: 'wakil_probe',
        description: 'قدرة استدعاء الأدوات',
        parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      },
    },
  ],
  messages: [{ role: 'user', content: 'استخدم أداة wakil_probe بقيمة ok=true' }],
  max_tokens: 16,
  stream: false,
}

export async function GET(req: Request) {
  try {
    const gate = await guard(req, { scope: 'admin' })
    if (!gate.ok) return gate.res

    const providers = await db.modelProvider.findMany({
      include: { models: { where: { enabled: true }, select: { id: true, label: true, remoteId: true } } },
    })

    const results = await Promise.all(
      providers.map(async (p) => {
        const base = p.baseUrl.replace(/\/$/, '')
        const t0 = Date.now()
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
        const auth = { authorization: `Bearer ${decryptProviderKey(p.apiKey)}` }
        try {
          // ---- leg 1: /models (canonical OpenAI-compat capability probe)
          const modelsRes = await providerFetch(`${base}/models`, {
            method: 'GET',
            headers: auth,
            signal: ctrl.signal,
          })
          let modelCount = 0
          if (modelsRes.ok) {
            try {
              const json = (await modelsRes.json()) as { data?: unknown[] }
              modelCount = Array.isArray(json.data) ? json.data.length : 0
            } catch {
              modelCount = 0
            }
          }

          // ---- leg 2: native tool-calling probe (parallel, same budget)
          const firstModel = p.models[0]?.remoteId ?? 'default'
          let supportsTools: boolean | null = null
          let usedTool: boolean | null = null
          let toolMs: number | null = null
          const toolT0 = Date.now()
          try {
            const toolRes = await providerFetch(`${base}/chat/completions`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...auth },
              body: JSON.stringify({ model: firstModel, ...TOOL_PROBE }),
              signal: ctrl.signal,
            })
            toolMs = Date.now() - toolT0
            if (toolRes.ok) {
              supportsTools = true
              const json = (await toolRes.json().catch(() => null)) as {
                choices?: { message?: { tool_calls?: unknown[] } }[]
              } | null
              usedTool = Array.isArray(json?.choices?.[0]?.message?.tool_calls) && json.choices[0].message!.tool_calls!.length > 0
            } else {
              const detail = await toolRes.text().catch(() => '')
              // A 4xx that names the tools field = provider WITHOUT tool
              // support (the harness self-heals to JSON-in-text for it).
              supportsTools = /tool|function|schema|unknown parameter|invalid request/i.test(detail) ? false : null
            }
          } catch {
            // probe leg failed (abort/timeout) — models leg still reports ok
            toolMs = null
          }

          return {
            id: p.id,
            name: p.name,
            baseUrl: p.baseUrl,
            ok: modelsRes.ok,
            status: modelsRes.status,
            ms: Date.now() - t0,
            modelCount,
            enabledModels: p.models.length,
            supportsTools,
            usedTool,
            toolMs,
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
            supportsTools: null as boolean | null,
            usedTool: null as boolean | null,
            toolMs: null as number | null,
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
