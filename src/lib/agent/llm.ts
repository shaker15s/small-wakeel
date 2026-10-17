// وكيل — Model Gateway: one streaming interface over built-in Google Gemini
// (@google/genai), external BYO OpenAI-compatible providers, and fallback SDK.
// Server-side only.
//
// External calls are HARD-TIMEOUT-capped so a slow provider can never hang the
// agent turn: intent extraction 20s, reply streaming 60s. On timeout the
// harness falls back to its rule-based / deterministic paths.

import { GoogleGenAI } from '@google/genai'
import ZAI from 'z-ai-web-dev-sdk'
import { db } from '@/lib/db'
import { withBreaker, withRetry } from './resilience'

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface StreamChunk {
  type: 'reasoning' | 'content'
  text: string
}

export interface ModelInfo {
  key: string
  label: string
  tier: 'air' | 'balanced' | 'deep'
  source: 'builtin' | 'external'
  remoteModel?: string
  baseUrl?: string
}

export const BUILTIN_MODELS: ModelInfo[] = [
  { key: 'auto', label: 'تلقائي ذكي', tier: 'deep', source: 'builtin', remoteModel: 'gemini-3-flash-preview' },
  { key: 'gemini-flash', label: 'سريع ذكي', tier: 'balanced', source: 'builtin', remoteModel: 'gemini-3-flash-preview' },
  { key: 'gemini-pro', label: 'عميق تحليلي', tier: 'deep', source: 'builtin', remoteModel: 'gemini-3.1-pro-preview' },
  { key: 'builtin-deep', label: 'عميق مفكّر', tier: 'deep', source: 'builtin', remoteModel: 'gemini-3.1-pro-preview' },
  { key: 'builtin-air', label: 'خفيف سريع', tier: 'air', source: 'builtin', remoteModel: 'gemini-3.1-flash-lite-preview' },
]

export function geminiModelCandidates(modelKey?: string | null): string[] {
  if (modelKey === 'gemini-pro' || modelKey === 'builtin-deep') {
    return ['gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-flash']
  }
  if (modelKey === 'builtin-air') {
    return ['gemini-3.1-flash-lite-preview', 'gemini-3-flash-preview', 'gemini-2.5-flash']
  }
  return ['gemini-3-flash-preview', 'gemini-2.5-flash']
}

export function modelLabelFor(model: ModelInfo): string {
  if (model.source === 'builtin') {
    const geminiId =
      model.key === 'builtin-air'
        ? 'gemini-3.1-flash-lite'
        : model.key === 'gemini-pro' || model.key === 'builtin-deep'
          ? 'gemini-3.1-pro'
          : 'gemini-3-flash'
    return `${model.label} · ${geminiId}`
  }
  return `${model.label} · ${model.remoteModel} · مزوّد خارجي`
}

let zaiProbe: { at: number; ok: boolean } | null = null
export function zaiAvailable(): boolean {
  if (zaiProbe && Date.now() - zaiProbe.at < 60_000) return zaiProbe.ok
  const candidates = [
    `${process.cwd()}/.z-ai-config`,
    `${process.env.HOME ?? ''}/.z-ai-config`,
    `${process.env.USERPROFILE ?? ''}/.z-ai-config`,
    '/etc/.z-ai-config',
  ]
  let ok = false
  for (const path of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('node:fs') as typeof import('node:fs')
      if (path && fs.existsSync(path)) {
        ok = true
        break
      }
    } catch {
      /* keep probing */
    }
  }
  zaiProbe = { at: Date.now(), ok }
  return ok
}

export function getGeminiClient(): GoogleGenAI | null {
  if (process.env.WAKIL_OFFLINE === '1') return null
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey || !apiKey.trim()) return null
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  })
}

function splitSystemAndContents(messages: LLMMessage[]): {
  systemInstruction?: string
  contents: { role: 'user' | 'model'; parts: { text: string }[] }[]
} {
  const sysParts: string[] = []
  const contents: { role: 'user' | 'model'; parts: { text: textPart }[] }[] = []
  type textPart = string
  for (const m of messages) {
    if (m.role === 'system') {
      sysParts.push(m.content)
    } else {
      contents.push({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })
    }
  }
  if (contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: sysParts.join('\n\n') || 'مرحبا' }] })
  }
  return {
    systemInstruction: sysParts.length > 0 ? sysParts.join('\n\n') : undefined,
    contents,
  }
}

