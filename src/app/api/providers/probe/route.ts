// POST /api/providers/probe {modelConfigId} → ProbeResultDTO
// Three TINY requests to the provider (total <150 tokens budget):
//   1) streaming ping (max_tokens 40) → ttftMs + tps + supportsStreaming
//   2) non-stream completion (max_tokens 30) → basic ok
//   3) tools-parameter request (max_tokens 30) → supportsTools
// 20s OVERALL timeout via one shared AbortSignal. The result is persisted as
// a ProviderCapability (upsert by modelConfigId).
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import type { ProbeResultDTO } from '@/lib/types'
import { badRequest, notFound, serverError } from '../../_lib/http'
import { guard } from '../../_lib/guard'

export const dynamic = 'force-dynamic'

const PROBE_TIMEOUT_MS = 20_000
const TINY_MESSAGES = [{ role: 'user', content: 'سلام — اختبار سريع. رد بكلمة واحدة.' }]

/** Rough token estimate: ~4 chars per token (no tokenizer client-side). */
const estTokens = (chars: number) => Math.max(1, Math.ceil(chars / 4))

export async function POST(req: Request) {
  try {
    const gate = await guard(req, { scope: 'open' })
    if (!gate.ok) return gate.res
    const body = (await req.json()) as { modelConfigId?: string }
    if (!body.modelConfigId) return badRequest('modelConfigId مطلوب')

    const config = await db.modelConfig.findUnique({
      where: { id: body.modelConfigId },
      include: { provider: true },
    })
    if (!config) return notFound('الموديل غير موجود')

    const base = config.provider.baseUrl.replace(/\/$/, '')
    const url = `${base}/chat/completions`
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${config.provider.apiKey}`,
    }
    // ONE signal caps the WHOLE probe at 20s
    const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS)

    let ok = false
    let supportsStreaming = false
    let supportsTools = false
    let ttftMs: number | null = null
    let tps: number | null = null
    let note = ''

    // ---- 1) streaming ping: TTFT + throughput ----
    try {
      const t0 = Date.now()
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: config.remoteId, messages: TINY_MESSAGES, stream: true, max_tokens: 40 }),
        signal,
      })
      if (res.ok && res.body) {
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let firstChunkAt: number | null = null
        let contentChars = 0
        let lastChunkAt: number | null = null
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data:')) continue
            const data = trimmed.slice(5).trim()
            if (data === '[DONE]') continue
            try {
              const json = JSON.parse(data) as { choices?: { delta?: { content?: string; reasoning_content?: string } }[] }
              const delta = json.choices?.[0]?.delta
              const piece = delta?.content ?? delta?.reasoning_content ?? ''
              if (piece) {
                if (firstChunkAt == null) firstChunkAt = Date.now()
                lastChunkAt = Date.now()
                contentChars += piece.length
              }
            } catch {
              /* keepalive noise */
            }
          }
        }
        if (firstChunkAt != null) {
          supportsStreaming = true
          ok = true
          ttftMs = firstChunkAt - t0
          if (lastChunkAt != null && lastChunkAt > firstChunkAt) {
            const seconds = (lastChunkAt - firstChunkAt) / 1000
            if (seconds > 0.05) tps = Math.round(estTokens(contentChars) / seconds)
          } else {
            tps = null // single-shot reply — throughput not measurable
          }
          note = `التدفق شغال — أول حرف جه بعد ${ttftMs}ms`
        } else {
          note = 'المزوّد رد من غير بيانات تدفق'
        }
      } else {
        note = `طلب التدفق رجع ${res.status}`
      }
    } catch (e) {
      note = `طلب التدفق فشل: ${(e as Error).name === 'TimeoutError' ? 'انتهت المهلة (20 ثانية)' : (e as Error).message}`
    }

    // ---- 2) non-stream completion ----
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: config.remoteId, messages: TINY_MESSAGES, stream: false, max_tokens: 30 }),
        signal,
      })
      if (res.ok) {
        ok = true
        if (!supportsStreaming) note = note ? `${note} — بس الاتصال العادي شغال` : 'الاتصال العادي شغال (من غير تدفق)'
      } else if (!ok) {
        note = `المزوّد رجع ${res.status} على الطلب العادي`
      }
    } catch (e) {
      if (!ok) note = `الاتصال العادي فشل: ${(e as Error).name === 'TimeoutError' ? 'انتهت المهلة (20 ثانية)' : (e as Error).message}`
    }

    // ---- 3) tools parameter support ----
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.remoteId,
          messages: TINY_MESSAGES,
          stream: false,
          max_tokens: 30,
          tools: [
            {
              type: 'function',
              function: {
                name: 'wakil_probe',
                description: 'اختبار دعم الأدوات',
                parameters: { type: 'object', properties: { ping: { type: 'string' } } },
              },
            },
          ],
        }),
        signal,
      })
      supportsTools = res.ok
      if (!res.ok && ok) note = `${note} — الأدوات (tools) مش مدعومة عنده`
    } catch {
      supportsTools = false
    }

    const result: ProbeResultDTO = {
      modelConfigId: config.id,
      ok,
      supportsStreaming,
      supportsTools,
      ttftMs,
      tps,
      note: ok ? note || 'الاتصال تمام' : note || 'المزوّد مش متاح',
    }

    // persist (upsert by the unique modelConfigId)
    await db.providerCapability.upsert({
      where: { modelConfigId: config.id },
      create: {
        modelConfigId: config.id,
        ok,
        supportsStreaming,
        supportsTools,
        ttftMs,
        tps,
        note: result.note,
      },
      update: {
        ok,
        supportsStreaming,
        supportsTools,
        ttftMs,
        tps,
        note: result.note,
        probedAt: new Date(),
      },
    })

    return NextResponse.json(result)
  } catch (e) {
    return serverError('providers-probe', e)
  }
}
