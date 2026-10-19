import { recordInference, strictInference } from './inference-audit'
import { llmHealth } from './model-health'
export { llmHealth } from './model-health'
import { withModelBudget, withStreamBudget, type ModelBudget } from './model-budget'
import { providerFetch } from '@/lib/security/provider-network'
import { decryptProviderKey } from '@/lib/security/provider-secrets'
// وكيل — Model Gateway: one streaming interface over built-in Google Gemini
// (@google/genai), external BYO OpenAI-compatible providers, and fallback SDK.
// Server-side only.
//
// Completion budgets span retries/candidates/fallback (12/20/30s by tier);
// streaming has a 60s whole-stream budget. On timeout the
// harness falls back to its rule-based / deterministic paths.

import { GoogleGenAI } from '@google/genai'
import ZAI from 'z-ai-web-dev-sdk'
import { db } from '@/lib/db'
import { withBreaker, withRetry } from './resilience'
import type { BrainToolSchema } from './tool-schemas'

export interface CompleteChatOptions {
  /** Native tool-calling schemas (OpenAI-compatible). Only the BRAIN pass
   *  sends these; providers that reject the field self-heal to the
   *  JSON-in-text emulation protocol (see toolsSupportCache). */
  tools?: BrainToolSchema[]
}

/** Per-provider runtime memory of native tool-calling support. A provider
 *  that 400s on the `tools` field is retried without it and remembered. */
const toolsSupportCache = new Map<string, boolean>()
export function toolSupportKnown(providerKey: string): boolean | undefined {
  return toolsSupportCache.get(providerKey)
}
function rememberToolSupport(providerKey: string, ok: boolean): void {
  toolsSupportCache.set(providerKey, ok)
}

/** Native OpenAI tool_calls → the canonical text contract the brain loop
 *  already parses (`parseBrainReply`): `{"tool_calls":[{"tool","args"}]}`. */
export function normalizeNativeToolCalls(
  toolCalls: { function?: { name?: string; arguments?: string } }[] | undefined | null,
): string | null {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return null
  const calls: { tool: string; args: Record<string, unknown> }[] = []
  for (const tc of toolCalls) {
    const name = tc?.function?.name
    if (!name) continue
    let args: Record<string, unknown> = {}
    const rawArgs = tc.function?.arguments
    if (rawArgs) {
      try {
        const parsed = JSON.parse(rawArgs) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>
      } catch {
        args = { _raw: rawArgs }
      }
    }
    calls.push({ tool: name, args })
  }
  return calls.length > 0 ? JSON.stringify({ tool_calls: calls }) : null
}

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
    if (config?.enabled) {
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
  // Dynamically bridge to an active provider so the agent NEVER starves.
  // Dev order: the LOCAL demo provider first (the preview must answer even when
  // no external network is reachable), then external providers. Production
  // keeps the external-only bridge (loopback is not a provider in prod).
  if (!process.env.GEMINI_API_KEY) {
    const isDev = process.env.NODE_ENV !== 'production'
    const targetTier = modelKey === 'builtin-deep' || modelKey === 'gemini-pro' ? 'deep' : 'air'
    // Loopback demo providers register with a port+path («http://localhost:3031/v1»)
    // — exact-match lists never hit them, so the bridge silently fell through to
    // a real external provider the sandbox cannot reach. Match by containment.
    const localCandidate = isDev
      ? await db.modelConfig.findFirst({
          where: {
            enabled: true,
            tier: targetTier,
            OR: [
              { provider: { baseUrl: { contains: 'localhost' } } },
              { provider: { baseUrl: { contains: '127.0.0.1' } } },
            ],
          },
          include: { provider: true },
          orderBy: { id: 'desc' },
        })
      : null
    const externalWhere = {
      enabled: true,
      AND: [
        { provider: { baseUrl: { not: { contains: 'localhost' } } } },
        { provider: { baseUrl: { not: { contains: '127.0.0.1' } } } },
      ],
    }
    const activeExternal =
      (await db.modelConfig.findFirst({
        where: { ...externalWhere, tier: targetTier },
        include: { provider: true },
        orderBy: { id: 'desc' },
      })) ??
      (await db.modelConfig.findFirst({
        where: externalWhere,
        include: { provider: true },
        orderBy: { id: 'desc' },
      }))
    const chosen = localCandidate ?? activeExternal
    if (chosen) {
      return {
        key: `ext:${chosen.id}`,
        label: `${chosen.label} (تلقائي)`,
        tier: chosen.tier as 'air' | 'balanced' | 'deep',
        source: 'external',
        remoteModel: chosen.remoteId,
        baseUrl: chosen.provider.baseUrl,
      }
    }
  }

  return BUILTIN_MODELS.find((m) => m.key === (modelKey ?? 'auto')) ?? BUILTIN_MODELS[0]
}

