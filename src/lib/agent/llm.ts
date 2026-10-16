// وكيل — Model Gateway: one streaming interface over built-in (z-ai SDK) and
// external BYO OpenAI-compatible providers. Server-side only.
//
// External calls are HARD-TIMEOUT-capped so a slow provider can never hang the
// agent turn: intent extraction 20s, reply streaming 60s. On timeout the
// harness falls back to its rule-based / deterministic paths.
//
// R15 resilience: every real LLM invocation is wrapped with
// withBreaker(`${provider}:${model}`) + withRetry (graduated 0/800/2500ms
// ladder). For streams the CONNECTION phase (first chunk) is what gets
// retried — once bytes flow, the stream continues live; mid-stream failures
// keep the pre-existing fallback paths. `llmHealth` feeds per-turn telemetry
// (fallback=true on the UsageEvent whenever a retry or fallback fired).

import ZAI from 'z-ai-web-dev-sdk'
import { db } from '@/lib/db'
import { breakerIsOpen, withBreaker, withRetry } from './resilience'

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

/**
 * Offline / deterministic mode (WAKIL_OFFLINE=1).
 *
 * Some deployments have no LLM reachable at all — an air-gapped shop, a smoke
 * test, the golden-dataset eval suite, CI. In that mode every model call fails
 * IMMEDIATELY (no retry ladder, no timeouts) so the harness drops straight to
 * its deterministic Arabic ladder instead of stalling for seconds per pass.
 */
export function isOfflineMode(): boolean {
  const flag = process.env.WAKIL_OFFLINE?.trim().toLowerCase()
  return flag === '1' || flag === 'true' || flag === 'on'
}

const OFFLINE_ERROR = 'وضع الأوفلاين مفعّل (WAKIL_OFFLINE=1) — الموديلات متعطلة عن قصد'

export const BUILTIN_MODELS: ModelInfo[] = [
  { key: 'builtin-deep', label: 'عميق مفكّر', tier: 'deep', source: 'builtin' },
  { key: 'builtin-air', label: 'خفيف سريع', tier: 'air', source: 'builtin' },
]

/**
 * Is the built-in gateway usable AT ALL?
 *
 * The built-in source is `z-ai-web-dev-sdk`, which needs a `.z-ai-config` file
 * (project / home / etc). In a fresh checkout, a container or an air-gapped
 * install there is none — and then EVERY default turn paid for it: an exception
 * per call, a `retry` log line per attempt, a scary «فشل «عميق مفكّر»» notice in
 * the UI and a ladder hop that only existed to discover a missing file. The
 * answer is a 1-line fs probe, cached for a minute, so the ladder can leave the
 * built-in source out entirely instead of failing into it.
 */
let zaiProbe: { at: number; ok: boolean } | null = null
export function zaiAvailable(): boolean {
  if (zaiProbe && Date.now() - zaiProbe.at < 60_000) return zaiProbe.ok
  const candidates = [
    `${process.cwd()}/.z-ai-config`,
    `${process.env.HOME ?? ''}/.z-ai-config`,
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
      /* keep probing the rest */
    }
  }
  zaiProbe = { at: Date.now(), ok }
  return ok
}

export function modelLabelFor(model: ModelInfo): string {
  if (model.source === 'builtin') {
    // air is glm-4.5-air — labeling it glm-4.6 (the deep model) confuses owners
    // comparing the chat badge against the picker sub-label.
    return `${model.label} · ${model.key === 'builtin-air' ? 'glm-4.5-air' : 'glm-4.6'}`
  }
  return `${model.label} · ${model.remoteModel} · مزوّد خارجي`
}

/** Resolve a modelKey ('builtin-deep' | 'builtin-air' | 'ext:<modelConfigId>') into full model info. */
/**
 * Resolve the model for a turn.
 *
 * `null` used to mean «builtin-deep» — the z-ai gateway. In this sandbox that is
 * the one source that CANNOT work (no `.z-ai-config`), so every default turn
 * opened with a failure notice and a ladder hop before the real answer started.
 * With no explicit choice we now prefer the best enabled **external** model whose
 * provider is not circuit-broken, and only fall back to the built-in when the
 * gateway is actually configured (or no provider exists at all).
 */
