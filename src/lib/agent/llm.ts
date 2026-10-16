// وكيل — Model Gateway: one streaming interface over built-in (z-ai SDK) and
// external BYO OpenAI-compatible providers. Server-side only.
//
// External calls are HARD-TIMEOUT-capped so a slow provider can never hang the
// agent turn: intent extraction 20s, reply streaming 60s. On timeout the
// harness falls back to its rule-based / deterministic paths.

import ZAI from 'z-ai-web-dev-sdk'
import { db } from '@/lib/db'

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
  { key: 'builtin-deep', label: 'عميق مفكّر', tier: 'deep', source: 'builtin' },
  { key: 'builtin-air', label: 'خفيف سريع', tier: 'air', source: 'builtin' },
]

export function modelLabelFor(model: ModelInfo): string {
  if (model.source === 'builtin') {
    // air is glm-4.5-air — labeling it glm-4.6 (the deep model) confuses owners
    // comparing the chat badge against the picker sub-label.
    return `${model.label} · ${model.key === 'builtin-air' ? 'glm-4.5-air' : 'glm-4.6'}`
  }
  return `${model.label} · ${model.remoteModel} · مزوّد خارجي`
}

/** Resolve a modelKey ('builtin-deep' | 'builtin-air' | 'ext:<modelConfigId>') into full model info. */
export async function resolveModel(modelKey: string | null | undefined): Promise<ModelInfo> {
  if (!modelKey || modelKey === 'builtin-deep' || modelKey === 'builtin-air') {
    return BUILTIN_MODELS.find((m) => m.key === (modelKey ?? 'builtin-deep')) ?? BUILTIN_MODELS[0]
  }
  if (modelKey.startsWith('ext:')) {
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
  return BUILTIN_MODELS[0]
}

async function* streamBuiltin(messages: LLMMessage[]): AsyncGenerator<StreamChunk> {
  const zai = await ZAI.create()
  // SDK convention: system prompt goes as 'assistant' role lead message.
  // NOTE: the API rejects a lone assistant message (code 1214) — callers must
  // always include a trailing user turn.
  const sdkMessages = messages.map((m) => ({
    role: m.role === 'system' ? 'assistant' : m.role,
    content: m.content,
  }))
  const stream = await zai.chat.completions.create({
    messages: sdkMessages,
    stream: true,
  } as never)
  // The SDK hands us the raw SSE body as Uint8Array/string pieces (not parsed
  // chunk objects) — parse the `data:` lines ourselves, tolerating both shapes.
  let buffer = ''
  for await (const raw of stream as AsyncIterable<unknown>) {
    if (raw == null) continue
    if (raw instanceof Uint8Array) {
      buffer += new TextDecoder().decode(raw, { stream: true })
    } else if (typeof raw === 'string') {
      buffer += raw
    } else if (typeof raw === 'object' && 'choices' in (raw as Record<string, unknown>)) {
      const delta = (raw as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta
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
        const json = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] }
        const text = json.choices?.[0]?.delta?.content
        if (text) yield { type: 'content', text }
      } catch {
        // ignore malformed keepalive lines
      }
    }
  }
}

/** Hard timeout for external intent extraction (non-streaming) — 20s. */
export const INTENT_TIMEOUT_MS = 20_000
/** Hard timeout for external reply streaming — 60s. */
export const REPLY_STREAM_TIMEOUT_MS = 60_000

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
      yield* streamExternal(model, messages)
      return
    } catch (err) {
      console.error('[llm] external provider failed, falling back to builtin:', err)
      yield { type: 'reasoning', text: 'المزوّد الخارجي مش متاح حاليًا — هرجع للموديل الداخلي.' }
      yield* streamBuiltin(messages)
      return
    }
  }
  yield* streamBuiltin(messages)
}

/** Non-streaming completion (used for intent extraction pass). */
export async function completeChat(model: ModelInfo, messages: LLMMessage[]): Promise<string> {
  if (model.source === 'builtin') {
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