export async function resolveModel(modelKey: string | null | undefined): Promise<ModelInfo> {
  if (modelKey && modelKey.startsWith('ext:')) {
    const configId = modelKey.slice(4)
    const config = await db.modelConfig.findUnique({ where: { id: configId }, include: { provider: true } })
    if (config) {
      return {
        key: modelKey,
        label: config.label,
        tier: config.tier as 'air' | 'balanced' | 'deep',
        source: 'external',
        remoteModel: config.remoteId,
        baseUrl: config.provider.baseUrl,
      }
    }
  }

  // If built-in requested or default (auto), but GEMINI_API_KEY is not set in environment:
  // Dynamically bridge to the active remote external provider (like kiosapi) so the agent NEVER starves!
  if (!process.env.GEMINI_API_KEY) {
    const targetTier = modelKey === 'builtin-deep' || modelKey === 'gemini-pro' ? 'deep' : 'air'
    const activeExternal =
      (await db.modelConfig.findFirst({
        where: { enabled: true, tier: targetTier, provider: { baseUrl: { not: { contains: 'localhost' } } } },
        include: { provider: true },
        orderBy: { id: 'desc' },
      })) ??
      (await db.modelConfig.findFirst({
        where: { enabled: true, provider: { baseUrl: { not: { contains: 'localhost' } } } },
        include: { provider: true },
        orderBy: { id: 'desc' },
      }))
    if (activeExternal) {
      return {
        key: `ext:${activeExternal.id}`,
        label: `${activeExternal.label} (تلقائي)`,
        tier: activeExternal.tier as 'air' | 'balanced' | 'deep',
        source: 'external',
        remoteModel: activeExternal.remoteId,
        baseUrl: activeExternal.provider.baseUrl,
      }
    }
  }

  return BUILTIN_MODELS.find((m) => m.key === (modelKey ?? 'auto')) ?? BUILTIN_MODELS[0]
}

async function* streamBuiltin(messages: LLMMessage[], modelKey?: string): AsyncGenerator<StreamChunk> {
  if (process.env.WAKIL_OFFLINE === '1') {
    throw new Error('offline mode (WAKIL_OFFLINE=1) — using deterministic fallback')
  }
  const ai = getGeminiClient()
  if (ai) {
    const { systemInstruction, contents } = splitSystemAndContents(messages)
    const candidates = geminiModelCandidates(modelKey)
    for (const candidate of candidates) {
      try {
        let responseStream
        try {
          responseStream = await ai.models.generateContentStream({
            model: candidate,
            contents,
            config: {
              systemInstruction: systemInstruction ? systemInstruction : undefined,
              thinkingConfig: { includeThoughts: true },
            },
          })
        } catch {
          // If thinkingConfig is not supported for this candidate, stream without it
          responseStream = await ai.models.generateContentStream({
            model: candidate,
            contents,
            config: systemInstruction ? { systemInstruction } : undefined,
          })
        }
        let yieldedAny = false
        for await (const chunk of responseStream) {
          const parts = chunk.candidates?.[0]?.content?.parts
          if (parts && parts.length > 0) {
            for (const part of parts) {
              if (part.thought && part.text) {
                yieldedAny = true
                yield { type: 'reasoning', text: part.text }
              } else if (part.text) {
                yieldedAny = true
                yield { type: 'content', text: part.text }
              }
            }
          } else if (chunk.text) {
            yieldedAny = true
            yield { type: 'content', text: chunk.text }
          }
        }
        if (yieldedAny) return
      } catch (err) {
        console.warn(`[llm] Gemini stream candidate ${candidate} failed, trying next:`, err instanceof Error ? err.message : err)
      }
    }
  }

  // Fallback to active external provider if GEMINI_API_KEY is not present or all Gemini candidates failed
  const activeExternal = await db.modelConfig.findFirst({
    where: { enabled: true, provider: { baseUrl: { not: { contains: 'localhost' } } } },
    include: { provider: true },
    orderBy: { id: 'desc' },
  })
  if (activeExternal) {
    yield* streamExternal({
      key: `ext:${activeExternal.id}`,
      label: activeExternal.label,
      tier: activeExternal.tier as 'air' | 'balanced' | 'deep',
      source: 'external',
      remoteModel: activeExternal.remoteId,
      baseUrl: activeExternal.provider.baseUrl,
    }, messages)
    return
  }

  // Fallback to ZAI SDK if present
  const zai = await ZAI.create()
  const sdkMessages = messages.map((m) => ({
    role: m.role === 'system' ? 'assistant' : m.role,
    content: m.content,
  }))
  const stream = await zai.chat.completions.create({
    messages: sdkMessages,
    stream: true,
  } as never)
  let buffer = ''
  for await (const raw of stream as AsyncIterable<unknown>) {
    if (raw == null) continue
    if (raw instanceof Uint8Array) {
      buffer += new TextDecoder().decode(raw, { stream: true })
    } else if (typeof raw === 'string') {
      buffer += raw
    } else if (typeof raw === 'object' && 'choices' in (raw as Record<string, unknown>)) {
      const delta = (raw as { choices?: { delta?: { content?: string; reasoning_content?: string } }[] }).choices?.[0]?.delta
      if (delta?.reasoning_content) yield { type: 'reasoning', text: delta.reasoning_content }
      if (delta?.content) yield { type: 'content', text: delta.content }
      continue
    } else {
      continue
    }
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') return
      try {
        const json = JSON.parse(data) as { choices?: { delta?: { content?: string; reasoning_content?: string } }[] }
        const delta = json.choices?.[0]?.delta
        if (delta?.reasoning_content) yield { type: 'reasoning', text: delta.reasoning_content }
        if (delta?.content) yield { type: 'content', text: delta.content }
      } catch {
        // ignore malformed keepalive lines
      }
    }
  }
}