async function* streamBuiltin(messages: LLMMessage[], modelKey: string | undefined, budget: ModelBudget): AsyncGenerator<StreamChunk> {
  if (process.env.WAKIL_OFFLINE === '1') {
    throw new Error('offline mode (WAKIL_OFFLINE=1) — using deterministic fallback')
  }
  const ai = getGeminiClient()
  if (ai) {
    const { systemInstruction, contents } = splitSystemAndContents(messages)
    const candidates = geminiModelCandidates(modelKey)
    for (const candidate of candidates) {
      budget.remainingMs()
      let emittedContent = false
      try {
        let responseStream
        try {
          responseStream = await ai.models.generateContentStream({
            model: candidate,
            contents,
            config: {
              systemInstruction: systemInstruction ? systemInstruction : undefined,
              abortSignal: budget.signal,
              httpOptions: { timeout: budget.remainingMs() },
              thinkingConfig: { includeThoughts: true },
            },
          })
        } catch {
          // If thinkingConfig is not supported for this candidate, stream without it
          responseStream = await ai.models.generateContentStream({
            model: candidate,
            contents,
            config: { systemInstruction, abortSignal: budget.signal, httpOptions: { timeout: budget.remainingMs() } },
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
                emittedContent = true
                llmHealth.servedBy = `Gemini · ${candidate}`
                yieldedAny = true
                yield { type: 'content', text: part.text }
              }
            }
          } else if (chunk.text) {
            emittedContent = true
                llmHealth.servedBy = `Gemini · ${candidate}`
            yieldedAny = true
            yield { type: 'content', text: chunk.text }
          }
        }
        if (yieldedAny) return
      } catch (err) {
        if (emittedContent) throw err // Never splice another model into a partial answer.
        console.warn(`[llm] Gemini stream candidate ${candidate} failed, trying next:`, err instanceof Error ? err.message : err)
      }
    }
  }

  // Fallback to active external provider if GEMINI_API_KEY is not present or all Gemini candidates failed.
  // Dev prefers the local demo provider (same rule as the resolveModel bridge) so the
  // preview never bridges to an external the sandbox cannot reach.
  const isDev = process.env.NODE_ENV !== 'production'
  const localFallback = isDev
    ? await db.modelConfig.findFirst({
        where: {
          enabled: true,
          OR: [
            { provider: { baseUrl: { contains: 'localhost' } } },
            { provider: { baseUrl: { contains: '127.0.0.1' } } },
          ],
        },
        include: { provider: true },
        orderBy: { id: 'desc' },
      })
    : null
  const activeExternal =
    localFallback ??
    (await db.modelConfig.findFirst({
      where: {
        enabled: true,
        AND: [
          { provider: { baseUrl: { not: { contains: 'localhost' } } } },
          { provider: { baseUrl: { not: { contains: '127.0.0.1' } } } },
        ],
      },
      include: { provider: true },
      orderBy: { id: 'desc' },
    }))
  if (activeExternal) {
    yield* streamExternal({
      key: `ext:${activeExternal.id}`,
      label: activeExternal.label,
      tier: activeExternal.tier as 'air' | 'balanced' | 'deep',
      source: 'external',
      remoteModel: activeExternal.remoteId,
      baseUrl: activeExternal.provider.baseUrl,
    }, messages, budget)
    return
  }

  // Fallback to ZAI SDK if present
  budget.remainingMs()
  const zai = await ZAI.create()
  const sdkMessages = messages.map((m) => ({
    role: m.role,
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
      if (delta?.content) { llmHealth.servedBy = 'المحرك الاحتياطي · SDK'; yield { type: 'content', text: delta.content } }
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
        if (delta?.content) { llmHealth.servedBy = 'المحرك الاحتياطي · SDK'; yield { type: 'content', text: delta.content } }
      } catch {
        // ignore malformed keepalive lines
      }
    }
  }
}