export async function resolveModel(modelKey: string | null | undefined): Promise<ModelInfo> {
  if (!modelKey) {
    const externals = await externalModels()
    const healthy = externals.find((m) => !breakerIsOpen(breakerKeyFor(m)))
    if (healthy) return healthy
    if (!zaiAvailable() && externals.length > 0) return externals[0]
    return BUILTIN_MODELS.find((m) => m.key === 'builtin-deep') ?? BUILTIN_MODELS[0]
  }
  if (modelKey === 'builtin-deep' || modelKey === 'builtin-air') {
    const builtin = BUILTIN_MODELS.find((m) => m.key === modelKey) ?? BUILTIN_MODELS[0]
    // The UI can still ask for the built-in explicitly; if it is not configured
    // we serve the request from a reachable provider instead of failing.
    if (!zaiAvailable()) {
      const externals = await externalModels()
      const healthy = externals.find((m) => !breakerIsOpen(breakerKeyFor(m)))
      if (healthy) return healthy
    }
    return builtin
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

// ---------------------------------------------------------------------------
// R15 resilience wiring + per-turn health telemetry
// ---------------------------------------------------------------------------

/** Set by retry/fallback hooks; the harness resets + reads it per turn. */
export const llmHealth = {
  retried: false,
  fellBack: false,
  /** Label of the model that ACTUALLY answered, when the ladder had to switch. */
  servedBy: null as string | null,
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

/**
 * Start an async generator under retry+breaker: the connection phase (fetch /
 * SDK create / first chunk) is where 429-5xx-ECONNRESET live — retry THAT,
 * then continue streaming live. `start()` itself never yields.
 */
async function startStream(
  gen: AsyncGenerator<StreamChunk>,
  key: string,
  label: string,
): Promise<StartedStream> {
  return withBreaker(key, () =>
    withRetry(
      async () => {
        const first = await gen.next() // connection errors throw HERE
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

// ---------------------------------------------------------------------------
// FALLBACK LADDER — «لو موديل وقع، الشغل مايقفش»
// ---------------------------------------------------------------------------
// Before this, a dead model meant a dead turn: the requested source was tried
// and the harness dropped straight to the rule ladder, so a shop with a working
// BYO provider still got «الموديل مش متاح» whenever the built-in gateway was
// unreachable (no key, no network, provider outage). Now every model call walks
// an ordered ladder — requested model first, then the closest-tier ENABLED model
// from the other source — and announces the switch to the user instead of
// silently degrading. Bounded to MAX_MODEL_ATTEMPTS so latency stays sane.

const MAX_MODEL_ATTEMPTS = 3
const LADDER_TTL_MS = 30_000
let ladderCache: { at: number; models: ModelInfo[] } | null = null

function tierRank(tier: string): number {
  return tier === 'deep' ? 0 : tier === 'balanced' ? 1 : 2
}

/** Enabled BYO models, cached briefly (they change only from the UI). */
async function externalModels(): Promise<ModelInfo[]> {
  if (ladderCache && Date.now() - ladderCache.at < LADDER_TTL_MS) return ladderCache.models
  try {
    const configs = await db.modelConfig.findMany({
      where: { enabled: true },
      include: { provider: true, capabilities: true },
      orderBy: { id: 'asc' },
    })
    const models: ModelInfo[] = configs.map((c) => ({
      key: `ext:${c.id}`,
      label: c.label,
      tier: (c.tier as 'air' | 'balanced' | 'deep') ?? 'balanced',
      source: 'external' as const,
      remoteModel: c.remoteId,
      baseUrl: c.provider.baseUrl,
    }))
    // Models that PROBED ok come first — a known-dead provider is tried last.
    const probed = new Map(configs.map((c) => [`ext:${c.id}`, c.capabilities?.ok === true]))
    models.sort((a, b) => Number(probed.get(b.key) ?? false) - Number(probed.get(a.key) ?? false))
    ladderCache = { at: Date.now(), models }
    return models
  } catch {
    return []
  }
}

/** Ordered alternatives to `model`: same tier first, opposite source next. */
export async function fallbackLadder(model: ModelInfo): Promise<ModelInfo[]> {
  const externals = (await externalModels()).filter((m) => m.key !== model.key)
  // A built-in gateway with no config file is not a fallback, it is a detour:
  // drop it from the ladder (the turn then falls to the next provider or the
  // deterministic engine in milliseconds instead of after an exception).
  const builtins = zaiAvailable() ? BUILTIN_MODELS.filter((m) => m.key !== model.key) : []
  const wanted = tierRank(model.tier)
  const byTier = (a: ModelInfo, b: ModelInfo) => Math.abs(tierRank(a.tier) - wanted) - Math.abs(tierRank(b.tier) - wanted)
  const primary = model.source === 'builtin' ? externals : builtins
  const secondary = model.source === 'builtin' ? builtins : externals
  return [...primary.sort(byTier), ...secondary.sort(byTier)]
}

/** Unified streaming chat. Yields reasoning chunks first (if the model produces
 *  them), then content chunks — walking the fallback ladder on failure. */
export async function* streamChat(
  model: ModelInfo,
  messages: LLMMessage[],
): AsyncGenerator<StreamChunk> {
  if (isOfflineMode()) throw new Error(OFFLINE_ERROR)
  const ladder = [model, ...(await fallbackLadder(model))].slice(0, MAX_MODEL_ATTEMPTS)
  let lastError: unknown = null
  for (let attempt = 0; attempt < ladder.length; attempt++) {
    const candidate = ladder[attempt]
    try {
      const started = await startStream(
        candidate.source === 'external' ? streamExternal(candidate, messages) : streamBuiltin(messages),
        breakerKeyFor(candidate),
        `stream:${candidate.key}`,
      )
      if (attempt > 0) {
        llmHealth.fellBack = true
        llmHealth.servedBy = candidate.label
        console.warn(`[llm] «${model.label}» وقع — بكمّل بـ«${candidate.label}»`)
        // Honest to the owner: the model changed mid-conversation.
        yield { type: 'reasoning', text: `«${model.label}» مش راد دلوقتي — بكمّل بـ«${candidate.label}».` }
      }
      if (!started.first.done) yield started.first.value
      yield* started.gen
      return
    } catch (err) {
      lastError = err
      console.error(`[llm] فشل «${candidate.label}»:`, err instanceof Error ? err.message : err)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('مفيش موديل متاح دلوقتي')
}

/** Non-streaming completion (intent extraction / research synthesis / judge) —
 *  wrapped with retry + breaker; the harness's deterministic fallbacks still
 *  catch the final throw. */
export async function completeChat(model: ModelInfo, messages: LLMMessage[]): Promise<string> {
  // Checked BEFORE the retry/breaker wrappers: offline must be instant.
  if (isOfflineMode()) throw new Error(OFFLINE_ERROR)
  const ladder = [model, ...(await fallbackLadder(model))].slice(0, MAX_MODEL_ATTEMPTS)
  let lastError: unknown = null
  for (const candidate of ladder) {
    try {
      const text = await withBreaker(breakerKeyFor(candidate), () =>
        withRetry(() => completeChatOnce(candidate, messages), {
          label: `intent:${candidate.key}`,
          onRetry: retryHook(`intent:${candidate.key}`),
        }),
      )
      if (text.trim()) {
        if (candidate.key !== model.key) {
          llmHealth.fellBack = true
          llmHealth.servedBy = candidate.label
        }
        return text
      }
    } catch (err) {
      lastError = err
    }
  }
  throw lastError instanceof Error ? lastError : new Error('مفيش موديل متاح دلوقتي')
}

async function completeChatOnce(model: ModelInfo, messages: LLMMessage[]): Promise<string> {
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