/** Hard timeout for external intent extraction (non-streaming) — 120s for deep models. */
export const INTENT_TIMEOUT_MS = 120_000
/** Hard timeout for external reply streaming — 180s. */
export const REPLY_STREAM_TIMEOUT_MS = 180_000

// ---------------------------------------------------------------------------
// R15 resilience wiring + per-turn health telemetry
// ---------------------------------------------------------------------------

/** Set by retry/fallback hooks; the harness resets + reads it per turn. */
export const llmHealth: { retried: boolean; fellBack: boolean; servedBy?: string | null } = {
  retried: false,
  fellBack: false,
  servedBy: null,
}

function breakerKeyFor(model: ModelInfo): string {
  return `${model.source === 'external' ? 'external' : 'builtin'}:${model.key}`
}

function retryHook(label: string) {
  return (attempt: number, delayMs: number, err: unknown) => {
    llmHealth.retried = true
    console.warn(`[llm] retry «${label}» محاولة ${attempt} بعد ${delayMs}ms:`, err instanceof Error ? err.message : err)
  }
}

/** A started stream: the first chunk already pulled + the live generator. */
interface StartedStream {
  gen: AsyncGenerator<StreamChunk>
  first: IteratorResult<StreamChunk>
}

async function startStream(
  gen: AsyncGenerator<StreamChunk>,
  key: string,
  label: string,
): Promise<StartedStream> {
  return withBreaker(key, () =>
    withRetry(
      async () => {
        const first = await gen.next()
        return { gen, first }
      },
      { label, onRetry: retryHook(label) },
    ),
  )
}

async function* streamExternal(model: ModelInfo, messages: LLMMessage[]): AsyncGenerator<StreamChunk> {
  const configId = model.key.slice(4)
  const config = await db.modelConfig.findUnique({ where: { id: configId }, include: { provider: true } })
  if (!config) throw new Error('الموديل الخارجي مش موجود')
  const url = `${config.provider.baseUrl.replace(/\/$/, '')}/chat/completions`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.provider.apiKey}`,
    },
    body: JSON.stringify({
      model: config.remoteId,
      messages,
      stream: true,
    }),
    signal: AbortSignal.timeout(REPLY_STREAM_TIMEOUT_MS),
  })
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '')
    throw new Error(`المزوّد الخارجي رجع ${res.status} ${detail.slice(0, 200)}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
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
      if (data === '[DONE]') return
      try {
        const json = JSON.parse(data) as {
          choices?: { delta?: { content?: string; reasoning_content?: string } }[]
        }
        const delta = json.choices?.[0]?.delta
        if (delta?.reasoning_content) yield { type: 'reasoning', text: delta.reasoning_content }
        if (delta?.content) yield { type: 'content', text: delta.content }
      } catch {
        // ignore malformed keepalive lines
      }
    }
  }
}

/** Unified streaming chat. Yields reasoning chunks first (if the model produces
 *  them), then content chunks. Falls back to built-in on external failure. */
export async function* streamChat(
  model: ModelInfo,
  messages: LLMMessage[],
): AsyncGenerator<StreamChunk> {
  if (model.source === 'external') {
    try {
      const started = await startStream(
        streamExternal(model, messages),
        breakerKeyFor(model),
        `stream:${model.key}`,
      )
      if (!started.first.done) yield started.first.value
      yield* started.gen
      return
    } catch (err) {
      console.error('[llm] external provider failed, falling back to builtin:', err)
      llmHealth.fellBack = true
      yield { type: 'reasoning', text: 'المزوّد الخارجي مش متاح حاليًا — هرجع للموديل الداخلي.' }
    }
  }
  const builtinKey = model.source === 'builtin' ? `builtin:${model.key}` : 'builtin:fallback'
  const started = await startStream(streamBuiltin(messages, model.key), builtinKey, `stream:${model.key}`)
  if (!started.first.done) yield started.first.value
  yield* started.gen
}