/** Hard timeout for external reply streaming — 60s. */
// 60s in production — nobody waits longer for a reply. In test, the full
// suite runs in parallel (CPU contention) and local mock providers get
// starved; the guard stays but with headroom so the gate is deterministic.
export const REPLY_STREAM_TIMEOUT_MS = process.env.NODE_ENV === 'test' ? 180_000 : 60_000

// ---------------------------------------------------------------------------
// R15 resilience wiring + per-turn health telemetry
// ---------------------------------------------------------------------------

/** Set by retry/fallback hooks; the harness resets + reads it per turn. */

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
  create: () => AsyncGenerator<StreamChunk>,
  key: string,
  label: string,
): Promise<StartedStream> {
  return withBreaker(key, () =>
    withRetry(
      async () => {
        const gen = create()
        try {
          const first = await gen.next()
          return { gen, first }
        } catch (error) {
          void gen.return(undefined).catch(() => {})
          throw error
        }
      },
      { label, onRetry: retryHook(label) },
    ),
  )
}

async function* streamExternal(model: ModelInfo, messages: LLMMessage[], budget: ModelBudget): AsyncGenerator<StreamChunk> {
  budget.remainingMs()
  const configId = model.key.slice(4)
  const config = await db.modelConfig.findUnique({ where: { id: configId }, include: { provider: true } })
  if (!config?.enabled) throw new Error('الموديل الخارجي غير متاح')
  budget.remainingMs()
  const url = `${config.provider.baseUrl.replace(/\/$/, '')}/chat/completions`
  const res = await providerFetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${decryptProviderKey(config.provider.apiKey)}`,
    },
    body: JSON.stringify({
      model: config.remoteId,
      messages,
      stream: true,
    }),
    signal: budget.signal,
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
        if (delta?.content) { llmHealth.servedBy = modelLabelFor(model); yield { type: 'content', text: delta.content } }
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
  yield* withStreamBudget(REPLY_STREAM_TIMEOUT_MS, (budget) => streamWithBudget(model, messages, budget))
}
async function* streamWithBudget(model: ModelInfo, messages: LLMMessage[], budget: ModelBudget): AsyncGenerator<StreamChunk> {
  let emittedContent = false
  if (model.source === 'external') {
    try {
      const started = await startStream(
        () => streamExternal(model, messages, budget),
        breakerKeyFor(model),
        `stream:${model.key}`,
      )
      if (!started.first.done) { emittedContent = started.first.value.type === 'content'; yield started.first.value }
      for await (const chunk of started.gen) {
        if (chunk.type === 'content') emittedContent = true
        yield chunk
      }
      return
    } catch (err) {
      if (emittedContent || strictInference()) throw err
      console.error('[llm] external provider failed — trying fallback providers:', err)
      llmHealth.fellBack = true
      let rescued = false
      for (const alt of await externalAlternatives(model)) {
        try {
          const started = await startStream(() => streamExternal(alt, messages, budget), `stream:${alt.key}`, `stream-fallback:${alt.key}`)
          rescued = true
          if (!started.first.done) yield started.first.value
          yield* started.gen
          break
        } catch {
          // keep climbing the ladder
        }
      }
      if (!rescued) {
        yield { type: 'reasoning', text: 'المزوّد الخارجي مش متاح حاليًا — هرجع للموديل الداخلي.' }
      }
    }
  }
  const builtinKey = model.source === 'builtin' ? `builtin:${model.key}` : 'builtin:fallback'
  const started = await startStream(() => streamBuiltin(messages, model.key, budget), builtinKey, `stream:${model.key}`)
  if (!started.first.done) yield started.first.value
  yield* started.gen
}

/** DeepSeek-harness «pinned fallback provider» pattern: when the SELECTED
 *  external provider fails, do not dead-end into a builtin the sandbox may
 *  not have — try the other enabled external providers (same tier first),
 *  max two, then give up to the normal fallback. */
async function externalAlternatives(model: ModelInfo): Promise<ModelInfo[]> {
  if (model.source !== 'external') return []
  const out: ModelInfo[] = []
  try {
    const configs = await db.modelConfig.findMany({
      where: { enabled: true },
      include: { provider: true },
      orderBy: { id: 'desc' },
      take: 8,
    })
    const ranked = [...configs].sort(
      (a, b) => Number(b.tier === model.tier) - Number(a.tier === model.tier),
    )
    for (const c of ranked) {
      if (`ext:${c.id}` === model.key) continue
      out.push({
        key: `ext:${c.id}`,
        label: c.label,
        tier: c.tier as 'air' | 'balanced' | 'deep',
        source: 'external',
        remoteModel: c.remoteId,
        baseUrl: c.provider.baseUrl,
      })
      if (out.length >= 2) break
    }
  } catch {
    return []
  }
  return out
}

/** Non-streaming completion (intent extraction / research synthesis / judge) —
 *  wrapped with retry + breaker; the harness's deterministic fallbacks still
 *  catch the final throw. */
export async function completeChat(model: ModelInfo, messages: LLMMessage[], opts?: CompleteChatOptions): Promise<string> {
  const ms = model.tier === 'air' ? 12_000 : model.tier === 'deep' ? 30_000 : 20_000
  const content = await withModelBudget(ms, (budget) => strictInference() ? completeChatOnce(model, messages, budget, opts) : completeWithBudget(model, messages, budget, opts))
  if (strictInference() && !content.trim()) throw new Error('Live model returned no content')
  recordInference(messages, content, llmHealth.servedBy ?? 'unknown')
  return content
}
async function completeWithBudget(model: ModelInfo, messages: LLMMessage[], budget: ModelBudget, opts?: CompleteChatOptions): Promise<string> {
  if (model.source === 'external') {
    try {
      return await withBreaker(breakerKeyFor(model), () =>
        withRetry(() => completeChatOnce(model, messages, budget, opts), {
          label: `intent:${model.key}`,
          onRetry: retryHook(`intent:${model.key}`),
        }),
      )
    } catch (err) {
      console.warn('[llm] external completeChat failed — trying fallback providers:', err)
      llmHealth.fellBack = true
      for (const alt of await externalAlternatives(model)) {
        try {
          const out = await completeChatOnce(alt, messages, budget, opts)
          if (out.trim()) return out
        } catch {
          // keep climbing the ladder
        }
      }
      const fallbackModel = BUILTIN_MODELS[0]
      return completeChatOnce(fallbackModel, messages, budget, opts)
    }
  }
  return withBreaker(breakerKeyFor(model), () =>
    withRetry(() => completeChatOnce(model, messages, budget, opts), {
      label: `intent:${model.key}`,
      onRetry: retryHook(`intent:${model.key}`),
    }),
  )
}

async function completeChatOnce(model: ModelInfo, messages: LLMMessage[], budget: ModelBudget, opts?: CompleteChatOptions): Promise<string> {
  budget.remainingMs()
  if (process.env.WAKIL_OFFLINE === '1') {
    throw new Error('offline mode (WAKIL_OFFLINE=1) — using deterministic fallback')
  }
  if (model.source === 'builtin') {
    const ai = getGeminiClient()
    if (ai) {
      const { systemInstruction, contents } = splitSystemAndContents(messages)
      const candidates = strictInference() ? geminiModelCandidates(model.key).slice(0, 1) : geminiModelCandidates(model.key)
      let lastGeminiErr: unknown = null
      for (const candidate of candidates) {
        budget.remainingMs()
        try {
          let response
          try {
            response = await ai.models.generateContent({
              model: candidate,
              contents,
              config: {
                systemInstruction: systemInstruction ? systemInstruction : undefined,
                abortSignal: budget.signal,
                httpOptions: { timeout: budget.remainingMs() },
                thinkingConfig: { includeThoughts: true },
              },
            })
          } catch {
            response = await ai.models.generateContent({
              model: candidate,
              contents,
              config: { systemInstruction, abortSignal: budget.signal, httpOptions: { timeout: budget.remainingMs() } },
            })
          }
          const text = response.text ?? ''
          if (text.trim()) { llmHealth.servedBy = `Gemini · ${candidate}`; return text }
        } catch (err) {
          lastGeminiErr = err
          console.warn(`[llm] Gemini completeChat candidate ${candidate} failed, trying next:`, err instanceof Error ? err.message : err)
        }
      }
      if (strictInference()) throw lastGeminiErr ?? new Error('Live Gemini returned no content')
      // If ZAI fallback is available, try it before throwing lastGeminiErr
      try {
        budget.remainingMs()
        const zai = await ZAI.create()
        const sdkMessages = messages.map((m) => ({
          role: m.role,
          content: m.content,
        }))
        const completion = await zai.chat.completions.create({
          messages: sdkMessages,
          thinking: { type: 'disabled' },
        } as never)
        const content = (completion as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content
        if (content?.trim()) { llmHealth.servedBy = 'المحرك الاحتياطي · SDK'; return content }
      } catch {
        // ignore ZAI error and rethrow Gemini error if any
      }
      if (lastGeminiErr) throw lastGeminiErr
      return ''
    }

    if (strictInference()) throw new Error('Live Gemini is not configured')
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
        budget,
      )
    }

    budget.remainingMs()
    const zai = await ZAI.create()
    const sdkMessages = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }))
    const completion = await zai.chat.completions.create({
      messages: sdkMessages,
      thinking: { type: 'disabled' },
    } as never)
    const content = (completion as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content
    if (content?.trim()) llmHealth.servedBy = 'المحرك الاحتياطي · SDK'
    return content ?? ''
  }
  const configId = model.key.slice(4)
  const config = await db.modelConfig.findUnique({ where: { id: configId }, include: { provider: true } })
  if (!config?.enabled) throw new Error('الموديل الخارجي غير متاح')
  budget.remainingMs()
  const url = `${config.provider.baseUrl.replace(/\/$/, '')}/chat/completions`
  // Native tool calling: send the schema array when requested AND the
  // provider has not previously rejected the field (self-heal ladder).
  const wantTools = (opts?.tools?.length ?? 0) > 0 && toolsSupportCache.get(configId) !== false
  const attempt = (withTools: boolean) =>
    providerFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${decryptProviderKey(config.provider.apiKey)}` },
      body: JSON.stringify({
        model: config.remoteId,
        messages,
        stream: false,
        ...(withTools ? { tools: opts?.tools } : {}),
      }),
      signal: budget.signal,
    })
  let res = await attempt(wantTools)
  let finalWithTools = wantTools
  if (!res.ok && wantTools) {
    const detail = (await res.text().catch(() => '')).slice(0, 300)
    // Provider refuses the tools field → remember it, retry WITHOUT tools
    // (the JSON-in-text emulation protocol keeps the brain working).
    if (/tool|function|schema|unknown parameter|invalid request/i.test(detail)) {
      rememberToolSupport(configId, false)
      finalWithTools = false
      budget.remainingMs()
      res = await attempt(false)
    }
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`المزوّد رجع ${res.status} ${detail.slice(0, 200)}`)
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string; tool_calls?: { id?: string; type?: string; function?: { name?: string; arguments?: string } }[] } }[]
  }
  const message = json.choices?.[0]?.message
  if (finalWithTools) rememberToolSupport(configId, true)
  const native = normalizeNativeToolCalls(message?.tool_calls)
  if (native) {
    llmHealth.servedBy = `${config.label} · ${config.remoteId} · مزوّد خارجي (tool-calling أصلي)`
    return native
  }
  const content = message?.content ?? ''
  if (content.trim()) llmHealth.servedBy = `${config.label} · ${config.remoteId} · مزوّد خارجي`
  return content
}