/** Non-streaming completion (intent extraction / research synthesis / judge) —
 *  wrapped with retry + breaker; the harness's deterministic fallbacks still
 *  catch the final throw. */
export async function completeChat(model: ModelInfo, messages: LLMMessage[]): Promise<string> {
  if (model.source === 'external') {
    try {
      return await withBreaker(breakerKeyFor(model), () =>
        withRetry(() => completeChatOnce(model, messages), {
          label: `intent:${model.key}`,
          onRetry: retryHook(`intent:${model.key}`),
        }),
      )
    } catch (err) {
      console.warn('[llm] external completeChat failed, falling back to builtin:', err)
      llmHealth.fellBack = true
      const fallbackModel = BUILTIN_MODELS[0]
      return completeChatOnce(fallbackModel, messages)
    }
  }
  return withBreaker(breakerKeyFor(model), () =>
    withRetry(() => completeChatOnce(model, messages), {
      label: `intent:${model.key}`,
      onRetry: retryHook(`intent:${model.key}`),
    }),
  )
}

async function completeChatOnce(model: ModelInfo, messages: LLMMessage[]): Promise<string> {
  if (process.env.WAKIL_OFFLINE === '1') {
    throw new Error('offline mode (WAKIL_OFFLINE=1) — using deterministic fallback')
  }
  if (model.source === 'builtin') {
    const ai = getGeminiClient()
    if (ai) {
      const { systemInstruction, contents } = splitSystemAndContents(messages)
      const candidates = geminiModelCandidates(model.key)
      let lastGeminiErr: unknown = null
      for (const candidate of candidates) {
        try {
          let response
          try {
            response = await ai.models.generateContent({
              model: candidate,
              contents,
              config: {
                systemInstruction: systemInstruction ? systemInstruction : undefined,
                thinkingConfig: { includeThoughts: true },
              },
            })
          } catch {
            response = await ai.models.generateContent({
              model: candidate,
              contents,
              config: systemInstruction ? { systemInstruction } : undefined,
            })
          }
          const text = response.text ?? ''
          if (text.trim()) return text
        } catch (err) {
          lastGeminiErr = err
          console.warn(`[llm] Gemini completeChat candidate ${candidate} failed, trying next:`, err instanceof Error ? err.message : err)
        }
      }
      // If ZAI fallback is available, try it before throwing lastGeminiErr
      try {
        const zai = await ZAI.create()
        const sdkMessages = messages.map((m) => ({
          role: m.role === 'system' ? 'assistant' : m.role,
          content: m.content,
        }))
        const completion = await zai.chat.completions.create({
          messages: sdkMessages,
          thinking: { type: 'disabled' },
        } as never)
        const content = (completion as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content
        if (content?.trim()) return content
      } catch {
        // ignore ZAI error and rethrow Gemini error if any
      }
      if (lastGeminiErr) throw lastGeminiErr
      return ''
    }

    const activeExternal = await db.modelConfig.findFirst({
      where: { enabled: true, provider: { baseUrl: { not: { contains: 'localhost' } } } },
      include: { provider: true },
      orderBy: { id: 'desc' },
    })
    if (activeExternal) {
      return completeChatOnce(
        {
          key: `ext:${activeExternal.id}`,
          label: activeExternal.label,
          tier: activeExternal.tier as 'air' | 'balanced' | 'deep',
          source: 'external',
          remoteModel: activeExternal.remoteId,
          baseUrl: activeExternal.provider.baseUrl,
        },
        messages,
      )
    }

    const zai = await ZAI.create()
    const sdkMessages = messages.map((m) => ({
      role: m.role === 'system' ? 'assistant' : m.role,
      content: m.content,
    }))
    const completion = await zai.chat.completions.create({
      messages: sdkMessages,
      thinking: { type: 'disabled' },
    } as never)
    const content = (completion as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content
    return content ?? ''
  }
  const configId = model.key.slice(4)
  const config = await db.modelConfig.findUnique({ where: { id: configId }, include: { provider: true } })
  if (!config) throw new Error('الموديل الخارجي مش موجود')
  const url = `${config.provider.baseUrl.replace(/\/$/, '')}/chat/completions`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.provider.apiKey}` },
    body: JSON.stringify({ model: config.remoteId, messages, stream: false }),
    signal: AbortSignal.timeout(INTENT_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`المزوّد رجع ${res.status}`)
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  return json.choices?.[0]?.message?.content ?? ''
}
